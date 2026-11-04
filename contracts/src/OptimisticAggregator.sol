// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {WOTS} from "./WOTS.sol";

/// @title OptimisticAggregator
/// @notice An aggregator posts a Merkle root over many (pkHash, m, keccak256(sig)) leaves with a bond.
///         Anyone can challenge a leaf during the window by revealing its signature; if the WOTS
///         signature is invalid the batch is slashed and the bond goes to the challenger.
contract OptimisticAggregator {
    error WrongBond();
    error UnknownBatch();
    error WindowClosed();
    error WindowOpen();
    error AlreadySlashed();
    error AlreadyFinalized();
    error NotInBatch();
    error SignatureValid();
    error TransferFailed();

    event BatchSubmitted(uint256 indexed id, address indexed aggregator, bytes32 root, uint32 count, string dataURI);
    event BatchSlashed(uint256 indexed id, address indexed challenger, uint256 index);
    event BatchFinalized(uint256 indexed id);

    struct Batch {
        bytes32 root;
        address aggregator;
        uint64 deadline;
        uint32 count;
        bool slashed;
        bool finalized;
    }

    uint256 public immutable bond;
    uint256 public immutable window;
    uint256 public batchCount;
    mapping(uint256 => Batch) public batches;

    constructor(uint256 bond_, uint256 window_) {
        bond = bond_;
        window = window_;
    }

    function submitBatch(bytes32 root, uint32 count, string calldata dataURI) external payable returns (uint256 id) {
        if (msg.value != bond) revert WrongBond();
        id = batchCount++;
        batches[id] = Batch({
            root: root,
            aggregator: msg.sender,
            deadline: uint64(block.timestamp + window),
            count: count,
            slashed: false,
            finalized: false
        });
        emit BatchSubmitted(id, msg.sender, root, count, dataURI);
    }

    function challenge(
        uint256 id,
        bytes32 pkHash,
        bytes32 m,
        bytes calldata sig,
        uint256 index,
        bytes32[] calldata proof
    ) external {
        Batch storage b = batches[id];
        if (b.aggregator == address(0)) revert UnknownBatch();
        if (b.slashed) revert AlreadySlashed();
        if (block.timestamp >= b.deadline) revert WindowClosed();
        bytes32 leaf = leafOf(pkHash, m, sig);
        if (computeRoot(leaf, index, proof) != b.root) revert NotInBatch();
        if (WOTS.verify(pkHash, m, sig)) revert SignatureValid();

        b.slashed = true;
        emit BatchSlashed(id, msg.sender, index);
        (bool sent,) = msg.sender.call{value: bond}("");
        if (!sent) revert TransferFailed();
    }

    function finalize(uint256 id) external {
        Batch storage b = batches[id];
        if (b.aggregator == address(0)) revert UnknownBatch();
        if (b.slashed) revert AlreadySlashed();
        if (b.finalized) revert AlreadyFinalized();
        if (block.timestamp < b.deadline) revert WindowOpen();

        b.finalized = true;
        emit BatchFinalized(id);
        (bool sent,) = b.aggregator.call{value: bond}("");
        if (!sent) revert TransferFailed();
    }

    function isAccepted(uint256 id, bytes32 leaf, uint256 index, bytes32[] calldata proof)
        external
        view
        returns (bool)
    {
        Batch storage b = batches[id];
        return b.finalized && !b.slashed && computeRoot(leaf, index, proof) == b.root;
    }

    // ---- client helpers ----

    function leafOf(bytes32 pkHash, bytes32 m, bytes calldata sig) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(pkHash, m, keccak256(sig)));
    }

    function messageOf(uint256 chainId, address aggregator, bytes32 pkHash, bytes32 nextPkHash, bytes32 payloadHash)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(chainId, aggregator, pkHash, nextPkHash, payloadHash));
    }

    /// @notice Merkle root from a leaf, its index, and bottom-up siblings. Bit i of index = 1 means right child.
    function computeRoot(bytes32 leaf, uint256 index, bytes32[] calldata proof) public pure returns (bytes32 node) {
        node = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            if ((index >> i) & 1 == 1) {
                node = keccak256(abi.encodePacked(proof[i], node));
            } else {
                node = keccak256(abi.encodePacked(node, proof[i]));
            }
        }
    }
}
