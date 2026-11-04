// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OptimisticAggregator} from "../../src/OptimisticAggregator.sol";
import {SigpressEntry} from "../../src/SigpressEntry.sol";
import {SigpressAccount} from "../../src/SigpressAccount.sol";
import {WOTSHelper} from "../WOTSHelper.sol";

/// @dev Every op calls hit(opId); counts runs per op and per account.
contract Recorder {
    mapping(bytes32 => uint256) public hits;
    mapping(address => uint256) public hitsBy;

    function hit(bytes32 opId) external {
        hits[opId]++;
        hitsBy[msg.sender]++;
    }
}

/// @dev Drives SigpressEntry: sign a batch over a random subset of accounts (at most one pending batch), run
///      some of its ops directly first (front-running the bundle), execute the bundle (dead ops sent as
///      dead-op records), and replay executed bundles.
contract EntryHandler is Test {
    uint256 constant N = 4;
    OptimisticAggregator public agg;
    SigpressEntry public entry;
    Recorder public rec;
    bytes32[N] seeds;

    struct Op {
        uint32 index;
        uint256 nonce;
        bytes32 pk;
        bytes32 next;
        bytes data;
        bytes sig;
        bytes32 sigHash;
    }

    Op[] pending;
    bool public hasPending;
    uint256 pendingId;
    bytes[] executedBundles;
    bytes32[] public opIds;
    uint256[N] lastNonce;

    uint256 public bundles;
    uint256 public directs;
    uint256 public skips;
    bool public nonceWentBack;
    bool public nonceSkipped; // an action moved a nonce by more than the ops it ran
    bool public bundleFailed; // a finalized batch could not be executed
    bool public replaySucceeded;

    constructor(OptimisticAggregator agg_, SigpressEntry entry_) {
        agg = agg_;
        entry = entry_;
        rec = new Recorder();
        bytes32[] memory pks = new bytes32[](N);
        for (uint256 i = 0; i < N; i++) {
            seeds[i] = keccak256(abi.encode("invariant-entry", i));
            pks[i] = WOTSHelper.pkHash(seeds[i], 0);
        }
        entry.createAccounts(pks);
        vm.deal(address(this), 1_000 ether);
    }

    receive() external payable {}

    function opCount() external view returns (uint256) {
        return opIds.length;
    }

    function account(uint256 i) public view returns (SigpressAccount) {
        return SigpressAccount(payable(entry.accountOf(i)));
    }

    function newBatch(uint8 mask, bytes32 salt) external {
        if (hasPending) return;
        mask = uint8(bound(mask, 1, (1 << N) - 1));
        delete pending;
        bytes32[] memory leaves = new bytes32[](N);
        uint256 k;
        for (uint32 i = 0; i < N; i++) {
            if ((mask >> i) & 1 == 0) continue;
            SigpressAccount a = account(i);
            Op memory op;
            op.index = i;
            op.nonce = a.nonce();
            op.pk = a.pkHash();
            op.next = WOTSHelper.pkHash(seeds[i], uint32(op.nonce + 1));
            bytes32 opId = keccak256(abi.encode(i, op.nonce, salt));
            opIds.push(opId);
            op.data = abi.encodeCall(Recorder.hit, (opId));
            op.sig = WOTSHelper.sign(seeds[i], uint32(op.nonce), a.messageFor(op.next, address(rec), 0, op.data));
            op.sigHash = keccak256(op.sig);
            bytes32 ph = keccak256(abi.encode(address(a), op.nonce, address(rec), uint256(0), keccak256(op.data)));
            bytes32 m = keccak256(abi.encode(block.chainid, address(entry), op.pk, op.next, ph));
            leaves[k++] = keccak256(abi.encodePacked(op.pk, m, op.sigHash));
            pending.push(op);
        }
        assembly {
            mstore(leaves, k)
        }
        pendingId = agg.submitBatch{value: agg.bond()}(_root(leaves), uint32(k), "inv");
        vm.warp(block.timestamp + agg.window());
        agg.finalize(pendingId);
        hasPending = true;
    }

    /// Front-run: run pending op `k` through executeDirect with its (public) signature.
    function direct(uint256 k) external {
        if (!hasPending) return;
        Op memory op = pending[k % pending.length];
        SigpressAccount a = account(op.index);
        try a.executeDirect(op.next, address(rec), 0, op.data, op.sig) {
            directs++;
        } catch {}
        _checkNonces();
    }

    function execute() external {
        if (!hasPending) return;
        bytes memory b = abi.encodePacked(SigpressEntry.executeBundle.selector, uint32(pendingId));
        for (uint256 j = 0; j < pending.length; j++) {
            Op memory op = pending[j];
            SigpressAccount a = account(op.index);
            bool dead = a.nonce() != op.nonce || a.pkHash() != op.pk;
            if (dead) skips++;
            b = bytes.concat(b, dead ? _dead(op) : _live(op));
        }
        (bool ok,) = address(entry).call(b);
        if (!ok) {
            bundleFailed = true;
        } else {
            executedBundles.push(b);
            bundles++;
        }
        hasPending = false;
        _checkNonces();
    }

    function replay(uint256 k) external {
        if (executedBundles.length == 0) return;
        (bool ok,) = address(entry).call(executedBundles[k % executedBundles.length]);
        if (ok) replaySucceeded = true;
        _checkNonces();
    }

    function _live(Op memory op) internal view returns (bytes memory) {
        return abi.encodePacked(
            op.index, address(rec), uint8(0), uint16(op.data.length), op.data, op.next, op.sigHash
        );
    }

    function _dead(Op memory op) internal view returns (bytes memory) {
        return abi.encodePacked(
            op.index | uint32(0x80000000),
            op.nonce,
            op.pk,
            address(rec),
            uint256(0),
            keccak256(op.data),
            op.next,
            op.sigHash
        );
    }

    function _checkNonces() internal {
        for (uint256 i = 0; i < N; i++) {
            uint256 n = account(i).nonce();
            if (n < lastNonce[i]) nonceWentBack = true;
            if (n > lastNonce[i] + 1) nonceSkipped = true; // every action runs at most one op per account
            lastNonce[i] = n;
        }
    }

    function _root(bytes32[] memory leaves) internal pure returns (bytes32) {
        uint256 size = 1;
        while (size < leaves.length) size <<= 1;
        bytes32[] memory nodes = new bytes32[](size);
        for (uint256 i = 0; i < leaves.length; i++) {
            nodes[i] = leaves[i];
        }
        for (uint256 n = size; n > 1; n >>= 1) {
            for (uint256 i = 0; i < n; i += 2) {
                nodes[i / 2] = keccak256(abi.encodePacked(nodes[i], nodes[i + 1]));
            }
        }
        return nodes[0];
    }
}

