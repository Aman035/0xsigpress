// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OptimisticAggregator} from "../src/OptimisticAggregator.sol";
import {SigpressEntry} from "../src/SigpressEntry.sol";
import {SigpressAccount} from "../src/SigpressAccount.sol";
import {WOTSHelper} from "./WOTSHelper.sol";

contract Burner {
    function boom() external pure {
        revert("nope");
    }
}

contract Reenterer {
    SigpressEntry public entry;
    bytes public payload;
    bool public reentered;
    bytes public reason;

    function set(SigpressEntry e, bytes calldata p) external {
        entry = e;
        payload = p;
    }

    fallback() external payable {
        (bool ok, bytes memory ret) = address(entry).call(payload);
        reentered = ok;
        reason = ret;
    }
}

contract SigpressEntryTest is Test {
    OptimisticAggregator agg;
    SigpressEntry entry;

    uint256 constant BOND = 0.01 ether;
    uint256 constant WINDOW = 120;
    uint256 constant AMOUNT = 0.0001 ether;
    address aggregator = address(0xA66);
    address challenger = address(0xC4A1);
    address recipient = address(0xBEEF);

    struct Op {
        uint32 index;
        address target;
        uint256 value;
        bytes data;
        bytes32 pk;
        bytes32 next;
        bytes32 m;
        bytes sig;
        bytes32 sigHash;
        bytes32 leaf;
    }

    bytes32[] seeds;
    uint256[] keyIndex; // off-chain view of each account's key index (= nonce)

    function setUp() public {
        agg = new OptimisticAggregator(BOND, WINDOW, 0.001 ether, 60);
        entry = new SigpressEntry(agg);
        vm.deal(aggregator, 10 ether);
        vm.deal(address(this), 10 ether);
    }

    // ---------- helpers ----------

    function _createAccounts(uint256 k) internal {
        bytes32[] memory pks = new bytes32[](k);
        for (uint256 i = 0; i < k; i++) {
            bytes32 s = keccak256(abi.encode("sigpress-entry", seeds.length));
            seeds.push(s);
            keyIndex.push(0);
            pks[i] = WOTSHelper.pkHash(s, 0);
        }
        entry.createAccounts{value: k * 0.01 ether}(pks);
    }

    function _sign(uint32 index, address target, uint256 value, bytes memory data) internal returns (Op memory op) {
        bytes32 seed = seeds[index];
        uint256 k = keyIndex[index];
        keyIndex[index] = k + 1;
        address acct = entry.accountOf(index);
        op.index = index;
        op.target = target;
        op.value = value;
        op.data = data;
        op.pk = WOTSHelper.pkHash(seed, uint32(k));
        op.next = WOTSHelper.pkHash(seed, uint32(k + 1));
        bytes32 ph = keccak256(abi.encode(acct, k, target, value, keccak256(data)));
        op.m = agg.messageOf(block.chainid, address(entry), op.pk, op.next, ph);
        op.sig = WOTSHelper.sign(seed, uint32(k), op.m);
        op.sigHash = keccak256(op.sig);
        op.leaf = keccak256(abi.encodePacked(op.pk, op.m, op.sigHash));
    }

    /// nOps transfers of AMOUNT to recipient, round-robin over the first nAccts accounts.
    function _ops(uint256 nOps, uint256 nAccts) internal returns (Op[] memory ops) {
        ops = new Op[](nOps);
        for (uint256 j = 0; j < nOps; j++) {
            ops[j] = _sign(uint32(j % nAccts), recipient, AMOUNT, "");
        }
    }

    function _root(Op[] memory ops) internal pure returns (bytes32) {
        uint256 size = 1;
        while (size < ops.length) size <<= 1;
        bytes32[] memory nodes = new bytes32[](size);
        for (uint256 i = 0; i < ops.length; i++) {
            nodes[i] = ops[i].leaf;
        }
        for (uint256 n = size; n > 1; n >>= 1) {
            for (uint256 i = 0; i < n; i += 2) {
                nodes[i / 2] = keccak256(abi.encodePacked(nodes[i], nodes[i + 1]));
            }
        }
        return nodes[0];
    }

    function _proof(Op[] memory ops, uint256 idx) internal pure returns (bytes32[] memory proof) {
        uint256 size = 1;
        uint256 depth;
        while (size < ops.length) (size, depth) = (size << 1, depth + 1);
        bytes32[] memory nodes = new bytes32[](size);
        for (uint256 i = 0; i < ops.length; i++) {
            nodes[i] = ops[i].leaf;
        }
        proof = new bytes32[](depth);
        uint256 at = idx;
        for (uint256 lvl = 0; lvl < depth; lvl++) {
            proof[lvl] = nodes[at ^ 1];
            uint256 n = size >> lvl;
            for (uint256 i = 0; i < n; i += 2) {
                nodes[i / 2] = keccak256(abi.encodePacked(nodes[i], nodes[i + 1]));
            }
            at >>= 1;
        }
    }

    function _compactValue(uint256 v) internal pure returns (bytes memory out) {
        uint256 len;
        for (uint256 t = v; t > 0; t >>= 8) {
            len++;
        }
        out = new bytes(1 + len);
        out[0] = bytes1(uint8(len));
        for (uint256 i = 0; i < len; i++) {
            out[1 + i] = bytes1(uint8(v >> (8 * (len - 1 - i))));
        }
    }

    function _encodeOp(Op memory op) internal pure returns (bytes memory) {
        return abi.encodePacked(
            op.index, op.target, _compactValue(op.value), uint16(op.data.length), op.data, op.next, op.sigHash
        );
    }

    function _bundle(uint256 id, Op[] memory ops) internal pure returns (bytes memory b) {
        b = abi.encodePacked(SigpressEntry.executeBundle.selector, uint32(id));
        for (uint256 i = 0; i < ops.length; i++) {
            b = bytes.concat(b, _encodeOp(ops[i]));
        }
    }

    function _submit(Op[] memory ops) internal returns (uint256 id) {
        vm.prank(aggregator);
        id = agg.submitBatch{value: BOND}(_root(ops), uint32(ops.length), "sigpress-da:test");
    }

    function _submitFinal(Op[] memory ops) internal returns (uint256 id) {
        id = _submit(ops);
        vm.warp(block.timestamp + WINDOW);
        agg.finalize(id);
    }

    function _exec(bytes memory callData) internal returns (bool ok, bytes memory ret) {
        (ok, ret) = address(entry).call(callData);
    }

    function _expectExecRevert(bytes memory callData, bytes memory err) internal {
        (bool ok, bytes memory ret) = _exec(callData);
        assertFalse(ok, "bundle should revert");
        assertEq(ret, err);
    }

    function _happy(uint256 nOps, uint256 nAccts) internal {
        _createAccounts(nAccts);
        Op[] memory ops = _ops(nOps, nAccts);
        uint256 id = _submitFinal(ops);
        bytes memory cd = _bundle(id, ops);
        uint256 before = recipient.balance;
        uint256 g = gasleft();
        (bool ok, bytes memory ret) = _exec(cd);
        g -= gasleft();
        assertTrue(ok, string(ret));
        emit log_named_uint("ops", nOps);
        emit log_named_uint("calldata bytes", cd.length);
        emit log_named_uint("calldata bytes per op x100", (cd.length * 100) / nOps);
        emit log_named_uint("gas per op (execution, local)", g / nOps);
        assertEq(recipient.balance - before, AMOUNT * nOps);
        assertTrue(entry.executed(id));
        for (uint32 i = 0; i < nAccts; i++) {
            SigpressAccount a = SigpressAccount(payable(entry.accountOf(i)));
            assertEq(a.nonce(), keyIndex[i]);
            assertEq(a.pkHash(), WOTSHelper.pkHash(seeds[i], uint32(keyIndex[i])));
        }
    }

    // ---------- happy paths ----------

    function test_happy4() public {
        _happy(4, 4);
    }

    function test_happy64() public {
        _happy(64, 64);
    }

    function test_happy64ChainedKeys() public {
        // 64 ops from 16 accounts (4 each, keys chained inside one bundle)
        _happy(64, 16);
    }

    function test_bundleSizeIs97BytesPerTransferOp() public {
        _createAccounts(1);
        Op[] memory ops = _ops(1, 1);
        // 4 index + 20 target + 1+6 value (1e14 wei = 0x5af3107a4000) + 2 dataLen + 32 next + 32 sigHash
        assertEq(_encodeOp(ops[0]).length, 97);
        assertEq(_bundle(0, ops).length, 4 + 4 + 97);
    }

    function test_dataAndZeroValue() public {
        _createAccounts(2);
        Op[] memory ops = new Op[](2);
        Burner burner = new Burner();
        ops[0] = _sign(0, address(burner), 0, abi.encodeCall(Burner.boom, ()));
        ops[1] = _sign(1, recipient, 1, "");
        uint256 id = _submitFinal(ops);
        uint256 before = recipient.balance;
        vm.expectEmit(true, true, false, true, entry.accountOf(0));
        emit SigpressAccount.Executed(0, ops[0].pk, ops[0].next, address(burner), 0, false);
        (bool ok,) = _exec(_bundle(id, ops));
        assertTrue(ok);
        // a failing call does not block the bundle; its key is still used up
        assertEq(SigpressAccount(payable(entry.accountOf(0))).pkHash(), ops[0].next);
        assertEq(recipient.balance - before, 1);
    }

    // ---------- tampering ----------

    function test_tamperedOpReverts() public {
        _createAccounts(4);
        Op[] memory ops = _ops(4, 4);
        uint256 id = _submitFinal(ops);
        bytes memory rootErr = abi.encodeWithSelector(SigpressEntry.RootMismatch.selector);

        Op[] memory t = _copy(ops);
        t[2].value = AMOUNT + 1;
        _expectExecRevert(_bundle(id, t), rootErr);

        t = _copy(ops);
        t[1].target = address(0xD00D);
        _expectExecRevert(_bundle(id, t), rootErr);

        t = _copy(ops);
        t[3].data = hex"01";
        _expectExecRevert(_bundle(id, t), rootErr);

        t = _copy(ops);
        t[0].next = keccak256("attacker key");
        _expectExecRevert(_bundle(id, t), rootErr);

        t = _copy(ops);
        t[0].sigHash = keccak256("other sig");
        _expectExecRevert(_bundle(id, t), rootErr);

        t = _copy(ops); // two ops swapped
        (t[0], t[1]) = (t[1], t[0]);
        _expectExecRevert(_bundle(id, t), rootErr);

        t = _copy(ops); // op signed for account 2 sent as account 3
        t[2].index = 3;
        _expectExecRevert(_bundle(id, t), rootErr);

        // nothing ran
        assertFalse(entry.executed(id));
        assertEq(SigpressAccount(payable(entry.accountOf(0))).nonce(), 0);
        (bool ok,) = _exec(_bundle(id, ops));
        assertTrue(ok);
    }

    function test_badLengthsRevert() public {
        _createAccounts(4);
        Op[] memory ops = _ops(4, 4);
        uint256 id = _submitFinal(ops);
        bytes memory good = _bundle(id, ops);
        _expectExecRevert(bytes.concat(good, hex"00"), abi.encodeWithSelector(SigpressEntry.BadBundle.selector));
        Op[] memory three = new Op[](3);
        for (uint256 i = 0; i < 3; i++) {
            three[i] = ops[i];
        }
        (bool ok,) = _exec(_bundle(id, three)); // truncated: count says 4
        assertFalse(ok);
        Op[] memory t = _copy(ops);
        t[0].index = 9;
        _expectExecRevert(_bundle(id, t), abi.encodeWithSelector(SigpressEntry.UnknownAccount.selector, 9));
    }

    function test_wrongEntryDomainReverts() public {
        // a leaf signed for another entry address (or PQAccount's aggregator domain) does not match
        _createAccounts(1);
        Op[] memory ops = _ops(1, 1);
        bytes32 ph = keccak256(abi.encode(entry.accountOf(0), uint256(0), recipient, AMOUNT, keccak256("")));
        ops[0].m = agg.messageOf(block.chainid, address(agg), ops[0].pk, ops[0].next, ph);
        ops[0].sig = WOTSHelper.sign(seeds[0], 0, ops[0].m);
        ops[0].sigHash = keccak256(ops[0].sig);
        ops[0].leaf = keccak256(abi.encodePacked(ops[0].pk, ops[0].m, ops[0].sigHash));
        uint256 id = _submitFinal(ops);
        _expectExecRevert(_bundle(id, ops), abi.encodeWithSelector(SigpressEntry.RootMismatch.selector));
    }

    // ---------- replay ----------

    function test_replayReverts() public {
        _createAccounts(4);
        Op[] memory ops = _ops(4, 4);
        uint256 id = _submitFinal(ops);
        bytes memory cd = _bundle(id, ops);
        (bool ok,) = _exec(cd);
        assertTrue(ok);
        _expectExecRevert(cd, abi.encodeWithSelector(SigpressEntry.AlreadyExecuted.selector));

        // the same signed ops in a fresh, finalized batch: keys have rotated, so the root no longer matches
        uint256 id2 = _submitFinal(ops);
        _expectExecRevert(_bundle(id2, ops), abi.encodeWithSelector(SigpressEntry.RootMismatch.selector));
    }

    function test_reentrancyBlocked() public {
        _createAccounts(2);
        Reenterer r = new Reenterer();
        Op[] memory other = _ops(1, 1);
        uint256 otherId = _submitFinal(other);
        r.set(entry, _bundle(otherId, other));
        Op[] memory ops = new Op[](1);
        ops[0] = _sign(1, address(r), 0, "");
        uint256 id = _submitFinal(ops);
        (bool ok,) = _exec(_bundle(id, ops));
        assertTrue(ok); // outer bundle succeeds; the nested call was rejected with Reentrancy()
        assertFalse(r.reentered());
        assertEq(r.reason(), abi.encodeWithSelector(SigpressEntry.Reentrancy.selector));
        assertFalse(entry.executed(otherId));
    }

    // ---------- batch status ----------

    function test_unfinalizedBatchReverts() public {
        _createAccounts(4);
        Op[] memory ops = _ops(4, 4);
        uint256 id = _submit(ops);
        _expectExecRevert(_bundle(id, ops), abi.encodeWithSelector(SigpressEntry.BatchNotAccepted.selector));
        vm.warp(block.timestamp + WINDOW); // window over but not finalized yet
        _expectExecRevert(_bundle(id, ops), abi.encodeWithSelector(SigpressEntry.BatchNotAccepted.selector));
        _expectExecRevert(_bundle(id + 7, ops), abi.encodeWithSelector(SigpressEntry.BatchNotAccepted.selector));
    }

    function test_slashedBatchReverts() public {
        _createAccounts(4);
        Op[] memory ops = _ops(4, 4);
        // aggregator includes a bad signature for op 2 (the leaf commits to the bad sig's hash)
        ops[2].sig[7] = bytes1(uint8(ops[2].sig[7]) ^ 0x01);
        ops[2].sigHash = keccak256(ops[2].sig);
        ops[2].leaf = keccak256(abi.encodePacked(ops[2].pk, ops[2].m, ops[2].sigHash));
        uint256 id = _submit(ops);
        vm.prank(challenger);
        agg.challenge(id, ops[2].pk, ops[2].m, ops[2].sig, 2, _proof(ops, 2));
        (,,,, bool slashed,) = agg.batches(id);
        assertTrue(slashed);
        vm.warp(block.timestamp + WINDOW);
        _expectExecRevert(_bundle(id, ops), abi.encodeWithSelector(SigpressEntry.BatchNotAccepted.selector));
    }

    // ---------- account ----------

    function test_accountOnlyEntry() public {
        _createAccounts(1);
        SigpressAccount a = SigpressAccount(payable(entry.accountOf(0)));
        vm.expectRevert(SigpressAccount.NotEntry.selector);
        a.sigpressExecute(bytes32(0), recipient, 1, "");
        vm.expectRevert(SigpressAccount.NotEntry.selector);
        a.init(bytes32(uint256(1)));
        assertEq(address(a).balance, 0.01 ether);
        assertEq(entry.accountCount(), 1);
    }

    function test_executeDirect() public {
        _createAccounts(1);
        SigpressAccount a = SigpressAccount(payable(entry.accountOf(0)));
        Op memory op = _sign(0, recipient, AMOUNT, "");
        assertEq(a.messageFor(op.next, recipient, AMOUNT, ""), op.m);
        bytes memory bad = op.sig;
        bad[0] = bytes1(uint8(bad[0]) ^ 1);
        vm.expectRevert(SigpressAccount.InvalidSignature.selector);
        a.executeDirect(op.next, recipient, AMOUNT, "", bad);
        bad[0] = bytes1(uint8(bad[0]) ^ 1);
        uint256 before = recipient.balance;
        a.executeDirect(op.next, recipient, AMOUNT, "", op.sig);
        assertEq(recipient.balance - before, AMOUNT);
        assertEq(a.pkHash(), op.next);
        vm.expectRevert(SigpressAccount.InvalidSignature.selector);
        a.executeDirect(op.next, recipient, AMOUNT, "", op.sig); // replay
    }

    function _copy(Op[] memory ops) internal pure returns (Op[] memory t) {
        t = new Op[](ops.length);
        for (uint256 i = 0; i < ops.length; i++) {
            Op memory o = ops[i];
            t[i] = Op(o.index, o.target, o.value, bytes.concat(o.data), o.pk, o.next, o.m, o.sig, o.sigHash, o.leaf);
        }
    }
}
