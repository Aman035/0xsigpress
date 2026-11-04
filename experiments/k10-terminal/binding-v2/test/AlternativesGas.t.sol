// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import { Test, console2 } from "forge-std/Test.sol";
import { Poseidon1Hasher } from "../src/Poseidon1Hasher.sol";

/// Lower-bound gas for the Poseidon-only alternatives considered before choosing the keccak-challenge
/// binding (candidates (b) and (c) of the K10 binding-v2 brief). Synthetic data, warm hasher; only the
/// permutations + limb unpacking are counted, so real contracts would cost at least this much.
///  (b) max-rate sponge over raw signer data: 8 pk limbs + 9 message limbs = 17 FE per signer, 8 FE absorbed
///      per permutation (rate 8, capacity 8, as leanVM's slice hash), no per-signer hash_message.
///  (c) on-chain signer registry: pubkeys registered once; per batch only the 9 message limbs per signer
///      plus one index FE per 2 signers (15-bit indices packed in pairs) are absorbed.
contract AlternativesGasTest is Test {
    address hasher;
    uint256 constant P = 2_130_706_433;

    function setUp() external {
        hasher = address(new Poseidon1Hasher());
    }

    function _perm(uint256[16] memory st) internal view {
        address h = hasher;
        assembly ("memory-safe") {
            if iszero(staticcall(gas(), h, st, 512, st, 512)) { revert(0, 0) }
        }
    }

    /// Overwrite sponge over `nFe` field elements produced on the fly (cost of producing them ~ unpacking).
    function _sponge(uint256 nFe, uint256 salt) internal view returns (uint256 out) {
        uint256[16] memory st;
        st[0] = nFe;
        uint256 j;
        while (j < nFe) {
            for (uint256 i; i < 8; ++i) {
                st[8 + i] = j < nFe ? uint256(keccak256(abi.encode(salt, j))) % P : 0;
                ++j;
            }
            _perm(st);
        }
        out = st[8];
    }

    function testAlternatives() external view {
        uint256[3] memory ns = [uint256(16), 64, 256];
        for (uint256 k; k < 3; ++k) {
            uint256 n = ns[k];
            uint256 g = gasleft();
            _sponge(17 * n, 1);
            _sponge(17 * n, 2);
            uint256 b = g - gasleft();
            g = gasleft();
            _sponge(9 * n + (n + 1) / 2, 1);
            _sponge(9 * n + (n + 1) / 2, 2);
            uint256 c = g - gasleft();
            console2.log("signers/batch, (b) raw-sponge gas, (c) registry gas (2 batches)", n, b, c);
        }
        uint256 g2 = gasleft();
        uint256[16] memory st;
        _perm(st);
        console2.log("one permutation via staticcall", g2 - gasleft());
    }
}
