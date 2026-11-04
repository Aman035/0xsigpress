// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EntryFixture} from "./EntryFixture.sol";
import {SigpressEntry} from "../../src/SigpressEntry.sol";
import {SigpressAccount} from "../../src/SigpressAccount.sol";

/// @notice SR-01: one account moving its nonce outside the bundle (e.g. running its batched op through
///         executeDirect, which anyone holding the published signature can do) must not brick the whole batch.
contract EntryDeadOpTest is EntryFixture {
    function setUp() public {
        _deploy();
    }

    function test_directRunOfOneOpDoesNotBrickBatch() public {
        _createAccounts(4);
        Op[] memory ops = new Op[](4);
        for (uint32 i = 0; i < 4; i++) {
            ops[i] = _sign(i, recipient, AMOUNT, "");
        }
        uint256 id = _submitFinal(ops);

        // a third party (the signature is in the public DA document) runs op 1 directly
        vm.prank(address(0xBAD));
        _account(1).executeDirect(ops[1].next, recipient, AMOUNT, "", ops[1].sig);

        // the plain bundle can no longer match the root
        (bool ok, bytes memory ret) = address(entry).call(_bundle(id, ops));
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(SigpressEntry.RootMismatch.selector));

        // the bundle with op 1 as a dead-op record still executes the other three
        uint256 before = recipient.balance;
        (ok, ret) = address(entry).call(_bundle(id, ops, 1 << 1));
        assertTrue(ok, "batch bricked by one direct op");
        assertEq(recipient.balance - before, 3 * AMOUNT);
        assertTrue(entry.executed(id));
        assertEq(_account(1).nonce(), 1, "dead op must not run again");
        for (uint32 i = 0; i < 4; i++) {
            assertEq(_account(i).nonce(), 1);
        }
    }

    function test_rotatedAwayKeyIsDeadToo() public {
        // The batch holds account 0's op at nonce 1, signed by key 1 (the next key of a nonce-0 op the wallet
        // planned). The account instead ran a different nonce-0 op that rotated to an unrelated key, so at
        // nonce 1 the stored key differs: the batched op can never run and must be skippable.
        _createAccounts(2);
        Op memory planned0 = _sign(0, recipient, AMOUNT, ""); // nonce 0, next = key 1 (never batched)
        Op[] memory ops = new Op[](2);
        ops[0] = _sign(0, recipient, AMOUNT, ""); // nonce 1, signed by key 1
        ops[1] = _sign(1, recipient, AMOUNT, "");
        uint256 id = _submitFinal(ops);
        bytes32 otherNext = keccak256("other key");
        bytes32 m = _account(0).messageFor(otherNext, recipient, 2 * AMOUNT, "");
        _account(0).executeDirect(otherNext, recipient, 2 * AMOUNT, "", _wotsSign(0, 0, m));
        assertEq(_account(0).nonce(), 1);
        assertTrue(_account(0).pkHash() != planned0.next);
        (bool ok, bytes memory ret) = address(entry).call(_bundle(id, ops, 1));
        assertTrue(ok, string(ret));
        assertEq(_account(0).nonce(), 1);
        assertEq(_account(1).nonce(), 1);
    }

    function test_liveOpCannotBeSkipped() public {
        _createAccounts(2);
        Op[] memory ops = new Op[](2);
        ops[0] = _sign(0, recipient, AMOUNT, "");
        ops[1] = _sign(1, recipient, AMOUNT, "");
        uint256 id = _submitFinal(ops);
        // a griefer tries to mark a live op dead (censoring it while using up the batch)
        (bool ok, bytes memory ret) = address(entry).call(_bundle(id, ops, 1));
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(bytes4(keccak256("OpNotDead(uint256)")), 0));
        assertFalse(entry.executed(id));
    }

    function test_forgedDeadRecordFailsRoot() public {
        _createAccounts(2);
        Op[] memory ops = new Op[](2);
        ops[0] = _sign(0, recipient, AMOUNT, "");
        ops[1] = _sign(1, recipient, AMOUNT, "");
        uint256 id = _submitFinal(ops);
        _account(0).executeDirect(ops[0].next, recipient, AMOUNT, "", ops[0].sig);
        // dead record with a wrong nonce or key no longer rebuilds the committed leaf
        Op[] memory t = new Op[](2);
        t[0] = ops[0];
        t[1] = ops[1];
        t[0].pk = keccak256("not the key");
        (bool ok, bytes memory ret) = address(entry).call(_bundle(id, t, 1));
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(SigpressEntry.RootMismatch.selector));
    }
}
