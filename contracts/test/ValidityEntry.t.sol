// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ValidityEntry, ValidityAccount, IBindV2Gate} from "../src/ValidityEntry.sol";

/// Stands in for SigpressBindV2Gate: `accepted` is what the real gate sets after verifying the STARK and the
/// binding (tested with real proofs in experiments/k10-terminal/binding-v2/test).
contract MockGate is IBindV2Gate {
    mapping(bytes32 => bool) public accepted;

    function accept(bytes32 c) external {
        accepted[c] = true;
    }
}

contract Sink {
    uint256 public hits;
    uint256 public got;

    function hit(uint256 x) external payable {
        hits += 1;
        got += x + msg.value;
    }

    function boom() external pure {
        revert("nope");
    }

    function burn() external pure {
        while (true) {}
    }
}

contract ValidityEntryTest is Test {
    MockGate gate;
    ValidityEntry entry;
    Sink sink;
    uint32 constant SLOT = 9;
    bytes32 constant PK_A = bytes32(uint256(0xA11CE));
    bytes32 constant PK_B = bytes32(uint256(0xB0B));
    address a;
    address b;

    function setUp() public {
        gate = new MockGate();
        entry = new ValidityEntry(gate);
        sink = new Sink();
        a = entry.createAccount{value: 1 ether}(PK_A, bytes32(0));
        b = entry.createAccount(PK_B, bytes32(0));
    }

    function _op(address acct, uint256 nonce, bytes memory data, uint8 side, uint32 index)
        internal
        pure
        returns (ValidityEntry.Op memory o)
    {
        o = ValidityEntry.Op({account: acct, nonce: nonce, target: address(0), value: 0, data: data, side: side, index: index});
    }

    /// left = [filler, A], right = [B, filler]; messages are the op hashes (fillers: arbitrary).
    function _batch(ValidityEntry.Op[] memory ops)
        internal
        view
        returns (ValidityEntry.Signers memory l, ValidityEntry.Signers memory r)
    {
        l.pubkeys = new bytes32[](2);
        l.messages = new bytes32[](2);
        r.pubkeys = new bytes32[](2);
        r.messages = new bytes32[](2);
        l.pubkeys[0] = bytes32(uint256(1));
        l.messages[0] = keccak256("filler-0");
        r.pubkeys[1] = bytes32(uint256(2));
        r.messages[1] = keccak256("filler-1");
        for (uint256 i; i < ops.length; ++i) {
            ValidityEntry.Op memory o = ops[i];
            bytes32 m = entry.opHash(o.account, o.nonce, o.target, o.value, o.data);
            if (o.side == 0) {
                l.pubkeys[o.index] = entry.keyOf(o.account);
                l.messages[o.index] = m;
            } else {
                r.pubkeys[o.index] = entry.keyOf(o.account);
                r.messages[o.index] = m;
            }
        }
    }

    function _twoOps() internal view returns (ValidityEntry.Op[] memory ops) {
        ops = new ValidityEntry.Op[](2);
        ops[0] = _op(a, 0, abi.encodeCall(Sink.hit, (7)), 0, 1);
        ops[0].target = address(sink);
        ops[0].value = 0.1 ether;
        ops[1] = _op(b, 0, abi.encodeCall(Sink.hit, (5)), 1, 0);
        ops[1].target = address(sink);
    }

    function test_registryBindsAccountToKey() public {
        assertEq(entry.keyOf(a), PK_A);
        assertEq(entry.keyOf(b), PK_B);
        assertEq(entry.accountAddress(PK_A, bytes32(0)), a);
        vm.prank(a);
        vm.expectRevert(ValidityEntry.KeyAlreadySet.selector);
        entry.registerKey(PK_B);
        vm.expectRevert(ValidityEntry.ZeroKey.selector);
        entry.registerKey(bytes32(0));
    }

    function test_accept_executesOpsFromAcceptedBatch() public {
        ValidityEntry.Op[] memory ops = _twoOps();
        (ValidityEntry.Signers memory l, ValidityEntry.Signers memory r) = _batch(ops);
        bytes32 c = entry.commitmentOf(SLOT, l, r);
        gate.accept(c);
        vm.expectEmit(true, true, false, true);
        emit ValidityEntry.OpExecuted(c, a, 0, true);
        vm.expectEmit(true, true, false, true);
        emit ValidityEntry.OpExecuted(c, b, 0, true);
        assertEq(entry.execute(SLOT, l, r, ops), c);
        assertEq(sink.hits(), 2);
        assertEq(sink.got(), 12 + 0.1 ether);
        assertEq(address(sink).balance, 0.1 ether);
        assertEq(entry.nonceOf(a), 1);
        assertEq(entry.nonceOf(b), 1);
    }

    function test_commitmentMatchesGateEncoding() public view {
        ValidityEntry.Op[] memory ops = _twoOps();
        (ValidityEntry.Signers memory l, ValidityEntry.Signers memory r) = _batch(ops);
        // SigpressBindV2Gate.batchCommitment: keccak256(abi.encode(slot, l.pubkeys, l.messages, r.pubkeys, r.messages))
        assertEq(entry.commitmentOf(SLOT, l, r), keccak256(abi.encode(SLOT, l.pubkeys, l.messages, r.pubkeys, r.messages)));
    }

    function test_rejectsBatchTheGateDidNotAccept() public {
        ValidityEntry.Op[] memory ops = _twoOps();
        (ValidityEntry.Signers memory l, ValidityEntry.Signers memory r) = _batch(ops);
        vm.expectRevert(ValidityEntry.NotAccepted.selector);
        entry.execute(SLOT, l, r, ops);
        gate.accept(entry.commitmentOf(SLOT, l, r));
        vm.expectRevert(ValidityEntry.NotAccepted.selector); // other slot = other commitment
        entry.execute(SLOT + 1, l, r, ops);
    }

    function test_wrongPubkey_opPointsAtAnotherSigner() public {
        ValidityEntry.Op[] memory ops = _twoOps();
        (ValidityEntry.Signers memory l, ValidityEntry.Signers memory r) = _batch(ops);
        gate.accept(entry.commitmentOf(SLOT, l, r));
        ops[0].index = 0; // the filler's slot: its pubkey is not A's
        vm.expectRevert(ValidityEntry.WrongPubkey.selector);
        entry.execute(SLOT, l, r, ops);
        ops[0].index = 1;
        ops[0].account = b; // B's key is not at left[1]
        vm.expectRevert(ValidityEntry.WrongPubkey.selector);
        entry.execute(SLOT, l, r, ops);
    }

    function test_wrongPubkey_keySignedForOtherAccountCannotRunIt() public {
        // An attacker contract registers A's pubkey for itself: A's signed op names account a, so it can't be
        // replayed for the attacker, and the attacker can't build a message A signed for it.
        ValidityEntry.Op[] memory ops = _twoOps();
        (ValidityEntry.Signers memory l, ValidityEntry.Signers memory r) = _batch(ops);
        gate.accept(entry.commitmentOf(SLOT, l, r));
        address evil = entry.createAccount(PK_A, bytes32(uint256(666)));
        ops[0].account = evil;
        vm.expectRevert(ValidityEntry.WrongMessage.selector);
        entry.execute(SLOT, l, r, ops);
    }

    function test_wrongMessage_changedTargetValueOrData() public {
        ValidityEntry.Op[] memory ops = _twoOps();
        (ValidityEntry.Signers memory l, ValidityEntry.Signers memory r) = _batch(ops);
        gate.accept(entry.commitmentOf(SLOT, l, r));
        ValidityEntry.Op memory good = ops[0];
        ops[0].value = 0.2 ether;
        vm.expectRevert(ValidityEntry.WrongMessage.selector);
        entry.execute(SLOT, l, r, ops);
        ops[0] = good;
        ops[0].data = abi.encodeCall(Sink.hit, (8));
        vm.expectRevert(ValidityEntry.WrongMessage.selector);
        entry.execute(SLOT, l, r, ops);
        ops[0] = good;
        ops[0].target = address(0xdead);
        vm.expectRevert(ValidityEntry.WrongMessage.selector);
        entry.execute(SLOT, l, r, ops);
    }

    function test_replay_sameBatchTwice() public {
        ValidityEntry.Op[] memory ops = _twoOps();
        (ValidityEntry.Signers memory l, ValidityEntry.Signers memory r) = _batch(ops);
        gate.accept(entry.commitmentOf(SLOT, l, r));
        entry.execute(SLOT, l, r, ops);
        vm.expectRevert(ValidityEntry.BadNonce.selector);
        entry.execute(SLOT, l, r, ops);
        assertEq(sink.hits(), 2);
    }

    function test_replay_sameOpInALaterBatch() public {
        ValidityEntry.Op[] memory ops = _twoOps();
        (ValidityEntry.Signers memory l, ValidityEntry.Signers memory r) = _batch(ops);
        gate.accept(entry.commitmentOf(SLOT, l, r));
        entry.execute(SLOT, l, r, ops);
        // The same signed (pubkey, message) proven again at another slot: the nonce in the message is used.
        gate.accept(entry.commitmentOf(SLOT + 1, l, r));
        vm.expectRevert(ValidityEntry.BadNonce.selector);
        entry.execute(SLOT + 1, l, r, ops);
    }

    function test_unregisteredAccountAndBadIndex() public {
        ValidityEntry.Op[] memory ops = _twoOps();
        (ValidityEntry.Signers memory l, ValidityEntry.Signers memory r) = _batch(ops);
        gate.accept(entry.commitmentOf(SLOT, l, r));
        ValidityEntry.Op memory good = ops[0];
        ops[0].account = address(0xbeef);
        vm.expectRevert(ValidityEntry.NoKey.selector);
        entry.execute(SLOT, l, r, ops);
        ops[0] = good;
        ops[0].index = 2;
        vm.expectRevert(ValidityEntry.BadIndex.selector);
        entry.execute(SLOT, l, r, ops);
        ops[0] = good;
        ops[0].side = 2;
        vm.expectRevert(ValidityEntry.BadIndex.selector);
        entry.execute(SLOT, l, r, ops);
    }

    function test_eoaWithRegisteredKeyIsNotAnAccount() public {
        address eoa = address(0xE0A);
        bytes32 pk = bytes32(uint256(0xE0A));
        vm.prank(eoa);
        entry.registerKey(pk);
        ValidityEntry.Op[] memory ops = new ValidityEntry.Op[](1);
        ops[0] = _op(eoa, 0, "", 0, 1);
        (ValidityEntry.Signers memory l, ValidityEntry.Signers memory r) = _batch(ops);
        gate.accept(entry.commitmentOf(SLOT, l, r));
        vm.expectRevert(ValidityEntry.NotAccount.selector);
        entry.execute(SLOT, l, r, ops);
    }

    function test_failingCallUsesNonceAndBatchContinues() public {
        ValidityEntry.Op[] memory ops = _twoOps();
        ops[0].data = abi.encodeCall(Sink.boom, ());
        ops[0].value = 0;
        ops[1].data = abi.encodeCall(Sink.burn, ()); // runs out of its OP_GAS
        (ValidityEntry.Signers memory l, ValidityEntry.Signers memory r) = _batch(ops);
        bytes32 c = entry.commitmentOf(SLOT, l, r);
        gate.accept(c);
        vm.expectEmit(true, true, false, true);
        emit ValidityEntry.OpExecuted(c, a, 0, false);
        vm.expectEmit(true, true, false, true);
        emit ValidityEntry.OpExecuted(c, b, 0, false);
        entry.execute(SLOT, l, r, ops);
        assertEq(entry.nonceOf(a), 1);
        assertEq(entry.nonceOf(b), 1);
    }

    function test_onlyEntryCanDriveTheAccount() public {
        vm.expectRevert(ValidityAccount.OnlyEntry.selector);
        ValidityAccount(payable(a)).exec(address(sink), 1 ether, "");
    }
}
