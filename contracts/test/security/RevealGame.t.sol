// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OptimisticAggregator} from "../../src/OptimisticAggregator.sol";
import {WOTSHelper} from "../WOTSHelper.sol";

/// @dev A requester that refuses ETH until told otherwise.
contract StubbornRequester {
    bool public accept;

    function setAccept(bool a) external {
        accept = a;
    }

    function request(OptimisticAggregator agg, uint256 id, uint256 index) external payable {
        agg.requestReveal{value: msg.value}(id, index);
    }

    function withdraw(OptimisticAggregator agg) external {
        agg.withdraw();
    }

    receive() external payable {
        require(accept, "no");
    }
}

/// @notice SR-R1: data-availability challenge. During a batch's window anyone can pay a deposit to demand one
///         leaf's signature on chain; the aggregator (or anyone holding the data) must reveal it within
///         revealWindow or the batch is slashed. finalize waits for every open request.
contract RevealGameTest is Test {
    OptimisticAggregator agg;
    bytes32 seed = keccak256("reveal-game");
    uint256 constant BOND = 0.01 ether;
    uint256 constant WINDOW = 120;
    uint256 constant DEP = 0.001 ether;
    uint256 constant RW = 30;

    address aggregator = address(0xA66);
    address requester = address(0x4E0);
    address other = address(0x07E4);

    bytes32[4] pks;
    bytes32[4] ms;
    bytes[4] sigs;
    bytes32[4] leaves;
    bytes32 root;

    function setUp() public {
        agg = new OptimisticAggregator(BOND, WINDOW, DEP, RW);
        vm.deal(aggregator, 1 ether);
        vm.deal(requester, 1 ether);
        vm.deal(other, 1 ether);
        for (uint32 i = 0; i < 4; i++) {
            pks[i] = WOTSHelper.pkHash(seed, i);
            ms[i] = keccak256(abi.encode("op", i));
            sigs[i] = WOTSHelper.sign(seed, i, ms[i]);
        }
        sigs[2][7] = bytes1(uint8(sigs[2][7]) ^ 0x01); // leaf 2 is bad
        for (uint256 i = 0; i < 4; i++) {
            leaves[i] = agg.leafOf(pks[i], ms[i], sigs[i]);
        }
        root = _h(_h(leaves[0], leaves[1]), _h(leaves[2], leaves[3]));
    }

    function _h(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(a, b));
    }

    function _proof(uint256 i) internal view returns (bytes32[] memory p) {
        p = new bytes32[](2);
        p[0] = leaves[i ^ 1];
        p[1] = i < 2 ? _h(leaves[2], leaves[3]) : _h(leaves[0], leaves[1]);
    }

    function _submit() internal returns (uint256 id) {
        vm.prank(aggregator);
        id = agg.submitBatch{value: BOND}(root, 4, "ipfs://batch");
    }

    function _request(uint256 id, uint256 index) internal {
        vm.prank(requester);
        agg.requestReveal{value: DEP}(id, index);
    }

    function _reveal(uint256 id, uint256 i) internal {
        vm.prank(aggregator);
        agg.reveal(id, i, pks[i], ms[i], sigs[i], _proof(i));
    }

    function test_constructorParams() public {
        assertEq(agg.revealDeposit(), DEP);
        assertEq(agg.revealWindow(), RW);
        vm.expectRevert(OptimisticAggregator.BadWindow.selector);
        new OptimisticAggregator(BOND, WINDOW, DEP, 0);
        vm.expectRevert(OptimisticAggregator.BadWindow.selector);
        new OptimisticAggregator(BOND, WINDOW, DEP, uint256(type(uint64).max));
    }

    function test_validRevealRefundsDepositAndFinalizes() public {
        uint256 id = _submit();
        uint256 reqBefore = requester.balance;
        vm.expectEmit(true, true, true, true);
        emit OptimisticAggregator.RevealRequested(id, 1, requester, uint64(block.timestamp + RW));
        _request(id, 1);
        assertEq(agg.openReveals(id), 1);
        vm.expectEmit(true, true, false, true);
        emit OptimisticAggregator.Revealed(id, 1, pks[1], ms[1], sigs[1], true);
        _reveal(id, 1);
        assertEq(requester.balance, reqBefore, "deposit refunded");
        assertEq(agg.openReveals(id), 0);
        vm.warp(block.timestamp + WINDOW);
        uint256 aggBefore = aggregator.balance;
        agg.finalize(id);
        assertEq(aggregator.balance, aggBefore + BOND);
        assertTrue(agg.isAccepted(id, leaves[1], 1, _proof(1)));
    }

    function test_invalidRevealSlashesAtOnce() public {
        uint256 id = _submit();
        uint256 reqBefore = requester.balance;
        _request(id, 2);
        vm.expectEmit(true, true, false, true);
        emit OptimisticAggregator.BatchSlashed(id, requester, 2);
        _reveal(id, 2);
        (,,,, bool slashed,) = agg.batches(id);
        assertTrue(slashed);
        assertEq(requester.balance, reqBefore + BOND / 2, "half the bond (deposit back)");
        assertEq(agg.BURN().balance, BOND - BOND / 2);
        assertEq(address(agg).balance, 0);
    }

    function test_unansweredRequestSlashes() public {
        uint256 id = _submit();
        uint256 reqBefore = requester.balance;
        _request(id, 0);
        vm.warp(block.timestamp + RW - 1);
        vm.expectRevert(OptimisticAggregator.RevealWindowOpen.selector);
        agg.slashUnrevealed(id, 0);
        vm.warp(block.timestamp + 1);
        vm.expectRevert(OptimisticAggregator.RevealExpired.selector);
        _reveal(id, 0);
        vm.expectEmit(true, true, false, false);
        emit OptimisticAggregator.RevealMissed(id, 0);
        vm.prank(other); // anyone can trigger it; the payout goes to the requester
        agg.slashUnrevealed(id, 0);
        assertEq(requester.balance, reqBefore + BOND / 2);
        vm.warp(block.timestamp + WINDOW);
        vm.expectRevert(OptimisticAggregator.AlreadySlashed.selector);
        agg.finalize(id);
        vm.expectRevert(OptimisticAggregator.NoRevealRequest.selector);
        agg.slashUnrevealed(id, 0);
    }

    function test_finalizeWaitsForOpenRequestAndItsDeadline() public {
        uint256 id = _submit();
        (,, uint64 deadline,,,) = agg.batches(id);
        vm.warp(deadline - 1); // last second of the window
        _request(id, 3);
        uint256 rd = deadline - 1 + RW;
        assertEq(agg.finalizeAt(id), rd);
        vm.warp(deadline);
        vm.expectRevert(OptimisticAggregator.RevealPending.selector);
        agg.finalize(id);
        vm.warp(rd - 1);
        _reveal(id, 3); // still answerable after the challenge window closed
        vm.expectRevert(OptimisticAggregator.WindowOpen.selector);
        agg.finalize(id);
        vm.warp(rd);
        agg.finalize(id);
    }

    function test_requestChecks() public {
        uint256 id = _submit();
        vm.startPrank(requester);
        vm.expectRevert(OptimisticAggregator.WrongDeposit.selector);
        agg.requestReveal{value: DEP - 1}(id, 0);
        vm.expectRevert(OptimisticAggregator.NotInBatch.selector);
        agg.requestReveal{value: DEP}(id, 4);
        vm.expectRevert(OptimisticAggregator.UnknownBatch.selector);
        agg.requestReveal{value: DEP}(9, 0);
        agg.requestReveal{value: DEP}(id, 0);
        vm.expectRevert(OptimisticAggregator.AlreadyRequested.selector);
        agg.requestReveal{value: DEP}(id, 0);
        vm.warp(block.timestamp + WINDOW);
        vm.expectRevert(OptimisticAggregator.WindowClosed.selector);
        agg.requestReveal{value: DEP}(id, 1);
        vm.stopPrank();
    }

    function test_revealChecks() public {
        uint256 id = _submit();
        vm.expectRevert(OptimisticAggregator.NoRevealRequest.selector);
        _reveal(id, 0);
        _request(id, 0);
        // a signature with a different hash, or the wrong leaf, is not the committed one
        bytes memory other0 = WOTSHelper.sign(seed, 9, ms[0]);
        vm.expectRevert(OptimisticAggregator.NotInBatch.selector);
        agg.reveal(id, 0, pks[0], ms[0], other0, _proof(0));
        vm.expectRevert(OptimisticAggregator.NotInBatch.selector);
        agg.reveal(id, 0, pks[1], ms[1], sigs[1], _proof(1));
        // anyone holding the data may answer
        vm.prank(other);
        agg.reveal(id, 0, pks[0], ms[0], sigs[0], _proof(0));
        vm.expectRevert(OptimisticAggregator.NoRevealRequest.selector);
        _reveal(id, 0);
        // revealed once is enough: it cannot be requested again
        vm.expectRevert(OptimisticAggregator.AlreadyRequested.selector);
        _request(id, 0);
    }

    /// Another leaf is slashed by `challenge` while requests are open: their deposits come back.
    function test_depositsReclaimableAfterSlash() public {
        uint256 id = _submit();
        uint256 reqBefore = requester.balance;
        _request(id, 0);
        _request(id, 1);
        vm.expectRevert(OptimisticAggregator.NotSlashed.selector);
        agg.reclaimDeposit(id, 0);
        vm.prank(other);
        agg.challenge(id, pks[2], ms[2], sigs[2], 2, _proof(2));
        vm.expectRevert(OptimisticAggregator.AlreadySlashed.selector);
        _reveal(id, 0);
        agg.reclaimDeposit(id, 0);
        agg.reclaimDeposit(id, 1);
        assertEq(requester.balance, reqBefore);
        assertEq(agg.openReveals(id), 0);
        assertEq(address(agg).balance, 0);
        vm.expectRevert(OptimisticAggregator.NoRevealRequest.selector);
        agg.reclaimDeposit(id, 0);
    }

    /// A requester that rejects ETH must not be able to block the honest aggregator's reveal (and so lock its
    /// batch): the refund is credited for withdrawal instead.
    function test_requesterRejectingEthCannotBlockReveal() public {
        uint256 id = _submit();
        StubbornRequester s = new StubbornRequester();
        s.request{value: DEP}(agg, id, 1);
        _reveal(id, 1);
        assertEq(agg.credits(address(s)), DEP);
        assertEq(agg.totalCredits(), DEP);
        vm.warp(block.timestamp + WINDOW);
        agg.finalize(id);
        s.setAccept(true);
        s.withdraw(agg);
        assertEq(address(s).balance, DEP);
        assertEq(agg.credits(address(s)), 0);
        assertEq(address(agg).balance, 0);
    }
}
