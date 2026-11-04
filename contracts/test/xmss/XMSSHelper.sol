// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {WOTSHelper} from "../WOTSHelper.sol";

/// @notice Test-only XMSS keygen/sign, matching aggregator/src/sdk/xmss.ts.
///         Leaf i is the WOTS key keygen(wotsSeed, i) with wotsSeed = keccak256(abi.encodePacked("sigpress.xmss.v1", seed)).
library XMSSHelper {
    function wotsSeed(bytes32 seed) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("sigpress.xmss.v1", seed));
    }

    function leafPk(bytes32 seed, uint256 i) internal pure returns (bytes32) {
        return WOTSHelper.pkHash(wotsSeed(seed), uint32(i));
    }

    function signWots(bytes32 seed, uint256 i, bytes32 m) internal pure returns (bytes memory) {
        return WOTSHelper.sign(wotsSeed(seed), uint32(i), m);
    }

    /// @notice All real leaves for a tree of height h (2^h WOTS keygens; keep h small).
    function realLeaves(bytes32 seed, uint256 h) internal pure returns (bytes32[] memory leaves) {
        leaves = new bytes32[](1 << h);
        for (uint256 i = 0; i < leaves.length; i++) leaves[i] = leafPk(seed, i);
    }

    /// @notice A tree of height h where only leaf `real` is a real WOTS key; the rest are filler hashes.
    ///         Verification cost is identical to a fully real tree; used for gas at large h.
    function sparseLeaves(bytes32 seed, uint256 h, uint256 real) internal pure returns (bytes32[] memory leaves) {
        leaves = new bytes32[](1 << h);
        for (uint256 i = 0; i < leaves.length; i++) leaves[i] = keccak256(abi.encode("filler", i));
        leaves[real] = leafPk(seed, real);
    }

    function root(bytes32[] memory leaves) internal pure returns (bytes32) {
        bytes32[] memory cur = leaves;
        while (cur.length > 1) {
            bytes32[] memory next = new bytes32[](cur.length / 2);
            for (uint256 i = 0; i < next.length; i++) next[i] = keccak256(abi.encodePacked(cur[2 * i], cur[2 * i + 1]));
            cur = next;
        }
        return cur[0];
    }

    function authPath(bytes32[] memory leaves, uint256 index) internal pure returns (bytes32[] memory path) {
        uint256 h;
        while ((1 << h) < leaves.length) h++;
        path = new bytes32[](h);
        bytes32[] memory cur = leaves;
        uint256 idx = index;
        for (uint256 l = 0; l < h; l++) {
            path[l] = cur[idx ^ 1];
            bytes32[] memory next = new bytes32[](cur.length / 2);
            for (uint256 i = 0; i < next.length; i++) next[i] = keccak256(abi.encodePacked(cur[2 * i], cur[2 * i + 1]));
            cur = next;
            idx >>= 1;
        }
    }
}
