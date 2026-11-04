// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import { Test, console2 } from "forge-std/Test.sol";
import { Poseidon1Hasher } from "../src/Poseidon1Hasher.sol";
import { SigpressValidityGate, ILeanVmTerminalC1 } from "../src/SigpressValidityGate.sol";

/// Vectors from leanVM's Apache-2.0 python reference (tools/statement.py --vectors).
contract Poseidon1HasherTest is Test {
    address h;
    SigpressValidityGate gate;
    string vec;

    function setUp() external {
        h = address(new Poseidon1Hasher());
        gate = new SigpressValidityGate(ILeanVmTerminalC1(address(0)), h, new uint256[](128));
        vec = vm.readFile("test/poseidon-vectors.json");
    }

    function _perm(uint256[16] memory a) internal view returns (uint256[16] memory r) {
        (bool ok, bytes memory out) = h.staticcall(abi.encodePacked(a));
        require(ok && out.length == 512);
        r = abi.decode(out, (uint256[16]));
    }

    function testPermVectors() external view {
        for (uint256 k; k < 3; ++k) {
            uint256[] memory i = vm.parseJsonUintArray(vec, string.concat(".perm[", vm.toString(k), "].in"));
            uint256[] memory o = vm.parseJsonUintArray(vec, string.concat(".perm[", vm.toString(k), "].out"));
            uint256[16] memory s;
            for (uint256 j; j < 16; ++j) s[j] = i[j];
            s = _perm(s);
            for (uint256 j; j < 16; ++j) assertEq(s[j], o[j]);
        }
    }

    function testHashMessageVectors() external view {
        for (uint256 k; k < 3; ++k) {
            bytes32 m = vm.parseJsonBytes32(vec, string.concat(".hash_message[", vm.toString(k), "].m"));
            uint256[] memory o = vm.parseJsonUintArray(vec, string.concat(".hash_message[", vm.toString(k), "].out"));
            uint256[8] memory got = gate.hashMessage(m);
            for (uint256 j; j < 8; ++j) assertEq(got[j], o[j]);
        }
    }

    /// Non-canonical inputs are reduced mod p by the first round (same as the reference).
    function testNonCanonicalInputReduced() external view {
        uint256[16] memory a;
        uint256[16] memory b;
        for (uint256 j; j < 16; ++j) { a[j] = j + 2_130_706_433; b[j] = j; }
        a = _perm(a);
        b = _perm(b);
        for (uint256 j; j < 16; ++j) assertEq(a[j], b[j]);
    }

    function testPermGas() external view {
        uint256[16] memory s;
        uint256 g = gasleft();
        for (uint256 k; k < 10; ++k) s = _perm(s);
        console2.log("Poseidon1Hasher: 10 permutations incl. staticcall+abi, gas", g - gasleft());
    }
}
