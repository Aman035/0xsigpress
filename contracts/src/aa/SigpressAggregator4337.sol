// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PackedUserOperation, IAggregator, IEntryPoint} from "./IERC4337.sol";
import {OptimisticAggregator} from "../OptimisticAggregator.sol";

interface IPQKeyHolder {
    function pkHash() external view returns (bytes32);
}

/// @title SigpressAggregator4337
/// @notice ERC-4337 (EntryPoint v0.8) aggregator for WOTS-signed PQAccount4337 operations, optimistic mode.
///         No signature is verified here. Instead every op's leaf
///             leaf = keccak256(pkHash ‖ m ‖ sigHash),
///             m    = keccak256(abi.encode(chainId, address(batches), pkHash, nextPkHash, userOpHash))
///         must sit in a finalized, unslashed OptimisticAggregator batch (anyone could have challenged a bad
///         signature during the window). Per-op `userOp.signature` = nextPkHash (32 bytes, the rotated key).
///         Aggregated signature = abi.encode(uint256 batchId, uint256[] indices, bytes32[][] proofs, bytes32[] sigHashes).
contract SigpressAggregator4337 is IAggregator {
    error BadOpSignature(uint256 opIndex);
    error LengthMismatch();
    error NotAccepted(uint256 opIndex);
    error OffchainAggregation();

    IEntryPoint public immutable entryPoint;
    OptimisticAggregator public immutable batches;

    constructor(IEntryPoint entryPoint_, OptimisticAggregator batches_) {
        entryPoint = entryPoint_;
        batches = batches_;
    }

    /// @inheritdoc IAggregator
    function validateSignatures(PackedUserOperation[] calldata userOps, bytes calldata signature) external view {
        (uint256 batchId, uint256[] memory indices, bytes32[][] memory proofs, bytes32[] memory sigHashes) =
            abi.decode(signature, (uint256, uint256[], bytes32[][], bytes32[]));
        uint256 n = userOps.length;
        if (indices.length != n || proofs.length != n || sigHashes.length != n) revert LengthMismatch();
        for (uint256 i = 0; i < n; i++) {
            PackedUserOperation calldata op = userOps[i];
            if (op.signature.length != 32) revert BadOpSignature(i);
            bytes32 pk = _currentKey(userOps, i);
            bytes32 m = messageOf(pk, bytes32(op.signature), entryPoint.getUserOpHash(op));
            bytes32 leaf = keccak256(abi.encodePacked(pk, m, sigHashes[i]));
            if (!batches.isAccepted(batchId, leaf, indices[i], proofs[i])) revert NotAccepted(i);
        }
    }

    /// @inheritdoc IAggregator
    /// @dev A single op cannot be checked without its batch; this only checks the shape and returns it unchanged.
    function validateUserOpSignature(PackedUserOperation calldata userOp) external pure returns (bytes memory) {
        if (userOp.signature.length != 32) revert BadOpSignature(0);
        return userOp.signature;
    }

    /// @inheritdoc IAggregator
    /// @dev The aggregated signature needs off-chain batch data (index, Merkle proof, sigHash), so it is built off chain.
    function aggregateSignatures(PackedUserOperation[] calldata) external pure returns (bytes memory) {
        revert OffchainAggregation();
    }

    /// @notice The message the account's current WOTS key signs for an op.
    function messageOf(bytes32 pkHash, bytes32 nextPkHash, bytes32 userOpHash) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(batches), pkHash, nextPkHash, userOpHash));
    }

    /// @dev The key that signs op i: the account's stored key, or, if an earlier op in this bundle comes from
    ///      the same sender, that op's nextPkHash (validateSignatures runs before any validateUserOp rotates keys).
    function _currentKey(PackedUserOperation[] calldata userOps, uint256 i) internal view returns (bytes32) {
        address sender = userOps[i].sender;
        for (uint256 j = i; j > 0; j--) {
            if (userOps[j - 1].sender == sender) return bytes32(userOps[j - 1].signature);
        }
        return IPQKeyHolder(sender).pkHash();
    }
}
