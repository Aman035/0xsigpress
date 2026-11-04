// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OptimisticAggregator} from "../../src/OptimisticAggregator.sol";
import {PQAccount} from "../../src/PQAccount.sol";
import {WOTSHelper} from "../WOTSHelper.sol";

contract Gate {
    bool public open;

    function setOpen() external {
        open = true;
    }

    fallback() external payable {
        require(open, "closed");
    }
}

/// @notice The former residual risks SR-R1..R3 (design-level), each now flipped to assert the fixed behaviour.
///         See docs/security-review.md and RevealGame.t.sol / FailedOp.t.sol for the detailed tests.
contract ResidualTest is Test {
    OptimisticAggregator agg;
    uint256 constant BOND = 0.01 ether;
    uint256 constant WINDOW = 120;
    uint256 constant DEPOSIT = 0.001 ether;
    uint256 constant REVEAL_WINDOW = 30;
    address aggregator = address(0xA66);
    address thief = address(0x7E1F);
    bytes32 seed = keccak256("residual");

    function setUp() public {
        agg = new OptimisticAggregator(BOND, WINDOW, DEPOSIT, REVEAL_WINDOW);
        vm.deal(aggregator, 1 ether);
    }

    /// SR-R1 (fixed): an aggregator commits a leaf for an op nobody signed, with a sigHash that has no known
    /// preimage, and withholds the data. A watcher demands the signature with requestReveal; it cannot be
    /// produced, so finalize is blocked, the batch is slashed once the reveal deadline passes, and the forged op
    /// never runs.
    function test_fixed_withheldDataIsSlashed() public {
        bytes32 pk = WOTSHelper.pkHash(seed, 0);
        PQAccount acct = new PQAccount(agg, pk);
        vm.deal(address(acct), 1 ether);
        bytes32 next = keccak256("thief key");
        bytes32 m = acct.messageFor(next, thief, 1 ether, "");
        bytes32 fakeSigHash = keccak256("no signature has this hash");
        bytes32 leaf = keccak256(abi.encodePacked(pk, m, fakeSigHash));
        vm.prank(aggregator);
        uint256 id = agg.submitBatch{value: BOND}(leaf, 1, "withheld");
        address watcher = address(0x3A7C);
        vm.deal(watcher, 1 ether);
        vm.prank(watcher);
        agg.requestReveal{value: DEPOSIT}(id, 0);
        vm.warp(block.timestamp + WINDOW);
        vm.expectRevert(OptimisticAggregator.RevealPending.selector);
        agg.finalize(id);
        agg.slashUnrevealed(id, 0);
        assertEq(watcher.balance, 1 ether + BOND / 2);
        vm.expectRevert(PQAccount.NotAccepted.selector);
        acct.executeFromBatch(id, next, thief, 1 ether, "", 0, new bytes32[](0), fakeSigHash);
        assertEq(thief.balance, 0);
    }

    /// SR-R2 (fixed): a slash pays half the bond to the challenger and burns the rest, so an aggregator that
    /// front-runs the honest challenger with its own challenge still loses half its bond.
    function test_fixed_selfChallengeLosesHalfBond() public {
        bytes32 pk = WOTSHelper.pkHash(seed, 1);
        bytes32 m = keccak256("op");
        bytes memory badSig = new bytes(2144);
        bytes32 leaf = agg.leafOf(pk, m, badSig);
        uint256 before = aggregator.balance;
        uint256 burnBefore = agg.BURN().balance;
        vm.prank(aggregator);
        uint256 id = agg.submitBatch{value: BOND}(leaf, 1, "");
        vm.prank(aggregator);
        agg.challenge(id, pk, m, badSig, 0, new bytes32[](0));
        assertEq(before - aggregator.balance, BOND - BOND / 2, "self-challenge must cost half the bond");
        assertEq(agg.BURN().balance - burnBefore, BOND - BOND / 2);
    }

    /// SR-R3 (fixed): a failing call no longer reverts the op. The key rotates and the nonce moves (logged as
    /// ExecutionFailed), so nobody can replay the published signature later when the call would succeed.
    function test_fixed_failedPQAccountOpIsUsedUp() public {
        bytes32 pk = WOTSHelper.pkHash(seed, 2);
        PQAccount acct = new PQAccount(agg, pk);
        Gate gate = new Gate();
        bytes32 next = WOTSHelper.pkHash(seed, 3);
        bytes memory sig = WOTSHelper.sign(seed, 2, acct.messageFor(next, address(gate), 0, hex"01"));
        acct.executeDirect(next, address(gate), 0, hex"01", sig);
        assertEq(acct.nonce(), 1);
        assertEq(acct.pkHash(), next);
        gate.setOpen();
        vm.prank(thief); // much later, someone else tries to replay the published signature
        vm.expectRevert(PQAccount.InvalidSignature.selector);
        acct.executeDirect(next, address(gate), 0, hex"01", sig);
    }
}
