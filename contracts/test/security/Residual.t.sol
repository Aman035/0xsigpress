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

/// @notice Residual risks that are NOT fixed (design-level). These tests pass: they pin down today's behaviour
///         so a future fix shows up as a deliberate test change. See docs/security-review.md.
contract ResidualTest is Test {
    OptimisticAggregator agg;
    uint256 constant BOND = 0.01 ether;
    uint256 constant WINDOW = 120;
    address aggregator = address(0xA66);
    address thief = address(0x7E1F);
    bytes32 seed = keccak256("residual");

    function setUp() public {
        agg = new OptimisticAggregator(BOND, WINDOW);
        vm.deal(aggregator, 1 ether);
    }

    /// SR-R1 (data availability): the chain only sees keccak256(sig). An aggregator that commits a leaf for an op
    /// nobody signed, with a sigHash that has no known preimage, and withholds the data, cannot be challenged:
    /// after the window the forged op runs. Safety of the optimistic path rests on someone holding every
    /// signature of every batch (the DA document) during the window.
    function test_residual_withheldDataForgesOp() public {
        bytes32 pk = WOTSHelper.pkHash(seed, 0);
        PQAccount acct = new PQAccount(agg, pk);
        vm.deal(address(acct), 1 ether);
        bytes32 next = keccak256("thief key");
        bytes32 m = acct.messageFor(next, thief, 1 ether, "");
        bytes32 fakeSigHash = keccak256("no signature has this hash");
        bytes32 leaf = keccak256(abi.encodePacked(pk, m, fakeSigHash));
        vm.prank(aggregator);
        uint256 id = agg.submitBatch{value: BOND}(leaf, 1, "withheld");
        vm.warp(block.timestamp + WINDOW);
        agg.finalize(id);
        acct.executeFromBatch(id, next, thief, 1 ether, "", 0, new bytes32[](0), fakeSigHash);
        assertEq(thief.balance, 1 ether);
    }

    /// SR-R2 (bond economics): anyone may challenge, including the aggregator itself. An aggregator caught
    /// with a bad batch front-runs the honest challenger with its own challenge and gets the full bond back,
    /// so a failed fraud attempt costs it only gas.
    function test_residual_selfChallengeRefundsBond() public {
        bytes32 pk = WOTSHelper.pkHash(seed, 1);
        bytes32 m = keccak256("op");
        bytes memory badSig = new bytes(2144);
        bytes32 leaf = agg.leafOf(pk, m, badSig);
        uint256 before = aggregator.balance;
        vm.prank(aggregator);
        uint256 id = agg.submitBatch{value: BOND}(leaf, 1, "");
        vm.prank(aggregator);
        agg.challenge(id, pk, m, badSig, 0, new bytes32[](0));
        assertEq(aggregator.balance, before, "aggregator lost nothing");
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
