// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {XMSS} from "./XMSS.sol";
import {OptimisticAggregator} from "../OptimisticAggregator.sol";

/// @title XMSSAccount
/// @notice Smart account owned by one fixed XMSS root (2^height WOTS leaves). Unlike PQAccount, the key does
///         not rotate per op: each op uses a fresh leaf of the same tree, and a used-leaf bitmap rejects
///         any leaf seen before on chain.
///         Each op signs m = messageFor(leafIndex, target, value, data)
///           = keccak256(abi.encode(chainId, address(this), root, leafIndex, payloadHash)),
///         payloadHash = keccak256(abi.encode(address(this), nonce, target, value, keccak256(data))).
///         An op runs either directly (XMSS signature verified on chain) or from a finalized, unslashed
///         OptimisticAggregator batch whose leaf is keccak256(leafPk, m, keccak256(wotsSig)).
contract XMSSAccount {
    error BadHeight();
    error InvalidSignature();
    error NotAccepted();
    error LeafUsed(uint256 leafIndex);
    error InsufficientGas();

    event Executed(uint256 indexed nonce, uint256 indexed leafIndex, address target, uint256 value, bool batched);
    /// @notice The op was used up (leaf marked used, nonce bumped) but its call reverted with `reason`.
    event ExecutionFailed(uint256 indexed nonce, uint256 indexed leafIndex, address target, bytes reason);

    OptimisticAggregator public immutable aggregator;
    bytes32 public immutable root;
    uint256 public immutable height;
    uint256 public nonce;
    /// @dev bit (i & 255) of word (i >> 8) is set once leaf i has been used.
    mapping(uint256 => uint256) private usedWords;

    constructor(OptimisticAggregator aggregator_, bytes32 root_, uint256 height_) {
        if (height_ == 0 || height_ > XMSS.MAX_HEIGHT) revert BadHeight();
        aggregator = aggregator_;
        root = root_;
        height = height_;
    }

    receive() external payable {}

    /// @notice Number of signatures this key can ever make (2^height).
    function capacity() external view returns (uint256) {
        return 1 << height;
    }

    function isUsed(uint256 leafIndex) public view returns (bool) {
        return (usedWords[leafIndex >> 8] >> (leafIndex & 255)) & 1 == 1;
    }

    function payloadHashOf(address target, uint256 value, bytes calldata data) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), nonce, target, value, keccak256(data)));
    }

    /// @notice The message leaf `leafIndex` must sign for this op at the current nonce.
    function messageFor(uint256 leafIndex, address target, uint256 value, bytes calldata data)
        public
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(block.chainid, address(this), root, leafIndex, payloadHashOf(target, value, data)));
    }

    /// @notice Pure signature check against this account's root (does not look at the used-leaf bitmap).
    function verify(
        bytes32 m,
        uint256 leafIndex,
        bytes32 leafPk,
        bytes calldata wotsSig,
        bytes32[] calldata authPath
    ) external view returns (bool) {
        return XMSS.verify(root, height, m, leafIndex, leafPk, wotsSig, authPath);
    }

    /// @notice Run one op with its XMSS signature verified on chain.
    function executeDirect(
        uint256 leafIndex,
        bytes32 leafPk,
        address target,
        uint256 value,
        bytes calldata data,
        bytes calldata wotsSig,
        bytes32[] calldata authPath
    ) external returns (bytes memory) {
        bytes32 m = messageFor(leafIndex, target, value, data);
        if (!XMSS.verify(root, height, m, leafIndex, leafPk, wotsSig, authPath)) revert InvalidSignature();
        return _execute(leafIndex, target, value, data, false);
    }

    /// @notice Run an op whose WOTS signature was included in an accepted (finalized, unslashed) batch.
    ///         The account checks only that leafPk is leaf `leafIndex` of its tree; the WOTS signature itself
    ///         was open to challenge in the aggregator during the window.
    /// @param sigHash keccak256 of the WOTS signature, as committed in the batch leaf.
    function executeFromBatch(
        uint256 batchId,
        uint256 leafIndex,
        bytes32 leafPk,
        bytes32[] calldata authPath,
        address target,
        uint256 value,
        bytes calldata data,
        uint256 index,
        bytes32[] calldata proof,
        bytes32 sigHash
    ) external returns (bytes memory) {
        if (authPath.length != height || (leafIndex >> height) != 0) revert InvalidSignature();
        if (XMSS.rootOf(leafPk, leafIndex, authPath) != root) revert InvalidSignature();
        bytes32 m = messageFor(leafIndex, target, value, data);
        bytes32 leaf = keccak256(abi.encodePacked(leafPk, m, sigHash));
        if (!aggregator.isAccepted(batchId, leaf, index, proof)) revert NotAccepted();
        return _execute(leafIndex, target, value, data, true);
    }

    /// @dev Mark the leaf used, bump the nonce, run the call. A failing call does NOT revert: the op is used up
    ///      and ExecutionFailed is logged, so the published signature cannot be replayed later (SR-R3). A failure
    ///      that looks like the caller under-funded the call (at most 1/63 of the pre-call gas left) reverts
    ///      instead, so a third party cannot burn the op by picking the gas limit (SR-04).
    function _execute(uint256 leafIndex, address target, uint256 value, bytes calldata data, bool batched)
        internal
        returns (bytes memory ret)
    {
        uint256 w = leafIndex >> 8;
        uint256 bit = 1 << (leafIndex & 255);
        uint256 word = usedWords[w];
        if (word & bit != 0) revert LeafUsed(leafIndex);
        usedWords[w] = word | bit;
        uint256 n = nonce;
        nonce = n + 1;
        emit Executed(n, leafIndex, target, value, batched);
        uint256 g = gasleft();
        bool ok;
        (ok, ret) = target.call{value: value}(data);
        if (!ok) {
            if (gasleft() <= g / 63) revert InsufficientGas();
            emit ExecutionFailed(n, leafIndex, target, ret);
        }
    }
}
