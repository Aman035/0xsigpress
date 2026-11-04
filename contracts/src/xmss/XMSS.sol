// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {WOTS} from "../WOTS.sol";

/// @title XMSS
/// @notice XMSS-style multi-use hash-based key: a Merkle tree over 2^height WOTS one-time keys.
///         Public key = Merkle root over the leaves leaf_i = pkHash_i (WOTS pkHash, see WOTS.sol).
///         parent = keccak256(left || right); bit l of leafIndex = 1 means the node is the right child at level l.
///         Signature = (leafIndex, leafPk, wotsSig 2,144 B, authPath height x 32 B).
///         leafPk (the WOTS pkHash of leaf leafIndex) is carried in the signature (+32 B) so WOTS.verify is
///         reused unchanged, and so the same (leafPk, m, sig) triple can be a leaf of an OptimisticAggregator batch.
///         Stateful: each leaf must sign at most one message. Tracking that is the signer's job (and the
///         account's used-leaf bitmap on chain); this library only checks the maths.
library XMSS {
    uint256 internal constant MAX_HEIGHT = 32;

    /// @notice Root of the tree implied by `leaf` at `leafIndex` with sibling path `authPath` (bottom-up).
    function rootOf(bytes32 leaf, uint256 leafIndex, bytes32[] calldata authPath) internal pure returns (bytes32 h) {
        assembly ("memory-safe") {
            h := leaf
            let idx := leafIndex
            let p := authPath.offset
            let end := add(p, mul(authPath.length, 32))
            for {} lt(p, end) { p := add(p, 32) } {
                let sib := calldataload(p)
                switch and(idx, 1)
                case 0 {
                    mstore(0x00, h)
                    mstore(0x20, sib)
                }
                default {
                    mstore(0x00, sib)
                    mstore(0x20, h)
                }
                h := keccak256(0x00, 0x40)
                idx := shr(1, idx)
            }
        }
    }

    /// @notice True iff (leafIndex, leafPk, wotsSig, authPath) is a valid signature of `m` under `root`
    ///         for a tree of the given height.
    function verify(
        bytes32 root,
        uint256 height,
        bytes32 m,
        uint256 leafIndex,
        bytes32 leafPk,
        bytes calldata wotsSig,
        bytes32[] calldata authPath
    ) internal pure returns (bool) {
        if (height == 0 || height > MAX_HEIGHT) return false;
        if (authPath.length != height || (leafIndex >> height) != 0) return false;
        // Merkle path first: 10 hashes at h = 10, much cheaper than the ~1,000 hashes of WOTS.
        if (rootOf(leafPk, leafIndex, authPath) != root) return false;
        return WOTS.verify(leafPk, m, wotsSig);
    }
}
