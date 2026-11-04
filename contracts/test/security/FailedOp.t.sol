// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OptimisticAggregator} from "../../src/OptimisticAggregator.sol";
import {PQAccount} from "../../src/PQAccount.sol";
import {XMSSAccount} from "../../src/xmss/XMSSAccount.sol";
import {WOTSHelper} from "../WOTSHelper.sol";
import {XMSSHelper} from "../xmss/XMSSHelper.sol";
import {Gate} from "./Residual.t.sol";
import {Heavy} from "./EntryGas.t.sol";

/// @notice SR-R3: a failed target call must use the op up (key rotated / leaf used, nonce bumped) and log
///         ExecutionFailed with the revert data, so a published signature cannot be replayed later. A call that
///         fails because the caller under-funded it (looks like out-of-gas) still reverts (SR-04 guard).
contract FailedOpTest is Test {
    OptimisticAggregator agg;
    bytes32 seed = keccak256("failed-op");
    address thief = address(0x7E1F);

    function setUp() public {
        agg = new OptimisticAggregator(0.01 ether, 120);
    }

    // ---- PQAccount ----

    function test_pqDirectFailedCallUsesOpUp() public {
        PQAccount acct = new PQAccount(agg, WOTSHelper.pkHash(seed, 0));
        Gate gate = new Gate();
        bytes32 next = WOTSHelper.pkHash(seed, 1);
        bytes memory sig = WOTSHelper.sign(seed, 0, acct.messageFor(next, address(gate), 0, hex"01"));
        vm.expectEmit(true, true, false, true, address(acct));
        emit PQAccount.ExecutionFailed(0, WOTSHelper.pkHash(seed, 0), address(gate), abi.encodeWithSignature("Error(string)", "closed"));
        acct.executeDirect(next, address(gate), 0, hex"01", sig);
        assertEq(acct.nonce(), 1);
        assertEq(acct.pkHash(), next);
        gate.setOpen();
        vm.prank(thief);
        vm.expectRevert(PQAccount.InvalidSignature.selector);
        acct.executeDirect(next, address(gate), 0, hex"01", sig);
    }

    function test_pqBatchFailedCallUsesOpUp() public {
        bytes32 pk = WOTSHelper.pkHash(seed, 2);
        PQAccount acct = new PQAccount(agg, pk);
        Gate gate = new Gate();
        bytes32 next = WOTSHelper.pkHash(seed, 3);
        bytes32 m = acct.messageFor(next, address(gate), 0, hex"01");
        bytes memory sig = WOTSHelper.sign(seed, 2, m);
        bytes32 sigHash = keccak256(sig);
        uint256 id = agg.submitBatch{value: 0.01 ether}(agg.leafOf(pk, m, sig), 1, "");
        vm.warp(block.timestamp + 120);
        agg.finalize(id);
        acct.executeFromBatch(id, next, address(gate), 0, hex"01", 0, new bytes32[](0), sigHash);
        assertEq(acct.nonce(), 1);
        gate.setOpen();
        vm.expectRevert(PQAccount.NotAccepted.selector);
        acct.executeFromBatch(id, next, address(gate), 0, hex"01", 0, new bytes32[](0), sigHash);
    }

    /// SR-04 guard kept: an under-funded caller cannot burn the op; with enough gas it runs.
    function test_pqUnderfundedDirectReverts() public {
        PQAccount acct = new PQAccount(agg, WOTSHelper.pkHash(seed, 4));
        Heavy heavy = new Heavy();
        bytes memory data = abi.encodeCall(Heavy.work, (40));
        bytes32 next = WOTSHelper.pkHash(seed, 5);
        bytes memory sig = WOTSHelper.sign(seed, 4, acct.messageFor(next, address(heavy), 0, data));
        bytes memory cd = abi.encodeCall(PQAccount.executeDirect, (next, address(heavy), 0, data, sig));
        uint256 g = _minGasThatSucceeds(address(acct), cd);
        (bool ok,) = address(acct).call{gas: g}(cd);
        assertTrue(ok);
        assertTrue(heavy.done(), "op burned by an underfunded executeDirect");
    }

    // ---- XMSSAccount ----

    function test_xmssFailedCallUsesLeafUp() public {
        bytes32[] memory leaves = XMSSHelper.realLeaves(seed, 2);
        XMSSAccount acct = new XMSSAccount(agg, XMSSHelper.root(leaves), 2);
        Gate gate = new Gate();
        bytes32 m = acct.messageFor(1, address(gate), 0, hex"01");
        bytes memory sig = XMSSHelper.signWots(seed, 1, m);
        bytes32[] memory path = XMSSHelper.authPath(leaves, 1);
        vm.expectEmit(true, true, false, true, address(acct));
        emit XMSSAccount.ExecutionFailed(0, 1, address(gate), abi.encodeWithSignature("Error(string)", "closed"));
        acct.executeDirect(1, leaves[1], address(gate), 0, hex"01", sig, path);
        assertEq(acct.nonce(), 1);
        assertTrue(acct.isUsed(1));
        gate.setOpen();
        vm.expectRevert(abi.encodeWithSelector(XMSSAccount.LeafUsed.selector, 1));
        acct.executeDirect(1, leaves[1], address(gate), 0, hex"01", sig, path);
    }

    function test_xmssUnderfundedDirectReverts() public {
        bytes32[] memory leaves = XMSSHelper.realLeaves(seed, 2);
        XMSSAccount acct = new XMSSAccount(agg, XMSSHelper.root(leaves), 2);
        Heavy heavy = new Heavy();
        bytes memory data = abi.encodeCall(Heavy.work, (40));
        bytes memory sig = XMSSHelper.signWots(seed, 0, acct.messageFor(0, address(heavy), 0, data));
        bytes memory cd = abi.encodeCall(
            XMSSAccount.executeDirect, (0, leaves[0], address(heavy), 0, data, sig, XMSSHelper.authPath(leaves, 0))
        );
        uint256 g = _minGasThatSucceeds(address(acct), cd);
        (bool ok,) = address(acct).call{gas: g}(cd);
        assertTrue(ok);
        assertTrue(heavy.done(), "leaf burned by an underfunded executeDirect");
    }

    function _minGasThatSucceeds(address to, bytes memory cd) internal returns (uint256) {
        uint256 lo = 21_000;
        uint256 hi = 25_000_000;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            uint256 snap = vm.snapshotState();
            (bool ok,) = to.call{gas: mid}(cd);
            vm.revertToState(snap);
            if (ok) hi = mid;
            else lo = mid + 1;
        }
        return lo;
    }
}
