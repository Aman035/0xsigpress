// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OptimisticAggregator} from "../../src/OptimisticAggregator.sol";
import {SigpressEntry} from "../../src/SigpressEntry.sol";
import {SigpressAccount} from "../../src/SigpressAccount.sol";
import {WOTSHelper} from "../WOTSHelper.sol";

/// @notice Shared helpers for the security tests: SigpressEntry accounts, signed ops, roots, proofs, bundles.
abstract contract EntryFixture is Test {
    OptimisticAggregator agg;
    SigpressEntry entry;

    uint256 constant BOND = 0.01 ether;
    uint256 constant WINDOW = 120;
    uint256 constant AMOUNT = 0.0001 ether;
    address aggregator = address(0xA66);
    address challenger = address(0xC4A1);
    address recipient = address(0xBEEF);

    struct Op {
        uint32 index;
        address target;
        uint256 value;
        bytes data;
        uint256 nonce;
        bytes32 pk;
        bytes32 next;
        bytes32 m;
        bytes sig;
        bytes32 sigHash;
        bytes32 leaf;
    }

    bytes32[] seeds;
    uint256[] keyIndex;

    function _deploy() internal {
        agg = new OptimisticAggregator(BOND, WINDOW);
        entry = new SigpressEntry(agg);
        vm.deal(aggregator, 100 ether);
        vm.deal(address(this), 100 ether);
    }

    function _createAccounts(uint256 k) internal {
        bytes32[] memory pks = new bytes32[](k);
        for (uint256 i = 0; i < k; i++) {
            bytes32 s = keccak256(abi.encode("sigpress-security", seeds.length));
            seeds.push(s);
            keyIndex.push(0);
            pks[i] = WOTSHelper.pkHash(s, 0);
        }
        entry.createAccounts{value: k * 0.01 ether}(pks);
    }

    function _sign(uint32 index, address target, uint256 value, bytes memory data) internal returns (Op memory op) {
        bytes32 seed = seeds[index];
        uint256 k = keyIndex[index];
        keyIndex[index] = k + 1;
        address acct = entry.accountOf(index);
        op.index = index;
        op.target = target;
        op.value = value;
        op.data = data;
        op.nonce = k;
        op.pk = WOTSHelper.pkHash(seed, uint32(k));
        op.next = WOTSHelper.pkHash(seed, uint32(k + 1));
        bytes32 ph = keccak256(abi.encode(acct, k, target, value, keccak256(data)));
        op.m = agg.messageOf(block.chainid, address(entry), op.pk, op.next, ph);
        op.sig = WOTSHelper.sign(seed, uint32(k), op.m);
        op.sigHash = keccak256(op.sig);
        op.leaf = keccak256(abi.encodePacked(op.pk, op.m, op.sigHash));
    }

    function _wotsSign(uint32 index, uint32 k, bytes32 m) internal view returns (bytes memory) {
        return WOTSHelper.sign(seeds[index], k, m);
    }

    function _leaves(Op[] memory ops) internal pure returns (bytes32[] memory l) {
        l = new bytes32[](ops.length);
        for (uint256 i = 0; i < ops.length; i++) {
            l[i] = ops[i].leaf;
        }
    }

    function _rootOf(bytes32[] memory leaves) internal pure returns (bytes32) {
        uint256 size = 1;
        while (size < leaves.length) size <<= 1;
        bytes32[] memory nodes = new bytes32[](size);
        for (uint256 i = 0; i < leaves.length; i++) {
            nodes[i] = leaves[i];
        }
        for (uint256 n = size; n > 1; n >>= 1) {
            for (uint256 i = 0; i < n; i += 2) {
                nodes[i / 2] = keccak256(abi.encodePacked(nodes[i], nodes[i + 1]));
            }
        }
        return nodes[0];
    }

    function _proofOf(bytes32[] memory leaves, uint256 idx) internal pure returns (bytes32[] memory proof) {
        uint256 size = 1;
        uint256 depth;
        while (size < leaves.length) (size, depth) = (size << 1, depth + 1);
        bytes32[] memory nodes = new bytes32[](size);
        for (uint256 i = 0; i < leaves.length; i++) {
            nodes[i] = leaves[i];
        }
        proof = new bytes32[](depth);
        uint256 at = idx;
        for (uint256 lvl = 0; lvl < depth; lvl++) {
            proof[lvl] = nodes[at ^ 1];
            uint256 n = size >> lvl;
            for (uint256 i = 0; i < n; i += 2) {
                nodes[i / 2] = keccak256(abi.encodePacked(nodes[i], nodes[i + 1]));
            }
            at >>= 1;
        }
    }

    function _compactValue(uint256 v) internal pure returns (bytes memory out) {
        uint256 len;
        for (uint256 t = v; t > 0; t >>= 8) {
            len++;
        }
        out = new bytes(1 + len);
        out[0] = bytes1(uint8(len));
        for (uint256 i = 0; i < len; i++) {
            out[1 + i] = bytes1(uint8(v >> (8 * (len - 1 - i))));
        }
    }

    function _encodeOp(Op memory op) internal pure returns (bytes memory) {
        return abi.encodePacked(
            op.index, op.target, _compactValue(op.value), uint16(op.data.length), op.data, op.next, op.sigHash
        );
    }

    /// @dev Dead-op record (see SigpressEntry): flagged index, then the signed nonce, key, call and hashes.
    function _encodeDead(Op memory op) internal pure returns (bytes memory) {
        return abi.encodePacked(
            uint32(op.index) | uint32(0x80000000),
            op.nonce,
            op.pk,
            op.target,
            op.value,
            keccak256(op.data),
            op.next,
            op.sigHash
        );
    }

    /// @param dead bit i set = encode op i as a dead-op record.
    function _bundle(uint256 id, Op[] memory ops, uint256 dead) internal pure returns (bytes memory b) {
        b = abi.encodePacked(SigpressEntry.executeBundle.selector, uint32(id));
        for (uint256 i = 0; i < ops.length; i++) {
            b = bytes.concat(b, (dead >> i) & 1 == 1 ? _encodeDead(ops[i]) : _encodeOp(ops[i]));
        }
    }

    function _bundle(uint256 id, Op[] memory ops) internal pure returns (bytes memory) {
        return _bundle(id, ops, 0);
    }

    function _submitFinal(Op[] memory ops) internal returns (uint256 id) {
        vm.prank(aggregator);
        id = agg.submitBatch{value: BOND}(_rootOf(_leaves(ops)), uint32(ops.length), "sigpress-da:test");
        vm.warp(block.timestamp + WINDOW);
        agg.finalize(id);
    }

    function _account(uint32 index) internal view returns (SigpressAccount) {
        return SigpressAccount(payable(entry.accountOf(index)));
    }
}
