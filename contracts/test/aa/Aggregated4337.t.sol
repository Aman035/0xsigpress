// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {OptimisticAggregator} from "../../src/OptimisticAggregator.sol";
import {PackedUserOperation, UserOpsPerAggregator, IAggregator, IEntryPoint} from "../../src/aa/IERC4337.sol";
import {SigpressAggregator4337} from "../../src/aa/SigpressAggregator4337.sol";
import {PQAccount4337} from "../../src/aa/PQAccount4337.sol";
import {PQAccount4337Factory} from "../../src/aa/PQAccount4337Factory.sol";
import {WOTSHelper} from "../WOTSHelper.sol";

/// Runs against the real EntryPoint v0.8 deployed on Monad testnet (fork).
/// forge test --match-path test/aa/Aggregated4337.t.sol   (forks rpc_endpoints.monad_testnet)
contract Aggregated4337Test is Test {
    IEntryPoint constant EP = IEntryPoint(0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108);
    uint256 constant N = 4;
    uint256 constant WINDOW = 120;
    uint256 constant AMOUNT = 0.0001 ether;

    OptimisticAggregator batches;
    SigpressAggregator4337 sa;
    PQAccount4337Factory factory;
    PQAccount4337[N] accts;
    bytes32[N] seeds;

    address batcher = makeAddr("batcher");
    address bundler = makeAddr("bundler");
    address recipient = makeAddr("recipient");

    struct Built {
        PackedUserOperation[] ops;
        bytes32[] leaves;
        bytes32[] sigHashes;
    }

    function setUp() public {
        vm.createSelectFork("monad_testnet");
        require(address(EP).code.length > 0, "no EntryPoint v0.8 on fork");
        batches = new OptimisticAggregator(0.01 ether, WINDOW);
        sa = new SigpressAggregator4337(EP, batches);
        factory = new PQAccount4337Factory(EP, address(sa));
        for (uint256 i = 0; i < N; i++) {
            seeds[i] = keccak256(abi.encode("sigpress-4337-test", i));
            accts[i] = factory.create(WOTSHelper.pkHash(seeds[i], 0), bytes32(0));
            vm.deal(address(accts[i]), 1 ether);
        }
        vm.deal(batcher, 1 ether);
    }

    function _op(PQAccount4337 a, uint256 nonce, bytes32 next) internal view returns (PackedUserOperation memory op) {
        op.sender = address(a);
        op.nonce = nonce;
        op.callData = abi.encodeCall(PQAccount4337.execute, (recipient, AMOUNT, ""));
        op.accountGasLimits = bytes32((uint256(100_000) << 128) | 50_000);
        op.preVerificationGas = 50_000;
        op.gasFees = bytes32((uint256(1 gwei) << 128) | 102 gwei);
        op.signature = abi.encodePacked(next);
    }

    /// One op per (account, keyIndex) pair; signs m over the real userOpHash and builds the leaf.
    function _build(uint256[] memory who, uint32[] memory keyIdx, uint256[] memory nonces) internal view returns (Built memory b) {
        uint256 n = who.length;
        b.ops = new PackedUserOperation[](n);
        b.leaves = new bytes32[](n);
        b.sigHashes = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) {
            bytes32 pk = WOTSHelper.pkHash(seeds[who[i]], keyIdx[i]);
            bytes32 next = WOTSHelper.pkHash(seeds[who[i]], keyIdx[i] + 1);
            b.ops[i] = _op(accts[who[i]], nonces[i], next);
            bytes32 m = sa.messageOf(pk, next, EP.getUserOpHash(b.ops[i]));
            bytes memory sig = WOTSHelper.sign(seeds[who[i]], keyIdx[i], m);
            b.sigHashes[i] = keccak256(sig);
            b.leaves[i] = batches.leafOf(pk, m, sig);
        }
    }

    function _h(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(a, b));
    }

    /// Spec tree over up to 4 leaves (zero-padded to the next power of two, like merkle.ts).
    function _tree(bytes32[] memory leaves) internal pure returns (bytes32 root, bytes32[][] memory proofs) {
        if (leaves.length == 2) {
            root = _h(leaves[0], leaves[1]);
            proofs = new bytes32[][](2);
            for (uint256 i = 0; i < 2; i++) {
                proofs[i] = new bytes32[](1);
                proofs[i][0] = leaves[i ^ 1];
            }
            return (root, proofs);
        }
        bytes32[4] memory l;
        for (uint256 i = 0; i < leaves.length; i++) l[i] = leaves[i];
        bytes32 left = _h(l[0], l[1]);
        bytes32 right = _h(l[2], l[3]);
        root = _h(left, right);
        proofs = new bytes32[][](leaves.length);
        for (uint256 i = 0; i < leaves.length; i++) {
            proofs[i] = new bytes32[](2);
            proofs[i][0] = l[i ^ 1];
            proofs[i][1] = i < 2 ? right : left;
        }
    }

    function _submit(bytes32 root, uint32 count, bool finalize) internal returns (uint256 id) {
        vm.prank(batcher);
        id = batches.submitBatch{value: 0.01 ether}(root, count, "test");
        if (finalize) {
            vm.warp(block.timestamp + WINDOW + 1);
            batches.finalize(id);
        }
    }

    function _bundle(Built memory b, uint256 id, bytes32[][] memory proofs) internal view returns (UserOpsPerAggregator[] memory opas) {
        uint256[] memory idx = new uint256[](b.ops.length);
        for (uint256 i = 0; i < idx.length; i++) idx[i] = i;
        opas = new UserOpsPerAggregator[](1);
        opas[0] = UserOpsPerAggregator({
            userOps: b.ops,
            aggregator: IAggregator(address(sa)),
            signature: abi.encode(id, idx, proofs, b.sigHashes)
        });
    }

    function _fourOps() internal view returns (Built memory) {
        uint256[] memory who = new uint256[](N);
        uint32[] memory k = new uint32[](N);
        uint256[] memory nonces = new uint256[](N);
        for (uint256 i = 0; i < N; i++) {
            who[i] = i;
            nonces[i] = EP.getNonce(address(accts[i]), 0);
        }
        return _build(who, k, nonces);
    }

    function test_aggregatedBundleOfFourExecutes() public {
        Built memory b = _fourOps();
        (bytes32 root, bytes32[][] memory proofs) = _tree(b.leaves);
        uint256 id = _submit(root, uint32(N), true);
        UserOpsPerAggregator[] memory opas = _bundle(b, id, proofs);

        uint256 before = recipient.balance;
        bytes memory input = abi.encodeCall(IEntryPoint.handleAggregatedOps, (opas, payable(bundler)));
        uint256 g = gasleft();
        vm.prank(bundler, bundler);
        EP.handleAggregatedOps(opas, payable(bundler));
        g -= gasleft();

        assertEq(recipient.balance - before, AMOUNT * N);
        for (uint256 i = 0; i < N; i++) {
            assertEq(accts[i].pkHash(), WOTSHelper.pkHash(seeds[i], 1), "key rotated");
            assertEq(EP.getNonce(address(accts[i]), 0), 1);
        }
        console.log("handleAggregatedOps calldata bytes", input.length);
        console.log("handleAggregatedOps execution gas (fork)", g);
    }

    function test_revertsWhenBatchNotFinalized() public {
        Built memory b = _fourOps();
        (bytes32 root, bytes32[][] memory proofs) = _tree(b.leaves);
        uint256 id = _submit(root, uint32(N), false);
        UserOpsPerAggregator[] memory opas = _bundle(b, id, proofs);
        vm.prank(bundler, bundler);
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.SignatureValidationFailed.selector, address(sa)));
        EP.handleAggregatedOps(opas, payable(bundler));
    }

    function test_revertsOnWrongSigHash() public {
        Built memory b = _fourOps();
        (bytes32 root, bytes32[][] memory proofs) = _tree(b.leaves);
        uint256 id = _submit(root, uint32(N), true);
        b.sigHashes[2] = keccak256("not the signature");
        UserOpsPerAggregator[] memory opas = _bundle(b, id, proofs);
        vm.prank(bundler, bundler);
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.SignatureValidationFailed.selector, address(sa)));
        EP.handleAggregatedOps(opas, payable(bundler));
    }

    function test_revertsWhenOpChangedAfterSigning() public {
        Built memory b = _fourOps();
        (bytes32 root, bytes32[][] memory proofs) = _tree(b.leaves);
        uint256 id = _submit(root, uint32(N), true);
        b.ops[1].callData = abi.encodeCall(PQAccount4337.execute, (makeAddr("thief"), 1 ether, ""));
        UserOpsPerAggregator[] memory opas = _bundle(b, id, proofs);
        vm.prank(bundler, bundler);
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.SignatureValidationFailed.selector, address(sa)));
        EP.handleAggregatedOps(opas, payable(bundler));
    }

    function test_revertsOnRotatedKeyTamper() public {
        Built memory b = _fourOps();
        (bytes32 root, bytes32[][] memory proofs) = _tree(b.leaves);
        uint256 id = _submit(root, uint32(N), true);
        b.ops[3].signature = abi.encodePacked(keccak256("attacker key"));
        UserOpsPerAggregator[] memory opas = _bundle(b, id, proofs);
        vm.prank(bundler, bundler);
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.SignatureValidationFailed.selector, address(sa)));
        EP.handleAggregatedOps(opas, payable(bundler));
    }

    function test_revertsWithoutAggregator() public {
        Built memory b = _fourOps();
        vm.prank(bundler, bundler);
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA24 signature error"));
        EP.handleOps(b.ops, payable(bundler));
    }

    function test_twoOpsSameAccountChainKeys() public {
        uint256[] memory who = new uint256[](2);
        uint32[] memory k = new uint32[](2);
        uint256[] memory nonces = new uint256[](2);
        k[1] = 1;
        nonces[1] = 1;
        Built memory b = _build(who, k, nonces);
        (bytes32 root, bytes32[][] memory proofs) = _tree(b.leaves);
        uint256 id = _submit(root, 2, true);
        UserOpsPerAggregator[] memory opas = _bundle(b, id, proofs);
        vm.prank(bundler, bundler);
        EP.handleAggregatedOps(opas, payable(bundler));
        assertEq(accts[0].pkHash(), WOTSHelper.pkHash(seeds[0], 2));
        assertEq(recipient.balance, 2 * AMOUNT);
    }
}
