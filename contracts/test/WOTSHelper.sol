// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Test-only WOTS keygen/sign, matching the shared spec.
library WOTSHelper {
    function chain(bytes32 x, uint256 steps) internal pure returns (bytes32) {
        for (uint256 s = 0; s < steps; s++) x = keccak256(abi.encodePacked(x));
        return x;
    }

    function sk(bytes32 seed, uint32 keyIndex, uint8 i) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(seed, keyIndex, i));
    }

    function digits(bytes32 m) internal pure returns (uint8[67] memory d) {
        uint256 c;
        for (uint256 i = 0; i < 64; i++) {
            d[i] = uint8((uint256(m) >> (252 - 4 * i)) & 0xf);
            c += 15 - d[i];
        }
        d[64] = uint8((c >> 8) & 0xf);
        d[65] = uint8((c >> 4) & 0xf);
        d[66] = uint8(c & 0xf);
    }

    function pkHash(bytes32 seed, uint32 keyIndex) internal pure returns (bytes32) {
        bytes memory pk = new bytes(2144);
        for (uint8 i = 0; i < 67; i++) {
            bytes32 p = chain(sk(seed, keyIndex, i), 15);
            assembly { mstore(add(add(pk, 32), mul(i, 32)), p) }
        }
        return keccak256(pk);
    }

    function sign(bytes32 seed, uint32 keyIndex, bytes32 m) internal pure returns (bytes memory sig) {
        uint8[67] memory d = digits(m);
        sig = new bytes(2144);
        for (uint8 i = 0; i < 67; i++) {
            bytes32 s = chain(sk(seed, keyIndex, i), d[i]);
            assembly { mstore(add(add(sig, 32), mul(i, 32)), s) }
        }
    }
}
