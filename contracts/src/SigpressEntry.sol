// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {OptimisticAggregator} from "./OptimisticAggregator.sol";
import {SigpressAccount} from "./SigpressAccount.sol";

/// @title SigpressEntry
/// @notice Executes a whole OptimisticAggregator batch in one tx from a tightly packed bundle (the K9 fix:
///         no ERC-4337 UserOp ABI encoding, no per-op Merkle proofs).
///
///         One bundle = one batch. The entry rebuilds every op's leaf from the bundle plus the account's own
///         storage (key, nonce), recomputes the batch's Merkle root from all `count` leaves, and requires it to
///         equal the root of a finalized, unslashed batch. Any mismatch reverts the whole tx (ops run first, the
///         root is checked last; the revert undoes them). Each op's leaf binds the same things as PQAccount:
///             leaf = keccak256(pkHash ‖ m ‖ sigHash)
///             m    = keccak256(abi.encode(chainId, address(this), pkHash, nextPkHash, payloadHash))
///             payloadHash = keccak256(abi.encode(account, nonce, target, value, keccak256(data)))
///
///         Calldata = selector(executeBundle()) ‖ bundle, bundle (big-endian, no padding):
///             batchId uint32
///             count × op:
///                 accountIndex uint32       account = CREATE2 clone at salt = index (derived, no storage read)
///                 target       20 B
///                 valueLen     uint8 (0..32), then value as valueLen big-endian bytes
///                 dataLen      uint16, then data
///                 nextPkHash   32 B
///                 sigHash      32 B         keccak256 of the off-chain WOTS signature
///         Nonce and pkHash are implicit (read from the account). The WOTS signatures themselves stay off chain.
contract SigpressEntry {
    error Reentrancy();
    error BatchNotAccepted();
    error AlreadyExecuted();
    error BadBundle();
    error UnknownAccount(uint256 index);
    error RootMismatch();
    error CreateFailed();
    error NoAccounts();

    event AccountCreated(uint256 indexed index, address indexed account, bytes32 pkHash);
    event BundleExecuted(uint256 indexed batchId, uint256 count);

    OptimisticAggregator public immutable batches;
    SigpressAccount public immutable accountImpl;
    bytes32 public immutable cloneCodeHash;

    uint256 public accountCount;
    mapping(uint256 => bool) public executed;

    constructor(OptimisticAggregator batches_) {
        batches = batches_;
        accountImpl = new SigpressAccount(address(this));
        cloneCodeHash = keccak256(_cloneCode(address(accountImpl)));
    }

    // ---- accounts ----

    /// @notice Create one account per key; msg.value is split evenly among them. Returns the first index.
    function createAccounts(bytes32[] calldata pkHashes) external payable returns (uint256 first) {
        uint256 k = pkHashes.length;
        if (k == 0 && msg.value != 0) revert NoAccounts(); // the entry cannot send ETH back out
        first = accountCount;
        uint256 each = k == 0 ? 0 : msg.value / k;
        bytes memory code = _cloneCode(address(accountImpl));
        for (uint256 i = 0; i < k; i++) {
            uint256 index = first + i;
            address a;
            uint256 v = i == k - 1 ? msg.value - each * (k - 1) : each;
            assembly ("memory-safe") {
                a := create2(v, add(code, 32), mload(code), index)
            }
            if (a == address(0)) revert CreateFailed();
            SigpressAccount(payable(a)).init(pkHashes[i]);
            emit AccountCreated(index, a, pkHashes[i]);
        }
        accountCount = first + k;
    }

    function accountOf(uint256 index) public view returns (address) {
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), bytes32(index), cloneCodeHash))))
        );
    }

    // ---- bundles ----

    /// @notice Execute a whole finalized batch. The packed bundle follows the 4-byte selector (see contract doc).
    function executeBundle() external {
        bool locked;
        assembly ("memory-safe") {
            locked := tload(0)
            tstore(0, 1)
        }
        if (locked) revert Reentrancy();
        bytes calldata b = msg.data[4:];
        if (b.length < 4) revert BadBundle();
        uint256 id = uint32(bytes4(b[0:4]));
        (bytes32 root,,, uint32 count, bool slashed, bool finalized) = batches.batches(id);
        if (!finalized || slashed || count == 0) revert BatchNotAccepted();
        if (executed[id]) revert AlreadyExecuted();
        executed[id] = true;

        uint256 size = 1;
        while (size < count) size <<= 1;
        bytes32[] memory nodes = new bytes32[](size); // zero-padded leaves
        uint256 nAccounts = accountCount;
        uint256 p = 4;
        for (uint256 i = 0; i < count; i++) {
            (nodes[i], p) = _runOp(b, p, nAccounts);
        }
        if (p != b.length) revert BadBundle();
        if (_root(nodes) != root) revert RootMismatch();
        emit BundleExecuted(id, count);
        assembly ("memory-safe") {
            tstore(0, 0)
        }
    }

    /// @dev Parse one op at offset p, run it through its account, return its leaf and the next offset.
    function _runOp(bytes calldata b, uint256 p, uint256 nAccounts) internal returns (bytes32 leaf, uint256) {
        uint256 index = uint32(bytes4(b[p:p + 4]));
        if (index >= nAccounts) revert UnknownAccount(index);
        address target = address(bytes20(b[p + 4:p + 24]));
        uint256 vlen = uint8(b[p + 24]);
        if (vlen > 32) revert BadBundle();
        p += 25;
        uint256 value = vlen == 0 ? 0 : uint256(bytes32(b[p:p + vlen])) >> (8 * (32 - vlen));
        p += vlen;
        uint256 dlen = uint16(bytes2(b[p:p + 2]));
        bytes calldata data = b[p + 2:p + 2 + dlen];
        p += 2 + dlen;
        bytes32 next = bytes32(b[p:p + 32]);
        bytes32 sigHash = bytes32(b[p + 32:p + 64]);
        p += 64;

        address acct = accountOf(index);
        (bytes32 pk, uint256 n) = SigpressAccount(payable(acct)).sigpressExecute(next, target, value, data);
        bytes32 ph = keccak256(abi.encode(acct, n, target, value, keccak256(data)));
        bytes32 m = keccak256(abi.encode(block.chainid, address(this), pk, next, ph));
        leaf = keccak256(abi.encodePacked(pk, m, sigHash));
        return (leaf, p);
    }

    /// @dev Root over a power-of-two node array, hashed in place (same tree as OptimisticAggregator / merkle.ts).
    function _root(bytes32[] memory nodes) internal pure returns (bytes32) {
        uint256 n = nodes.length;
        while (n > 1) {
            for (uint256 i = 0; i < n; i += 2) {
                nodes[i >> 1] = keccak256(abi.encodePacked(nodes[i], nodes[i + 1]));
            }
            n >>= 1;
        }
        return nodes[0];
    }

    /// @dev EIP-1167 minimal proxy creation code for `impl` (55 bytes).
    function _cloneCode(address impl) internal pure returns (bytes memory) {
        return
            abi.encodePacked(hex"3d602d80600a3d3981f3363d3d373d3d3d363d73", impl, hex"5af43d82803e903d91602b57fd5bf3");
    }
}
