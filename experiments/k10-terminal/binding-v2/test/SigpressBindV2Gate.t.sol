// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import { Test, console2 } from "forge-std/Test.sol";
import { Poseidon1Hasher } from "../src/Poseidon1Hasher.sol";
import { SigpressBindV2Gate, ILeanVmTerminalC1 } from "../src/SigpressBindV2Gate.sol";

/// Real v2 proof (default runs/n4, 2 x 4) against its generated verifier (vendor/sol-whir-p3-binding-v2).
/// Env: BIND_RUN (run dir), BIND_LABEL (results/<label>/calldata.bin), BIND_VERIFIER (verifier label).
contract SigpressBindV2GateTest is Test {
    SigpressBindV2Gate gate;
    ILeanVmTerminalC1.Proof proof;
    uint32 slot;
    SigpressBindV2Gate.Batch left;
    SigpressBindV2Gate.Batch right;

    function decode(bytes calldata cd) external pure returns (ILeanVmTerminalC1.Proof memory) {
        return abi.decode(cd[4:], (ILeanVmTerminalC1.Proof));
    }

    function setUp() external {
        string memory run = vm.envOr("BIND_RUN", string("runs/n4"));
        string memory label = vm.envOr("BIND_LABEL", string("SigpressBindV2C1N4"));
        string memory name =
            string.concat("LeanVmTwoCommitmentTerminal_", vm.envOr("BIND_VERIFIER", string("SigpressBindV2C1N4")));
        address verifier =
            vm.deployCode(string.concat("../vendor/sol-whir-p3-binding-v2/out/", name, ".sol/", name, ".json"));
        string memory st = vm.readFile(string.concat(run, "/statement.json"));
        gate = new SigpressBindV2Gate(
            ILeanVmTerminalC1(verifier), address(new Poseidon1Hasher()), vm.parseJsonUintArray(st, ".const_words")
        );
        slot = uint32(vm.parseJsonUint(st, ".slot"));
        left.pubkeys = vm.parseJsonBytes32Array(st, ".left.pubkeys");
        left.messages = vm.parseJsonBytes32Array(st, ".left.messages");
        left.commitment = vm.parseJsonBytes32(st, ".left.commitment");
        right.pubkeys = vm.parseJsonBytes32Array(st, ".right.pubkeys");
        right.messages = vm.parseJsonBytes32Array(st, ".right.messages");
        right.commitment = vm.parseJsonBytes32(st, ".right.commitment");
        proof = this.decode(vm.readFileBinary(string.concat("results/", label, "/calldata.bin")));
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
    }

    function testReplayRejected() external {
        gate.submit(proof, slot, left, right);
        vm.expectRevert(SigpressBindV2Gate.AlreadyAccepted.selector);
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

    function testTamperedApplicationRootRejected() external {
        // The calldata statement no longer matches the root the proof carries.
        proof.applicationRoot[0] = (proof.applicationRoot[0] + 1) % 2_130_706_433;
        vm.expectRevert(SigpressBindV2Gate.RootMismatch.selector);
        gate.submit(proof, slot, left, right);
    }

    function testWrongSignerRejected() external {
        left.pubkeys[1] = bytes32(uint256(left.pubkeys[1]) ^ 1);
        vm.expectRevert(SigpressBindV2Gate.RootMismatch.selector);
        gate.submit(proof, slot, left, right);
    }

    function testDroppedSignerRejected() external {
        left.pubkeys.pop();
        left.messages.pop();
        vm.expectRevert(SigpressBindV2Gate.RootMismatch.selector);
        gate.submit(proof, slot, left, right);
    }

    function testWrongMessageRejected() external {
        right.messages[2] = keccak256("not what signer 2 signed");
        vm.expectRevert(SigpressBindV2Gate.RootMismatch.selector);
        gate.submit(proof, slot, left, right);
    }

    function testSwappedMessagesRejected() external {
        if (left.messages[0] == left.messages[1]) vm.skip(true);
        (left.messages[0], left.messages[1]) = (left.messages[1], left.messages[0]);
        vm.expectRevert(SigpressBindV2Gate.RootMismatch.selector);
        gate.submit(proof, slot, left, right);
    }

    function testSwappedSignersRejected() external {
        (left.pubkeys[0], left.pubkeys[1]) = (left.pubkeys[1], left.pubkeys[0]);
        (left.messages[0], left.messages[1]) = (left.messages[1], left.messages[0]);
        vm.expectRevert(SigpressBindV2Gate.RootMismatch.selector);
        gate.submit(proof, slot, left, right);
    }

    function testSwappedBatchesRejected() external {
        vm.expectRevert(SigpressBindV2Gate.RootMismatch.selector);
        gate.submit(proof, slot, right, left);
    }

    function testWrongSlotRejected() external {
        vm.expectRevert(SigpressBindV2Gate.RootMismatch.selector);
        gate.submit(proof, slot + 1, left, right);
    }

    function testWrongCommitmentRejected() external {
        left.commitment = bytes32(uint256(left.commitment) ^ 1);
        vm.expectRevert(SigpressBindV2Gate.RootMismatch.selector);
        gate.submit(proof, slot, left, right);
    }

    function testNonCanonicalPubkeyRejected() external {
        left.pubkeys[0] = bytes32(type(uint256).max);
        vm.expectRevert(SigpressBindV2Gate.NonCanonical.selector);
        gate.submit(proof, slot, left, right);
    }

    function testNonCanonicalCommitmentRejected() external {
        left.commitment = bytes32(type(uint256).max);
        vm.expectRevert(SigpressBindV2Gate.NonCanonical.selector);
        gate.submit(proof, slot, left, right);
    }

    function testLengthMismatchRejected() external {
        left.messages.pop();
        vm.expectRevert(SigpressBindV2Gate.BadLengths.selector);
        gate.submit(proof, slot, left, right);
    }
}