contract SigpressEntryInvariantTest is Test {
    OptimisticAggregator agg;
    SigpressEntry entry;
    EntryHandler h;

    function setUp() public {
        agg = new OptimisticAggregator(0.01 ether, 120);
        entry = new SigpressEntry(agg);
        h = new EntryHandler(agg, entry);
        bytes4[] memory sels = new bytes4[](4);
        sels[0] = EntryHandler.newBatch.selector;
        sels[1] = EntryHandler.direct.selector;
        sels[2] = EntryHandler.execute.selector;
        sels[3] = EntryHandler.replay.selector;
        targetSelector(FuzzSelector(address(h), sels));
        targetContract(address(h));
    }

    function afterInvariant() public {
        emit log_named_uint("ops signed", h.opCount());
        emit log_named_uint("bundles executed", h.bundles());
        emit log_named_uint("direct runs", h.directs());
        emit log_named_uint("dead ops skipped", h.skips());
    }

    /// No op executes twice: every op's call ran at most once, whatever mix of bundle, direct and replay.
    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 40
    function invariant_noOpRunsTwice() public view {
        uint256 n = h.opCount();
        for (uint256 i = 0; i < n; i++) {
            assertLe(h.rec().hits(h.opIds(i)), 1);
        }
        assertFalse(h.replaySucceeded());
    }

    /// Nonces only go up, one per op run, and each account's nonce equals the ops it has run.
    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 40
    function invariant_nonceStrictlyIncreases() public view {
        assertFalse(h.nonceWentBack());
        assertFalse(h.nonceSkipped());
        for (uint256 i = 0; i < 4; i++) {
            SigpressAccount a = h.account(i);
            assertEq(a.nonce(), h.rec().hitsBy(address(a)));
        }
    }

    /// Liveness: a finalized batch always executes (dead ops are skipped, live ops run).
    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 40
    function invariant_finalizedBatchAlwaysExecutes() public view {
        assertFalse(h.bundleFailed());
    }
}
