// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OptimisticAggregator} from "../../src/OptimisticAggregator.sol";

/// @notice SR-03: batch membership must mean "one of the `count` real leaves", not "any node of the tree".
contract MerkleMembershipTest is Test {
    receive() external payable {}

    OptimisticAggregator agg;
    bytes32[4] leaves;
    bytes32 root;
    uint256 id;

    function _h(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(a, b));
    }

    function setUp() public {
        agg = new OptimisticAggregator(0.01 ether, 120);
        // 3 real leaves, padded with one zero leaf to 4
        leaves[0] = keccak256("leaf0");
        leaves[1] = keccak256("leaf1");
        leaves[2] = keccak256("leaf2");
        leaves[3] = bytes32(0);
        root = _h(_h(leaves[0], leaves[1]), _h(leaves[2], leaves[3]));
        id = agg.submitBatch{value: 0.01 ether}(root, 3, "");
        vm.warp(block.timestamp + 120);
        agg.finalize(id);
    }

    function test_realLeafAccepted() public view {
        bytes32[] memory p = new bytes32[](2);
        p[0] = leaves[1];
        p[1] = _h(leaves[2], leaves[3]);
        assertTrue(agg.isAccepted(id, leaves[0], 0, p));
    }

    function test_zeroPaddingLeafNotAMember() public view {
        bytes32[] memory p = new bytes32[](2);
        p[0] = leaves[2];
        p[1] = _h(leaves[0], leaves[1]);
        assertFalse(agg.isAccepted(id, bytes32(0), 3, p), "zero padding leaf accepted");
    }

    function test_internalNodeNotAMember() public view {
        bytes32[] memory p = new bytes32[](1);
        p[0] = _h(leaves[2], leaves[3]);
        assertFalse(agg.isAccepted(id, _h(leaves[0], leaves[1]), 0, p), "internal node accepted as leaf");
        assertFalse(agg.isAccepted(id, root, 0, new bytes32[](0)), "root accepted as leaf");
    }

    function test_highIndexBitsNotIgnored() public view {
        bytes32[] memory p = new bytes32[](2);
        p[0] = leaves[1];
        p[1] = _h(leaves[2], leaves[3]);
        // index 4 has the same low 2 bits as index 0 but is outside the batch
        assertFalse(agg.isAccepted(id, leaves[0], 4, p), "out-of-range index accepted");
        assertFalse(agg.isAccepted(id, leaves[0], 1 << 200, p), "out-of-range index accepted");
    }
}
