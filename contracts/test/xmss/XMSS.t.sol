// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {WOTS} from "../../src/WOTS.sol";
import {XMSS} from "../../src/xmss/XMSS.sol";
import {XMSSAccount} from "../../src/xmss/XMSSAccount.sol";
import {OptimisticAggregator} from "../../src/OptimisticAggregator.sol";
import {PQAccount} from "../../src/PQAccount.sol";
import {WOTSHelper} from "../WOTSHelper.sol";
import {XMSSHelper} from "./XMSSHelper.sol";

contract XMSSHarness {
    function verifyXmss(
        bytes32 root,
        uint256 h,
        bytes32 m,
        uint256 idx,
        bytes32 pk,
        bytes calldata sig,
        bytes32[] calldata path
    ) external pure returns (bool ok) {
        ok = XMSS.verify(root, h, m, idx, pk, sig, path);
    }

    function verifyWots(bytes32 pk, bytes32 m, bytes calldata sig) external pure returns (bool) {
        return WOTS.verify(pk, m, sig);
    }

    /// Gas of the library call alone (no call overhead, no calldata decoding of the caller).
    function gasXmss(
        bytes32 root,
        uint256 h,
        bytes32 m,
        uint256 idx,
        bytes32 pk,
        bytes calldata sig,
        bytes32[] calldata path
    ) external view returns (bool ok, uint256 used) {
        uint256 g = gasleft();
        ok = XMSS.verify(root, h, m, idx, pk, sig, path);
        used = g - gasleft();
    }

    function gasWots(bytes32 pk, bytes32 m, bytes calldata sig) external view returns (bool ok, uint256 used) {
        uint256 g = gasleft();
        ok = WOTS.verify(pk, m, sig);
        used = g - gasleft();
    }
}

contract XMSSTest is Test {
    XMSSHarness hx;
    bytes32 seed = keccak256("sigpress-xmss-test");
    bytes32 m = keccak256("hello xmss");

    // h = 4 tree with all real leaves
    uint256 constant H = 4;
    bytes32[] leaves;
    bytes32 root;

    function setUp() public {
        hx = new XMSSHarness();
        leaves = XMSSHelper.realLeaves(seed, H);
        root = XMSSHelper.root(leaves);
    }

    function _sig(uint256 i, bytes32 msg_) internal view returns (bytes memory sig, bytes32[] memory path) {
        sig = XMSSHelper.signWots(seed, i, msg_);
        path = XMSSHelper.authPath(leaves, i);
    }

    function test_validAtSeveralLeaves() public view {
        for (uint256 i = 0; i < 16; i += 5) {
            (bytes memory sig, bytes32[] memory path) = _sig(i, m);
            assertTrue(hx.verifyXmss(root, H, m, i, leaves[i], sig, path));
        }
    }

    function test_wrongPathRejected() public view {
        (bytes memory sig, bytes32[] memory path) = _sig(3, m);
        path[2] = bytes32(uint256(path[2]) ^ 1);
        assertFalse(hx.verifyXmss(root, H, m, 3, leaves[3], sig, path));
    }

    function test_wrongIndexRejected() public view {
        (bytes memory sig, bytes32[] memory path) = _sig(3, m);
        assertFalse(hx.verifyXmss(root, H, m, 2, leaves[3], sig, path));
        assertFalse(hx.verifyXmss(root, H, m, 3 + 16, leaves[3], sig, path)); // out of range
    }

    function test_wrongLeafPkRejected() public view {
        (bytes memory sig, bytes32[] memory path) = _sig(3, m);
        // Real leaf 4 with leaf 3's path: Merkle check fails.
        assertFalse(hx.verifyXmss(root, H, m, 3, leaves[4], sig, path));
    }

    function test_pathLengthMustEqualHeight() public view {
        (bytes memory sig, bytes32[] memory path) = _sig(3, m);
        bytes32[] memory short = new bytes32[](3);
        for (uint256 i = 0; i < 3; i++) short[i] = path[i];
        assertFalse(hx.verifyXmss(root, H, m, 3, leaves[3], sig, short));
        assertFalse(hx.verifyXmss(root, 0, m, 3, leaves[3], sig, path));
    }

    function test_tamperedWotsSigOrMessageRejected() public view {
        (bytes memory sig, bytes32[] memory path) = _sig(7, m);
        assertFalse(hx.verifyXmss(root, H, keccak256("other"), 7, leaves[7], sig, path));
        sig[100] = bytes1(uint8(sig[100]) ^ 0x01);
        assertFalse(hx.verifyXmss(root, H, m, 7, leaves[7], sig, path));
    }

    /// Gas: XMSS verify at h = 10 vs plain WOTS verify (same message, same WOTS key).
    function test_gas_h10_vs_wots() public view {
        uint256 h = 10;
        uint256 idx = 777;
        bytes32[] memory big = XMSSHelper.sparseLeaves(seed, h, idx);
        bytes32 r = XMSSHelper.root(big);
        bytes32[] memory path = XMSSHelper.authPath(big, idx);
        bytes memory sig = XMSSHelper.signWots(seed, idx, m);

        (bool okW, uint256 gW) = hx.gasWots(big[idx], m, sig);
        (bool okX, uint256 gX) = hx.gasXmss(r, h, m, idx, big[idx], sig, path);
        assertTrue(okW && okX);
        console.log("WOTS.verify gas", gW);
        console.log("XMSS.verify gas (h=10)", gX);
        console.log("XMSS - WOTS overhead", gX - gW);
        console.log("XMSS sig bytes (idx+leafPk+wots+path)", 32 + 32 + sig.length + 32 * h);
    }
}

