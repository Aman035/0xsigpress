// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OptimisticAggregator} from "../../src/OptimisticAggregator.sol";
import {WOTSHelper} from "../WOTSHelper.sol";

/// @dev Drives OptimisticAggregator with random submit / challenge / finalize / time steps. Every batch is a
///      single leaf (root = leaf, empty proof); about half carry an invalid signature.
contract AggregatorHandler is Test {
    OptimisticAggregator public agg;
    uint256 public immutable bond;

    bytes32 goodPk;
    bytes32 goodM;
    bytes goodSig;

    struct Leaf {
        bytes32 pk;
        bytes32 m;
        bytes sig;
    }

    Leaf[] leaves; // by batch id
    mapping(uint256 => bool) public everSlashed;
    mapping(uint256 => bool) public everFinalized;
    uint256 public slashes;
    uint256 public finals;
    bool public flagFlipped; // a slashed/finalized flag was ever cleared
    bool public goodSlashed; // a batch with only valid signatures was slashed
    bool public badFinalizedAfterChallenge; // a successful challenge did not stop finalize

    constructor(OptimisticAggregator agg_) {
        agg = agg_;
        bond = agg_.bond();
        bytes32 seed = keccak256("invariant-aggregator");
        goodPk = WOTSHelper.pkHash(seed, 0);
        goodM = keccak256("good op");
        goodSig = WOTSHelper.sign(seed, 0, goodM);
        vm.deal(address(this), 1_000 ether);
    }

    receive() external payable {}

    function count() external view returns (uint256) {
        return leaves.length;
    }

    function submit(bool bad, bytes32 junk) external {
        Leaf memory l;
        if (bad) {
            l = Leaf(keccak256(abi.encode(junk, "pk")), junk, abi.encodePacked(junk));
        } else {
            l = Leaf(goodPk, goodM, goodSig);
        }
        uint256 id = agg.submitBatch{value: bond}(agg.leafOf(l.pk, l.m, l.sig), 1, "inv");
        assertEq(id, leaves.length);
        leaves.push(l);
    }

    function challenge(uint256 seed) external {
        if (leaves.length == 0) return;
        // half the time hit the newest batch, which is most likely still inside its window
        uint256 id = seed & 1 == 0 ? leaves.length - 1 : seed % leaves.length;
        Leaf memory l = leaves[id];
        try agg.challenge(id, l.pk, l.m, l.sig, 0, new bytes32[](0)) {
            slashes++;
            if (l.pk == goodPk) goodSlashed = true;
        } catch {}
        _sync(id);
    }

    function finalize(uint256 seed) external {
        if (leaves.length == 0) return;
        uint256 id = seed % leaves.length;
        bool wasSlashed = everSlashed[id];
        try agg.finalize(id) {
            finals++;
            if (wasSlashed) badFinalizedAfterChallenge = true;
        } catch {}
        _sync(id);
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 0, 2 * agg.window()));
    }

    function _sync(uint256 id) internal {
        (,,,, bool slashed, bool finalized) = agg.batches(id);
        if ((everSlashed[id] && !slashed) || (everFinalized[id] && !finalized)) flagFlipped = true;
        everSlashed[id] = slashed;
        everFinalized[id] = finalized;
    }
}

contract OptimisticAggregatorInvariantTest is Test {
    OptimisticAggregator agg;
    AggregatorHandler h;

    function setUp() public {
        agg = new OptimisticAggregator(0.01 ether, 120);
        h = new AggregatorHandler(agg);
        targetContract(address(h));
    }

    /// Coverage: each run must reach both terminal states at least once over the suite (logged, see -vv).
    function afterInvariant() public {
        emit log_named_uint("slashes", h.slashes());
        emit log_named_uint("finals", h.finals());
    }

    /// Bond conservation: the contract holds exactly one bond per batch that is neither slashed nor finalized.
    function invariant_bondConservation() public view {
        uint256 active;
        for (uint256 id = 0; id < h.count(); id++) {
            (,,,, bool slashed, bool finalized) = agg.batches(id);
            if (!slashed && !finalized) active++;
        }
        assertEq(address(agg).balance, active * agg.bond());
    }

    /// SR-R2: every slash burns bond - bond/2 (the challenger gets bond/2), so slashing never refunds a bond.
    function invariant_slashBurnsHalf() public view {
        uint256 slashed;
        for (uint256 id = 0; id < h.count(); id++) {
            (,,,, bool s,) = agg.batches(id);
            if (s) slashed++;
        }
        assertEq(agg.BURN().balance, slashed * (agg.bond() - agg.bond() / 2));
    }

    /// A batch is never both slashed and finalized (slashed never finalizes; finalized never slashes).
    function invariant_slashedXorFinalized() public view {
        for (uint256 id = 0; id < h.count(); id++) {
            (,,,, bool slashed, bool finalized) = agg.batches(id);
            assertFalse(slashed && finalized);
        }
        assertFalse(h.badFinalizedAfterChallenge());
    }

    /// Slashed and finalized are terminal, and a batch of valid signatures can never be slashed.
    function invariant_terminalAndHonestSafe() public view {
        assertFalse(h.flagFlipped());
        assertFalse(h.goodSlashed());
    }
}
