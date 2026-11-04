// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import { Test, console2 } from "forge-std/Test.sol";
import { Poseidon1Hasher } from "../src/Poseidon1Hasher.sol";
import { SigpressValidityGate, ILeanVmTerminalC1 } from "../src/SigpressValidityGate.sol";

/// Real 2 x 4 per-signer-message proof (runs/n4) against its generated verifier (vendor/sol-whir-p3-binding).
/// Override with env BIND_RUN (default runs/n4), BIND_LABEL (proof, default SigpressBindC1N4) and BIND_VERIFIER.
/// The SDK-signed proof (runs/sdk-n4, SigpressBindSdkC1N4) runs against the same SigpressBindC1N4 verifier.
contract SigpressValidityGateTest is Test {
    SigpressValidityGate gate;
    ILeanVmTerminalC1.Proof proof;
    uint32 slot;
    SigpressValidityGate.Batch left;
    SigpressValidityGate.Batch right;

    function decode(bytes calldata cd) external pure returns (ILeanVmTerminalC1.Proof memory) {
        return abi.decode(cd[4:], (ILeanVmTerminalC1.Proof));
    }

    function setUp() external {
        string memory run = vm.envOr("BIND_RUN", string("runs/n4"));
        string memory label = vm.envOr("BIND_LABEL", string("SigpressBindC1N4"));
        string memory name =
            string.concat("LeanVmTwoCommitmentTerminal_", vm.envOr("BIND_VERIFIER", string("SigpressBindC1N4")));
        address verifier = vm.deployCode(
            string.concat("../vendor/sol-whir-p3-binding/out/", name, ".sol/", name, ".json")
        );
        string memory st = vm.readFile(string.concat(run, "/statement.json"));
        gate = new SigpressValidityGate(
            ILeanVmTerminalC1(verifier), address(new Poseidon1Hasher()), vm.parseJsonUintArray(st, ".const_words")
        );
        slot = uint32(vm.parseJsonUint(st, ".slot"));
        left.pubkeys = vm.parseJsonBytes32Array(st, ".left.pubkeys");
        left.messages = vm.parseJsonBytes32Array(st, ".left.messages");
        right.pubkeys = vm.parseJsonBytes32Array(st, ".right.pubkeys");
        right.messages = vm.parseJsonBytes32Array(st, ".right.messages");
        bytes memory cd = vm.readFileBinary(
            string.concat("results/", label, "/calldata.bin")
        );
        proof = this.decode(cd);
    }

    function testRecomputedRootMatchesProof() external {
        uint256[8] memory r = gate.applicationRoot(slot, left, right);
        for (uint256 i; i < 8; ++i) assertEq(r[i], proof.applicationRoot[i]);
    }

    function testAccept() external {
        uint256 g = gasleft();
        bytes32 c = gate.submit(proof, slot, left, right);
        console2.log("submit gas (cold midstate cache, in-test)", g - gasleft());
        assertTrue(gate.accepted(c));
        assertEq(c, keccak256(abi.encode(slot, left.pubkeys, left.messages, right.pubkeys, right.messages)));
    }

    function testBindingGas() external {
        uint256 g = gasleft();
        gate.applicationRoot(slot, left, right);
        console2.log("binding only, cold midstate cache", g - gasleft());
        g = gasleft();
        gate.applicationRoot(slot, left, right);
        console2.log("binding only, warm midstate cache", g - gasleft());
        g = gasleft();
        gate.hashMessage(left.messages[0]);
        console2.log("hashMessage (1 permutation)", g - gasleft());
    }

    function testReplayRejected() external {
        gate.submit(proof, slot, left, right);
        vm.expectRevert(SigpressValidityGate.AlreadyAccepted.selector);
        gate.submit(proof, slot, left, right);
    }

    function testTamperedProofRejected() external {
        bytes memory t = proof.transcript;
        t[t.length / 2] = bytes1(uint8(t[t.length / 2]) ^ 1);
        proof.transcript = t;
        vm.expectRevert();
        gate.submit(proof, slot, left, right);
    }

    function testTamperedOpeningsRejected() external {
        bytes memory o = proof.openings;
        o[o.length / 3] = bytes1(uint8(o[o.length / 3]) ^ 0x80);
        proof.openings = o;
        vm.expectRevert();
        gate.submit(proof, slot, left, right);
    }

    function testWrongSignerRejected() external {
        left.pubkeys[1] = bytes32(uint256(left.pubkeys[1]) ^ 1);
        vm.expectRevert(SigpressValidityGate.RootMismatch.selector);
        gate.submit(proof, slot, left, right);
    }

    function testDroppedSignerRejected() external {
        left.pubkeys.pop();
        left.messages.pop();
        vm.expectRevert(SigpressValidityGate.RootMismatch.selector);
        gate.submit(proof, slot, left, right);
    }

    function testWrongMessageRejected() external {
        right.messages[2] = keccak256("not what signer 2 signed");
        vm.expectRevert(SigpressValidityGate.RootMismatch.selector);
        gate.submit(proof, slot, left, right);
    }

    function testSwappedMessagesRejected() external {
        // The SDK-signed batch has one shared message per batch: swapping is then a no-op, skip.
        if (left.messages[0] == left.messages[1]) vm.skip(true);
        (left.messages[0], left.messages[1]) = (left.messages[1], left.messages[0]);
        vm.expectRevert(SigpressValidityGate.RootMismatch.selector);
        gate.submit(proof, slot, left, right);
    }

    function testSwappedBatchesRejected() external {
        vm.expectRevert(SigpressValidityGate.RootMismatch.selector);
        gate.submit(proof, slot, right, left);
    }

    function testWrongSlotRejected() external {
        vm.expectRevert(SigpressValidityGate.RootMismatch.selector);
        gate.submit(proof, slot + 1, left, right);
    }

    function testNonCanonicalPubkeyRejected() external {
        left.pubkeys[0] = bytes32(type(uint256).max);
        vm.expectRevert(SigpressValidityGate.NonCanonical.selector);
        gate.submit(proof, slot, left, right);
    }

    function testLengthMismatchRejected() external {
        left.messages.pop();
        vm.expectRevert(SigpressValidityGate.BadLengths.selector);
        gate.submit(proof, slot, left, right);
    }
}
