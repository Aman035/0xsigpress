// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {WOTS} from "./WOTS.sol";
import {OptimisticAggregator} from "./OptimisticAggregator.sol";

/// @title PQAccount
/// @notice Minimal smart account owned by a one-time WOTS key. Every operation signs
///         m = messageOf(chainId, aggregator, pkHash, nextPkHash, payloadHash) and rotates the key to nextPkHash.
///         payloadHash = keccak256(abi.encode(address(this), nonce, target, value, keccak256(data))).
///         An op runs either from a finalized, unslashed aggregator batch (no on-chain signature check),
///         or directly with the WOTS signature verified on chain (single-op fallback).
contract PQAccount {
    error NotAccepted();
    error InvalidSignature();

    event Executed(
        uint256 indexed nonce,
        bytes32 indexed pkHash,
        bytes32 nextPkHash,
        address target,
        uint256 value,
        bool batched
    );

    OptimisticAggregator public immutable aggregator;
    bytes32 public pkHash;
    uint256 public nonce;

    constructor(OptimisticAggregator aggregator_, bytes32 pkHash_) {
        aggregator = aggregator_;
        pkHash = pkHash_;
    }

    receive() external payable {}

    /// @notice payloadHash for an op at the current nonce.
    function payloadHashOf(address target, uint256 value, bytes calldata data) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), nonce, target, value, keccak256(data)));
    }

    /// @notice The message the current key must sign for this op (same as aggregator.messageOf).
    function messageFor(bytes32 nextPkHash, address target, uint256 value, bytes calldata data)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(block.chainid, address(aggregator), pkHash, nextPkHash, payloadHashOf(target, value, data))
        );
    }

    /// @notice Run an op whose signature was included in an accepted (finalized, unslashed) batch.
    /// @param sigHash keccak256 of the WOTS signature, as committed in the batch leaf.
    function executeFromBatch(
        uint256 batchId,
        bytes32 nextPkHash,
        address target,
        uint256 value,
        bytes calldata data,
        uint256 index,
        bytes32[] calldata proof,
        bytes32 sigHash
    ) external returns (bytes memory) {
        bytes32 pk = pkHash;
        bytes32 m = messageFor(nextPkHash, target, value, data);
        bytes32 leaf = keccak256(abi.encodePacked(pk, m, sigHash));
        if (!aggregator.isAccepted(batchId, leaf, index, proof)) revert NotAccepted();
        return _execute(pk, nextPkHash, target, value, data, true);
    }

    /// @notice Run one op with its WOTS signature verified on chain.
    function executeDirect(bytes32 nextPkHash, address target, uint256 value, bytes calldata data, bytes calldata sig)
        external
        returns (bytes memory)
    {
        bytes32 pk = pkHash;
        if (!WOTS.verify(pk, messageFor(nextPkHash, target, value, data), sig)) revert InvalidSignature();
        return _execute(pk, nextPkHash, target, value, data, false);
    }

    function _execute(bytes32 pk, bytes32 nextPkHash, address target, uint256 value, bytes calldata data, bool batched)
        internal
        returns (bytes memory ret)
    {
        uint256 n = nonce;
        pkHash = nextPkHash;
        nonce = n + 1;
        emit Executed(n, pk, nextPkHash, target, value, batched);
        bool ok;
        (ok, ret) = target.call{value: value}(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
    }
}
