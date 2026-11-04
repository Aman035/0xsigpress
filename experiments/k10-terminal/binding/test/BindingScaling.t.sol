// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import { Test, console2 } from "forge-std/Test.sol";
import { Poseidon1Hasher } from "../src/Poseidon1Hasher.sol";
import { SigpressValidityGate, ILeanVmTerminalC1 } from "../src/SigpressValidityGate.sol";

/// Gas of the on-chain binding (Poseidon1 recomputation of the application root) vs signers per batch.
/// Synthetic signers: the root is not checked here, only its cost. Measured on warm midstate cache.
contract BindingScalingTest is Test {
    SigpressValidityGate gate;

    function setUp() external {
        gate = new SigpressValidityGate(ILeanVmTerminalC1(address(0)), address(new Poseidon1Hasher()), new uint256[](128));
    }

    function _batch(uint256 n, uint256 salt) internal pure returns (SigpressValidityGate.Batch memory b) {
        b.pubkeys = new bytes32[](n);
        b.messages = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            b.pubkeys[i] = bytes32(uint256(keccak256(abi.encode(salt, i))) & 0x3fffffff3fffffff3fffffff3fffffff3fffffff3fffffff3fffffff3fffffff);
            b.messages[i] = keccak256(abi.encode("m", salt, i));
        }
    }

    function testScaling() external {
        uint256[5] memory ns = [uint256(1), 4, 16, 64, 128];
        for (uint256 k; k < ns.length; ++k) {
            SigpressValidityGate.Batch memory l = _batch(ns[k], 1);
            SigpressValidityGate.Batch memory r = _batch(ns[k], 2);
            gate.prepareShape(ns[k]);
            uint256 g = gasleft();
            gate.applicationRoot(7, l, r);
            console2.log("signers per batch / binding gas (2 batches, warm)", ns[k], g - gasleft());
        }
        uint256 g2 = gasleft();
        gate.prepareShape(1000);
        console2.log("prepareShape (cold, 17 permutations + 2 SSTORE)", g2 - gasleft());
    }
}
