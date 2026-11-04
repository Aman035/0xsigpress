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
    error InsufficientGas();

    event Executed(
        uint256 indexed nonce, bytes32 indexed pkHash, bytes32 nextPkHash, address target, uint256 value, bool success
    );

    /// @notice Gas every bundled op's call gets, exactly. A bundle that cannot give an op this much reverts
    ///         whole (so an executor cannot pick a gas limit that makes one op fail while the rest land), and an
    ///         op cannot take more (so one gas-burning op cannot starve the rest of its bundle). An op needing more
    ///         must go through executeDirect.
    uint256 public constant OP_GAS_LIMIT = 200_000;
    /// @dev Upper bound on CALL's own cost (cold account 2,600 + value 9,000 + new account 25,000) plus slack.
    uint256 internal constant CALL_OVERHEAD = 40_000;

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
    ///         The call gets exactly OP_GAS_LIMIT gas (see there).
    function sigpressExecute(bytes32 nextPkHash, address target, uint256 value, bytes calldata data)
        external
        returns (bytes32 pk, uint256 n)
    {
        if (msg.sender != entry) revert NotEntry();
        pk = pkHash;
        n = nonce;
        pkHash = nextPkHash;
        nonce = n + 1;
        bool ok = _callCapped(target, value, data);
        emit Executed(n, pk, nextPkHash, target, value, ok);
    }

    /// @notice Single-op fallback (no aggregator needed): the WOTS signature is verified on chain.
    ///         Anyone holding the signature can submit it, so a failed call that looks like it ran out of gas
    ///         (at most 1/63 of the gas left) reverts instead of using the op up: a caller cannot burn the op by
    ///         under-funding it. Resubmit with more gas.
    function executeDirect(bytes32 nextPkHash, address target, uint256 value, bytes calldata data, bytes calldata sig)
        external
    {
        bytes32 pk = pkHash;
        uint256 n = nonce;
        if (!WOTS.verify(pk, messageFor(nextPkHash, target, value, data), sig)) revert InvalidSignature();
        pkHash = nextPkHash;
        nonce = n + 1;
        uint256 g = gasleft();
        bool ok = _call(target, value, data);
        if (!ok && gasleft() <= g / 63) revert InsufficientGas();
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

    /// @dev As _call, but the callee gets exactly OP_GAS_LIMIT, or the whole tx reverts with InsufficientGas.
    function _callCapped(address target, uint256 value, bytes calldata data) internal returns (bool ok) {
        uint256 p;
        assembly ("memory-safe") {
            p := mload(0x40)
            calldatacopy(p, data.offset, data.length) // pay memory expansion before the gas check
            mstore(0x40, add(p, and(add(data.length, 31), not(31))))
        }
        if (gasleft() < OP_GAS_LIMIT + OP_GAS_LIMIT / 63 + CALL_OVERHEAD) revert InsufficientGas();
        assembly ("memory-safe") {
            ok := call(OP_GAS_LIMIT, target, value, p, data.length, 0, 0)
        }
    }
}
