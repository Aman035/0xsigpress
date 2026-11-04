// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {WOTS} from "../src/WOTS.sol";
import {NaiveLane} from "../src/NaiveLane.sol";
import {WOTSHelper} from "./WOTSHelper.sol";

contract WOTSHarness {
    function verify(bytes32 pkHash, bytes32 m, bytes calldata sig) external pure returns (bool) {
        return WOTS.verify(pkHash, m, sig);
    }
}

contract WOTSTest is Test {
    WOTSHarness h;
    NaiveLane lane;
    bytes32 seed = keccak256("sigpress-test");

    function setUp() public {
        h = new WOTSHarness();
        lane = new NaiveLane();
    }

    function test_validSigVerifies() public view {
        bytes32 m = keccak256("hello");
        assertTrue(h.verify(WOTSHelper.pkHash(seed, 0), m, WOTSHelper.sign(seed, 0, m)));
    }

    function test_flippedBitFails() public view {
        bytes32 m = keccak256("hello");
        bytes memory sig = WOTSHelper.sign(seed, 0, m);
        sig[100] = bytes1(uint8(sig[100]) ^ 0x01);
        assertFalse(h.verify(WOTSHelper.pkHash(seed, 0), m, sig));
    }

    function test_wrongMessageFails() public view {
        bytes32 m = keccak256("hello");
        bytes memory sig = WOTSHelper.sign(seed, 0, m);
        assertFalse(h.verify(WOTSHelper.pkHash(seed, 0), keccak256("hellp"), sig));
    }

    function test_wrongLengthFails() public view {
        bytes32 m = keccak256("hello");
        bytes memory sig = WOTSHelper.sign(seed, 0, m);
        bytes memory shortSig = new bytes(2143);
        for (uint256 i = 0; i < 2143; i++) shortSig[i] = sig[i];
        assertFalse(h.verify(WOTSHelper.pkHash(seed, 0), m, shortSig));
        assertFalse(h.verify(WOTSHelper.pkHash(seed, 0), m, ""));
    }

    function test_extremeDigits() public view {
        // all-zero and all-0xff messages exercise digit 0 and digit 15 chains + checksum extremes
        assertTrue(h.verify(WOTSHelper.pkHash(seed, 3), bytes32(0), WOTSHelper.sign(seed, 3, bytes32(0))));
        bytes32 ff = bytes32(type(uint256).max);
        assertTrue(h.verify(WOTSHelper.pkHash(seed, 4), ff, WOTSHelper.sign(seed, 4, ff)));
    }

    function testFuzz_verify(bytes32 m, uint32 k) public view {
        assertTrue(h.verify(WOTSHelper.pkHash(seed, k), m, WOTSHelper.sign(seed, k, m)));
    }

    function test_naiveLaneSubmit() public {
        bytes32 m = keccak256("hello");
        bytes32 pk = WOTSHelper.pkHash(seed, 0);
        bytes memory sig = WOTSHelper.sign(seed, 0, m);
        vm.expectEmit(true, false, false, true);
        emit NaiveLane.Verified(pk, m);
        lane.submit(pk, m, sig);
    }

    function test_naiveLaneRevertsOnBadSig() public {
        bytes32 m = keccak256("hello");
        bytes32 pk = WOTSHelper.pkHash(seed, 0);
        bytes memory sig = WOTSHelper.sign(seed, 0, m);
        sig[0] = bytes1(uint8(sig[0]) ^ 0x80);
        vm.expectRevert(NaiveLane.InvalidSignature.selector);
        lane.submit(pk, m, sig);
    }

    /// Fixed cross-check vector for the TypeScript side.
    function test_vector() public {
        bytes32 m = keccak256("hello");
        bytes32 pk = WOTSHelper.pkHash(seed, 0);
        bytes memory sig = WOTSHelper.sign(seed, 0, m);
        bytes32 sigHash = keccak256(sig);
        bytes32 sk0 = WOTSHelper.sk(seed, 0, 0);
        console.log("seed");
        console.logBytes32(seed);
        console.log("m");
        console.logBytes32(m);
        console.log("sk_0");
        console.logBytes32(sk0);
        console.log("pkHash");
        console.logBytes32(pk);
        console.log("keccak256(sig)");
        console.logBytes32(sigHash);
        assertTrue(h.verify(pk, m, sig));
        string memory obj = "v";
        vm.serializeBytes32(obj, "seed", seed);
        vm.serializeUint(obj, "keyIndex", 0);
        vm.serializeBytes32(obj, "m", m);
        vm.serializeBytes32(obj, "sk0", sk0);
        vm.serializeBytes32(obj, "pkHash", pk);
        vm.serializeBytes32(obj, "sigHash", sigHash);
        string memory json = vm.serializeBytes(obj, "sig", sig);
        vm.writeJson(json, "./test/vectors.json");
    }
}
