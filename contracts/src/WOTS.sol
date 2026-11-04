// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title WOTS
/// @notice Winternitz one-time signature verifier. w = 16, n = 32 bytes, Keccak-256.
///         64 message digits (nibbles of m, high nibble of byte 0 first) + 3 checksum digits = 67 chains.
///         Signature = sig_0 || ... || sig_66 (2,144 bytes). pkHash = keccak256(pk_0 || ... || pk_66).
library WOTS {
    uint256 internal constant LEN = 67;
    uint256 internal constant SIG_BYTES = 2144; // 67 * 32

    /// @notice Returns true iff `sig` is a valid WOTS signature of `m` under the key with hash `pkHash`.
    function verify(bytes32 pkHash, bytes32 m, bytes calldata sig) internal pure returns (bool ok) {
        if (sig.length != SIG_BYTES) return false;
        assembly ("memory-safe") {
            let buf := mload(0x40)
            calldatacopy(buf, sig.offset, SIG_BYTES)

            let csum := 0
            // 64 message digits
            for { let i := 0 } lt(i, 64) { i := add(i, 1) } {
                let d := and(shr(sub(252, mul(i, 4)), m), 0xf)
                csum := add(csum, sub(15, d))
                let p := add(buf, mul(i, 32))
                for { let s := d } lt(s, 15) { s := add(s, 1) } {
                    mstore(p, keccak256(p, 32))
                }
            }
            // 3 checksum digits
            for { let j := 0 } lt(j, 3) { j := add(j, 1) } {
                let d := and(shr(sub(8, mul(j, 4)), csum), 0xf)
                let p := add(buf, mul(add(64, j), 32))
                for { let s := d } lt(s, 15) { s := add(s, 1) } {
                    mstore(p, keccak256(p, 32))
                }
            }
            ok := eq(keccak256(buf, SIG_BYTES), pkHash)
        }
    }
}