contract XMSSAccountTest is Test {
    OptimisticAggregator agg;
    XMSSAccount acct;
    bytes32 seed = keccak256("sigpress-xmss-account");
    uint256 constant H = 4;
    bytes32[] leaves;
    address recipient = address(0xBEEF);
    uint256 constant AMOUNT = 0.0001 ether;
    uint256 constant BOND = 0.01 ether;
    uint256 constant WINDOW = 120;

    function setUp() public {
        agg = new OptimisticAggregator(BOND, WINDOW);
        leaves = XMSSHelper.realLeaves(seed, H);
        acct = new XMSSAccount(agg, XMSSHelper.root(leaves), H);
        vm.deal(address(acct), 1 ether);
        vm.deal(address(this), 1 ether);
    }

    function _signed(uint256 i) internal view returns (bytes memory sig, bytes32[] memory path) {
        bytes32 m = acct.messageFor(i, recipient, AMOUNT, "");
        sig = XMSSHelper.signWots(seed, i, m);
        path = XMSSHelper.authPath(leaves, i);
    }

    function test_constructorRejectsBadHeight() public {
        vm.expectRevert(XMSSAccount.BadHeight.selector);
        new XMSSAccount(agg, bytes32(0), 0);
        vm.expectRevert(XMSSAccount.BadHeight.selector);
        new XMSSAccount(agg, bytes32(0), 33);
    }

    function test_executeDirect() public {
        (bytes memory sig, bytes32[] memory path) = _signed(5);
        acct.executeDirect(5, leaves[5], recipient, AMOUNT, "", sig, path);
        assertEq(recipient.balance, AMOUNT);
        assertEq(acct.nonce(), 1);
        assertTrue(acct.isUsed(5));
        assertFalse(acct.isUsed(4));
        assertEq(acct.capacity(), 16);
    }

    function test_leafReuseRejected() public {
        (bytes memory sig, bytes32[] memory path) = _signed(5);
        acct.executeDirect(5, leaves[5], recipient, AMOUNT, "", sig, path);
        // A second (validly signed) message from the same leaf: the bitmap rejects it.
        (sig, path) = _signed(5);
        vm.expectRevert(abi.encodeWithSelector(XMSSAccount.LeafUsed.selector, 5));
        acct.executeDirect(5, leaves[5], recipient, AMOUNT, "", sig, path);
    }

    function test_replayRejected() public {
        (bytes memory sig, bytes32[] memory path) = _signed(2);
        acct.executeDirect(2, leaves[2], recipient, AMOUNT, "", sig, path);
        // Same signature again: nonce moved, so the message differs and the WOTS check fails.
        vm.expectRevert(XMSSAccount.InvalidSignature.selector);
        acct.executeDirect(2, leaves[2], recipient, AMOUNT, "", sig, path);
    }

    function test_wrongPathRejected() public {
        (bytes memory sig, bytes32[] memory path) = _signed(9);
        path[0] = bytes32(uint256(path[0]) ^ 1);
        vm.expectRevert(XMSSAccount.InvalidSignature.selector);
        acct.executeDirect(9, leaves[9], recipient, AMOUNT, "", sig, path);
    }

    function test_leavesUsableOutOfOrder() public {
        uint256[3] memory order = [uint256(11), 0, 15];
        for (uint256 k = 0; k < 3; k++) {
            (bytes memory sig, bytes32[] memory path) = _signed(order[k]);
            acct.executeDirect(order[k], leaves[order[k]], recipient, AMOUNT, "", sig, path);
        }
        assertEq(recipient.balance, 3 * AMOUNT);
        assertEq(acct.nonce(), 3);
    }

    function test_executeFromBatch() public {
        uint256 li = 6;
        bytes32 m = acct.messageFor(li, recipient, AMOUNT, "");
        bytes memory sig = XMSSHelper.signWots(seed, li, m);
        bytes32 leaf0 = agg.leafOf(leaves[li], m, sig);
        bytes32 leaf1 = keccak256("other op");
        bytes32 batchRoot = keccak256(abi.encodePacked(leaf0, leaf1));
        uint256 id = agg.submitBatch{value: BOND}(batchRoot, 2, "ipfs://x");
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = leaf1;
        bytes32[] memory path = XMSSHelper.authPath(leaves, li);

        vm.expectRevert(XMSSAccount.NotAccepted.selector); // not finalized yet
        acct.executeFromBatch(id, li, leaves[li], path, recipient, AMOUNT, "", 0, proof, keccak256(sig));

        vm.warp(block.timestamp + WINDOW);
        agg.finalize(id);
        acct.executeFromBatch(id, li, leaves[li], path, recipient, AMOUNT, "", 0, proof, keccak256(sig));
        assertEq(recipient.balance, AMOUNT);
        assertTrue(acct.isUsed(li));

        // A leafPk that is not in the account's tree is rejected before the batch lookup.
        vm.expectRevert(XMSSAccount.InvalidSignature.selector);
        acct.executeFromBatch(id, li, leaf1, path, recipient, AMOUNT, "", 0, proof, keccak256(sig));
    }

    receive() external payable {}
}

