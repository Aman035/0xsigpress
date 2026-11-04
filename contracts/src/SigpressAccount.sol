// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {WOTS} from "./WOTS.sol";

/// @title SigpressAccount
/// @notice PQ smart account owned by a one-time WOTS key, driven by a SigpressEntry (compact bundles).
///         Deployed as an EIP-1167 clone by the entry; `entry` is an immutable of the implementation.
///         Every op signs m = keccak256(abi.encode(chainId, entry, pkHash, nextPkHash, payloadHash)) with
///         payloadHash = keccak256(abi.encode(address(this), nonce, target, value, keccak256(data))), and rotates
///         the key to nextPkHash. The entry checks (after the fact, in the same tx) that every op's leaf
///         keccak256(pkHash ‖ m ‖ sigHash) is in a finalized, unslashed OptimisticAggregator batch, and reverts
///         the whole bundle otherwise. `executeDirect` is the single-op fallback with the WOTS check on chain.
contract SigpressAccount {
    error NotEntry();
    error AlreadyInitialized();
    error InvalidSignature();

    event Executed(
        uint256 indexed nonce, bytes32 indexed pkHash, bytes32 nextPkHash, address target, uint256 value, bool success
    );

    address public immutable entry;
    bytes32 public pkHash;
    uint256 public nonce;

    constructor(address entry_) {
        entry = entry_;
    }

    receive() external payable {}

    /// @notice Set the first key. Called once by the entry right after it deploys the clone.
    function init(bytes32 pkHash_) external {
        if (msg.sender != entry) revert NotEntry();
        if (pkHash != bytes32(0) || pkHash_ == bytes32(0)) revert AlreadyInitialized();
        pkHash = pkHash_;
    }

    /// @notice Entry-only: rotate the key, bump the nonce, run the call. Returns the key and nonce the op was
    ///         signed under so the entry can rebuild its leaf. A failing call does not revert: the key still
    ///         rotates (the op is used up) and `success = false` is logged, so one bad op cannot block a bundle.
    function sigpressExecute(bytes32 nextPkHash, address target, uint256 value, bytes calldata data)
        external
        returns (bytes32 pk, uint256 n)
    {
        if (msg.sender != entry) revert NotEntry();
        pk = pkHash;
        n = nonce;
        pkHash = nextPkHash;
        nonce = n + 1;
        bool ok = _call(target, value, data);
        emit Executed(n, pk, nextPkHash, target, value, ok);
    }

    /// @notice Single-op fallback (no aggregator needed): the WOTS signature is verified on chain.
    function executeDirect(bytes32 nextPkHash, address target, uint256 value, bytes calldata data, bytes calldata sig)
        external
    {
        bytes32 pk = pkHash;
        uint256 n = nonce;
        if (!WOTS.verify(pk, messageFor(nextPkHash, target, value, data), sig)) revert InvalidSignature();
        pkHash = nextPkHash;
        nonce = n + 1;
        bool ok = _call(target, value, data);
        emit Executed(n, pk, nextPkHash, target, value, ok);
    }

    function payloadHashOf(address target, uint256 value, bytes calldata data) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), nonce, target, value, keccak256(data)));
    }

    function messageFor(bytes32 nextPkHash, address target, uint256 value, bytes calldata data)
        public
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(block.chainid, entry, pkHash, nextPkHash, payloadHashOf(target, value, data)));
    }

    /// @dev Call without copying return data (no return-bomb gas griefing).
    function _call(address target, uint256 value, bytes calldata data) internal returns (bool ok) {
        assembly ("memory-safe") {
            let p := mload(0x40)
            calldatacopy(p, data.offset, data.length)
            ok := call(gas(), target, value, p, data.length, 0, 0)
        }
    }
}
