// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OptimisticAggregator} from "../src/OptimisticAggregator.sol";
import {PQAccount} from "../src/PQAccount.sol";
import {PQAccountFactory} from "../src/PQAccountFactory.sol";
import {WOTSHelper} from "./WOTSHelper.sol";

contract Reverter {
    error Nope();

    function boom() external pure {
        revert Nope();
    }
}

contract PQAccountTest is Test {
    OptimisticAggregator agg;
    PQAccountFactory factory;
    PQAccount acct;

    bytes32 seed = keccak256("sigpress-account-test");
    bytes32 otherSeed = keccak256("sigpress-other");
    uint256 constant BOND = 0.01 ether;
    uint256 constant WINDOW = 120;
    address aggregator = address(0xA66);
    address challenger = address(0xC4A1);
    address recipient = address(0xBEEF);
    uint256 constant AMOUNT = 0.0001 ether;

    // batch: leaf 0 = account transfer, leaves 1..3 = other ops
    bytes32[4] leaves;
    bytes32 sigHash0;
    bytes32 next1;

    function setUp() public {
        agg = new OptimisticAggregator(BOND, WINDOW);
        factory = new PQAccountFactory(agg);
        acct = factory.create(WOTSHelper.pkHash(seed, 0), bytes32(0));
        vm.deal(aggregator, 1 ether);
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(acct).call{value: 0.001 ether}("");
        require(ok);
        next1 = WOTSHelper.pkHash(seed, 1);
    }

    function _h(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(a, b));
    }

    function _proof(uint256 i) internal view returns (bytes32[] memory p) {
        p = new bytes32[](2);
        p[0] = leaves[i ^ 1];
        p[1] = i < 2 ? _h(leaves[2], leaves[3]) : _h(leaves[0], leaves[1]);
    }

    /// Builds and submits a 4-leaf batch; leaf 0 is the account's transfer. badOther = corrupt leaf 2's sig.
    function _submit(bool badOther) internal returns (uint256 id, bytes memory badSig, bytes32 badPk, bytes32 badM) {
        bytes32 m0 = acct.messageFor(next1, recipient, AMOUNT, "");
        bytes memory sig0 = WOTSHelper.sign(seed, 0, m0);
        sigHash0 = keccak256(sig0);
        leaves[0] = agg.leafOf(acct.pkHash(), m0, sig0);
        for (uint32 i = 1; i < 4; i++) {
            bytes32 pk = WOTSHelper.pkHash(otherSeed, i);
            bytes32 m = agg.messageOf(block.chainid, address(agg), pk, WOTSHelper.pkHash(otherSeed, i + 100), keccak256(abi.encode(i)));
            bytes memory sig = WOTSHelper.sign(otherSeed, i, m);
            if (badOther && i == 2) {
                sig[5] = bytes1(uint8(sig[5]) ^ 0x01);
                (badSig, badPk, badM) = (sig, pk, m);
            }
            leaves[i] = agg.leafOf(pk, m, sig);
        }
        bytes32 root = _h(_h(leaves[0], leaves[1]), _h(leaves[2], leaves[3]));
        vm.prank(aggregator);
        id = agg.submitBatch{value: BOND}(root, 4, "ipfs://batch");
    }

    function _exec(uint256 id) internal {
        acct.executeFromBatch(id, next1, recipient, AMOUNT, "", 0, _proof(0), sigHash0);
    }

    function test_receivesEth() public view {
        assertEq(address(acct).balance, 0.001 ether);
    }

    function test_factoryAddressAndIdempotent() public {
        bytes32 pk0 = WOTSHelper.pkHash(seed, 0);
        assertEq(factory.addressOf(pk0, bytes32(0)), address(acct));
        assertEq(address(factory.create(pk0, bytes32(0))), address(acct));
        assertTrue(factory.addressOf(pk0, bytes32(uint256(1))) != address(acct));
        assertEq(acct.pkHash(), pk0);
        assertEq(address(acct.aggregator()), address(agg));
    }

    function test_messageMatchesAggregator() public view {
        bytes32 payload = keccak256(abi.encode(address(acct), uint256(0), recipient, AMOUNT, keccak256("")));
        assertEq(acct.payloadHashOf(recipient, AMOUNT, ""), payload);
        assertEq(
            acct.messageFor(next1, recipient, AMOUNT, ""),
            agg.messageOf(block.chainid, address(agg), acct.pkHash(), next1, payload)
        );
    }

    function test_executeFromBatch_movesFundsAndRotates() public {
        (uint256 id,,,) = _submit(false);
        vm.warp(block.timestamp + WINDOW);
        agg.finalize(id);
        _exec(id);
        assertEq(recipient.balance, AMOUNT);
        assertEq(address(acct).balance, 0.001 ether - AMOUNT);
        assertEq(acct.pkHash(), next1);
        assertEq(acct.nonce(), 1);
    }

    function test_executeFromBatch_beforeFinalizeFails() public {
        (uint256 id,,,) = _submit(false);
        vm.expectRevert(PQAccount.NotAccepted.selector);
        _exec(id);
    }

    function test_executeFromBatch_replayFails() public {
        (uint256 id,,,) = _submit(false);
        vm.warp(block.timestamp + WINDOW);
        agg.finalize(id);
        _exec(id);
        vm.expectRevert(PQAccount.NotAccepted.selector);
        _exec(id);
    }

    function test_executeFromBatch_wrongOpFails() public {
        (uint256 id,,,) = _submit(false);
        vm.warp(block.timestamp + WINDOW);
        agg.finalize(id);
        vm.expectRevert(PQAccount.NotAccepted.selector);
        acct.executeFromBatch(id, next1, recipient, AMOUNT * 2, "", 0, _proof(0), sigHash0);
    }

    function test_slashedBatchCannotExecute() public {
        (uint256 id, bytes memory badSig, bytes32 badPk, bytes32 badM) = _submit(true);
        vm.prank(challenger);
        agg.challenge(id, badPk, badM, badSig, 2, _proof(2));
        vm.warp(block.timestamp + WINDOW);
        vm.expectRevert(OptimisticAggregator.AlreadySlashed.selector);
        agg.finalize(id);
        vm.expectRevert(PQAccount.NotAccepted.selector);
        _exec(id);
        assertEq(recipient.balance, 0);
        assertEq(acct.nonce(), 0);
    }

    function test_executeDirect_movesFundsAndRotates() public {
        bytes memory sig = WOTSHelper.sign(seed, 0, acct.messageFor(next1, recipient, AMOUNT, ""));
        acct.executeDirect(next1, recipient, AMOUNT, "", sig);
        assertEq(recipient.balance, AMOUNT);
        assertEq(acct.pkHash(), next1);
        assertEq(acct.nonce(), 1);
        // old signature cannot be replayed
        vm.expectRevert(PQAccount.InvalidSignature.selector);
        acct.executeDirect(next1, recipient, AMOUNT, "", sig);
        // next key signs the next op
        bytes32 next2 = WOTSHelper.pkHash(seed, 2);
        bytes memory sig1 = WOTSHelper.sign(seed, 1, acct.messageFor(next2, recipient, AMOUNT, ""));
        acct.executeDirect(next2, recipient, AMOUNT, "", sig1);
        assertEq(recipient.balance, 2 * AMOUNT);
        assertEq(acct.pkHash(), next2);
        assertEq(acct.nonce(), 2);
    }

    function test_executeDirect_badSigFails() public {
        bytes memory sig = WOTSHelper.sign(seed, 0, acct.messageFor(next1, recipient, AMOUNT, ""));
        sig[0] = bytes1(uint8(sig[0]) ^ 0x01);
        vm.expectRevert(PQAccount.InvalidSignature.selector);
        acct.executeDirect(next1, recipient, AMOUNT, "", sig);
    }

    function test_executeDirect_bubblesTargetRevert() public {
        Reverter r = new Reverter();
        bytes memory data = abi.encodeCall(Reverter.boom, ());
        bytes memory sig = WOTSHelper.sign(seed, 0, acct.messageFor(next1, address(r), 0, data));
        vm.expectRevert(Reverter.Nope.selector);
        acct.executeDirect(next1, address(r), 0, data, sig);
        assertEq(acct.nonce(), 0);
    }

    function test_batchThenDirect() public {
        (uint256 id,,,) = _submit(false);
        vm.warp(block.timestamp + WINDOW);
        agg.finalize(id);
        _exec(id);
        bytes32 next2 = WOTSHelper.pkHash(seed, 2);
        bytes memory sig1 = WOTSHelper.sign(seed, 1, acct.messageFor(next2, recipient, AMOUNT, ""));
        acct.executeDirect(next2, recipient, AMOUNT, "", sig1);
        assertEq(recipient.balance, 2 * AMOUNT);
        assertEq(acct.nonce(), 2);
    }
}