/// Gas: executeDirect on XMSSAccount (h = 10) vs PQAccount (plain WOTS, rotating key).
contract XMSSAccountGasTest is Test {
    function test_gas_executeDirect_h10_vs_PQAccount() public {
        OptimisticAggregator agg = new OptimisticAggregator(0.01 ether, 120);
        bytes32 seed = keccak256("gas");
        uint256 h = 10;
        address to = address(0xBEEF);
        vm.deal(to, 1); // recipient exists, so no new-account surcharge in op1

        // XMSS account, two ops on leaves 777 and 778 (same bitmap word: first write vs warm-word write).
        bytes32[] memory big = XMSSHelper.sparseLeaves(seed, h, 777);
        big[778] = XMSSHelper.leafPk(seed, 778);
        XMSSAccount x = new XMSSAccount(agg, XMSSHelper.root(big), h);
        vm.deal(address(x), 1 ether);
        uint256[2] memory gx;
        for (uint256 k = 0; k < 2; k++) {
            uint256 li = 777 + k;
            bytes32 m = x.messageFor(li, to, 1, "");
            bytes memory sig = XMSSHelper.signWots(seed, li, m);
            bytes32[] memory path = XMSSHelper.authPath(big, li);
            vm.cool(address(x)); // each op as its own tx: cold account and storage
            uint256 g0 = gasleft();
            x.executeDirect(li, big[li], to, 1, "", sig, path);
            gx[k] = g0 - gasleft();
        }

        // PQAccount (rotating WOTS), two ops.
        PQAccount p = new PQAccount(agg, WOTSHelper.pkHash(seed, 0));
        vm.deal(address(p), 1 ether);
        uint256[2] memory gp;
        for (uint32 k = 0; k < 2; k++) {
            bytes32 next = WOTSHelper.pkHash(seed, k + 1);
            bytes32 m = p.messageFor(next, to, 1, "");
            bytes memory sig = WOTSHelper.sign(seed, k, m);
            vm.cool(address(p));
            uint256 g0 = gasleft();
            p.executeDirect(next, to, 1, "", sig);
            gp[k] = g0 - gasleft();
        }
        // Call gas only: excludes the 21,000 base and calldata cost of the outer tx.
        console.log("XMSSAccount.executeDirect h=10 op1 (call gas)", gx[0]);
        console.log("XMSSAccount.executeDirect h=10 op2 (call gas)", gx[1]);
        console.log("PQAccount.executeDirect op1 (call gas)", gp[0]);
        console.log("PQAccount.executeDirect op2 (call gas)", gp[1]);
    }
}
