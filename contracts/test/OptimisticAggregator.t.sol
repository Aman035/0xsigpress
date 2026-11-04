// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OptimisticAggregator} from "../src/OptimisticAggregator.sol";
import {WOTSHelper} from "./WOTSHelper.sol";

contract OptimisticAggregatorTest is Test {
    OptimisticAggregator agg;
    bytes32 seed = keccak256("sigpress-test");
    uint256 constant BOND = 0.01 ether;
    uint256 constant WINDOW = 120;

    address aggregator = address(0xA66);
    address challenger = address(0xC4A1);

    bytes32[4] pks;
    bytes32[4] ms;
    bytes[4] sigs;
    bytes32[4] leaves;
    bytes32 root;

    function setUp() public {
        agg = new OptimisticAggregator(BOND, WINDOW);
        vm.deal(aggregator, 1 ether);
        for (uint32 i = 0; i < 4; i++) {
            pks[i] = WOTSHelper.pkHash(seed, i);
            ms[i] = agg.messageOf(block.chainid, address(agg), pks[i], WOTSHelper.pkHash(seed, i + 100), keccak256(abi.encode("op", i)));
            sigs[i] = WOTSHelper.sign(seed, i, ms[i]);
        }
        // leaf 2 carries a bad signature
        sigs[2][5] = bytes1(uint8(sigs[2][5]) ^ 0x01);
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

    function test_leafFormat() public view {
        assertEq(leaves[0], keccak256(abi.encodePacked(pks[0], ms[0], keccak256(sigs[0]))));
    }

    function test_submitRequiresBond() public {
        vm.prank(aggregator);
        vm.expectRevert(OptimisticAggregator.WrongBond.selector);
        agg.submitBatch{value: BOND - 1}(root, 4, "");
    }

    function test_submitEmits() public {
        vm.expectEmit(true, true, false, true);
        emit OptimisticAggregator.BatchSubmitted(0, aggregator, root, 4, "ipfs://batch");
        uint256 id = _submit();
        assertEq(id, 0);
        assertEq(address(agg).balance, BOND);
    }

    function test_challengeBadSigSlashes() public {
        uint256 id = _submit();
        uint256 before = challenger.balance;
        vm.expectEmit(true, true, false, true);
        emit OptimisticAggregator.BatchSlashed(id, challenger, 2);
        vm.prank(challenger);
        agg.challenge(id, pks[2], ms[2], sigs[2], 2, _proof(2));
        assertEq(challenger.balance, before + BOND);
        (,,,, bool slashed,) = agg.batches(id);
        assertTrue(slashed);
        // cannot finalize or re-challenge a slashed batch
        vm.warp(block.timestamp + WINDOW);
        vm.expectRevert(OptimisticAggregator.AlreadySlashed.selector);
        agg.finalize(id);
        assertFalse(agg.isAccepted(id, leaves[0], 0, _proof(0)));
    }

    function test_challengeGoodSigReverts() public {
        uint256 id = _submit();
        vm.prank(challenger);
        vm.expectRevert(OptimisticAggregator.SignatureValid.selector);
        agg.challenge(id, pks[1], ms[1], sigs[1], 1, _proof(1));
    }

    function test_challengeNotInBatchReverts() public {
        uint256 id = _submit();
        vm.prank(challenger);
        vm.expectRevert(OptimisticAggregator.NotInBatch.selector);
        agg.challenge(id, pks[2], ms[2], sigs[2], 1, _proof(2));
    }

    function test_challengeAfterWindowReverts() public {
        uint256 id = _submit();
        vm.warp(block.timestamp + WINDOW);
        vm.prank(challenger);
        vm.expectRevert(OptimisticAggregator.WindowClosed.selector);
        agg.challenge(id, pks[2], ms[2], sigs[2], 2, _proof(2));
    }

    function test_finalizeBeforeWindowReverts() public {
        uint256 id = _submit();
        vm.warp(block.timestamp + WINDOW - 1);
        vm.expectRevert(OptimisticAggregator.WindowOpen.selector);
        agg.finalize(id);
    }

    function test_finalizeAfterWindowReturnsBond() public {
        uint256 id = _submit();
        uint256 before = aggregator.balance;
        vm.warp(block.timestamp + WINDOW);
        vm.expectEmit(true, false, false, false);
        emit OptimisticAggregator.BatchFinalized(id);
        agg.finalize(id);
        assertEq(aggregator.balance, before + BOND);
        vm.expectRevert(OptimisticAggregator.AlreadyFinalized.selector);
        agg.finalize(id);
    }

    function test_isAccepted() public {
        uint256 id = _submit();
        assertFalse(agg.isAccepted(id, leaves[0], 0, _proof(0)));
        vm.warp(block.timestamp + WINDOW);
        agg.finalize(id);
        for (uint256 i = 0; i < 4; i++) {
            assertTrue(agg.isAccepted(id, leaves[i], i, _proof(i)));
        }
        assertFalse(agg.isAccepted(id, leaves[0], 1, _proof(0)));
        assertFalse(agg.isAccepted(id, bytes32(uint256(1)), 0, _proof(0)));
    }

    function test_unknownBatch() public {
        vm.expectRevert(OptimisticAggregator.UnknownBatch.selector);
        agg.finalize(7);
    }
}
