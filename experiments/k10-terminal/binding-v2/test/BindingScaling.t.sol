// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import { Test, console2 } from "forge-std/Test.sol";
import { Poseidon1Hasher } from "../src/Poseidon1Hasher.sol";
import { SigpressBindV2Gate, ILeanVmTerminalC1 } from "../src/SigpressBindV2Gate.sol";

/// Gas of the v2 on-chain binding (keccak challenge + F_p^5 polynomial + 11 Poseidon permutations) vs
/// signers per batch. Synthetic signers (the root is not checked here, only its cost); warm midstate cache.
/// Batches are built in memory, so the external call passes them as calldata (no storage reads).
contract BindingScalingTest is Test {
    SigpressBindV2Gate gate;

    function setUp() external {
        gate = new SigpressBindV2Gate(ILeanVmTerminalC1(address(0)), address(new Poseidon1Hasher()), new uint256[](128));
    }

    function _batch(uint256 n, uint256 salt) internal pure returns (SigpressBindV2Gate.Batch memory b) {
        b.pubkeys = new bytes32[](n);
        b.messages = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            b.pubkeys[i] = bytes32(uint256(keccak256(abi.encode(salt, i))) & 0x3fffffff3fffffff3fffffff3fffffff3fffffff3fffffff3fffffff3fffffff);
            b.messages[i] = keccak256(abi.encode("m", salt, i));
        }
        b.commitment = bytes32(uint256(keccak256(abi.encode("d", salt))) & 0x3fffffff3fffffff3fffffff3fffffff3fffffff3fffffff3fffffff3fffffff);
    }

    function testScaling() external {
        uint256[8] memory ns = [uint256(1), 4, 16, 64, 128, 256, 512, 1024];
        for (uint256 k; k < ns.length; ++k) {
            SigpressBindV2Gate.Batch memory l = _batch(ns[k], 1);
            SigpressBindV2Gate.Batch memory r = _batch(ns[k], 2);
            gate.prepareShape(ns[k]);
            // calldata encoded before measuring, so only the gate's own execution is counted
            bytes memory cdRoot = abi.encodeCall(gate.applicationRoot, (7, l, r));
            bytes memory cdCommit = abi.encodeCall(gate.batchCommitment, (7, l, r));
            address target = address(gate);
            uint256 g = gasleft();
            (bool ok,) = target.call(cdRoot);
            uint256 used = g - gasleft();
            assertTrue(ok);
            g = gasleft();
            (ok,) = target.call(cdCommit);
            uint256 commit = g - gasleft();
            assertTrue(ok);
            console2.log("signers/batch, binding gas (2 batches, warm), replay-commitment gas", ns[k], used, commit);
        }
        uint256 g2 = gasleft();
        gate.prepareShape(5000);
        console2.log("prepareShape (cold, 17 permutations + 2 SSTORE)", g2 - gasleft());
    }

    /// Cross-check of the F_p^5 evaluation against the Python mirror (tools/statement.py) is done on the real
    /// run in SigpressBindV2Gate.t.sol (recomputed root == proof root); this just pins one challenge value.
    function testChallengeDeterministic() external view {
        SigpressBindV2Gate.Batch memory l = _batch(3, 9);
        (uint256[5] memory r1, uint256[5] memory v1) = gate.challengeAndEval(7, l);
        (uint256[5] memory r2, uint256[5] memory v2) = gate.challengeAndEval(7, l);
        for (uint256 i; i < 5; ++i) {
            assertEq(r1[i], r2[i]);
            assertEq(v1[i], v2[i]);
            assertLt(r1[i], 2_130_706_433);
            assertLt(v1[i], 2_130_706_433);
        }
    }
}
