// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EntryFixture} from "./EntryFixture.sol";
import {SigpressAccount} from "../../src/SigpressAccount.sol";

/// @dev Burns every unit of gas it is given.
contract GasBomb {
    fallback() external payable {
        while (true) {}
    }
}

/// @dev Needs about (n + 1) x 22k gas: n fresh storage writes plus the `done` flag.
contract Heavy {
    mapping(uint256 => uint256) public slots;
    bool public done;

    function work(uint256 n) external {
        for (uint256 i = 1; i <= n; i++) {
            slots[i] = i;
        }
        done = true;
    }
}

/// @notice SR-02 / SR-04: gas handling of op calls.
contract EntryGasTest is EntryFixture {
    function setUp() public {
        _deploy();
    }

    /// SR-02a: one op whose target burns all gas eats 63/64 of the bundle's gas, so the rest of the bundle runs
    /// out of gas at any tx gas limit up to Monad's 30M. Every other op in the batch is stuck.
    function test_gasBombOpDoesNotBrickBundle() public {
        _createAccounts(65);
        GasBomb bomb = new GasBomb();
        Op[] memory ops = new Op[](65);
        ops[0] = _sign(0, address(bomb), 0, "");
        for (uint32 i = 1; i < 65; i++) {
            ops[i] = _sign(i, recipient, AMOUNT, "");
        }
        uint256 id = _submitFinal(ops);
        uint256 before = recipient.balance;
        (bool ok,) = address(entry).call{gas: 30_000_000}(_bundle(id, ops));
        assertTrue(ok, "one gas-burning op bricks the bundle at 30M gas");
        assertEq(recipient.balance - before, 64 * AMOUNT);
        assertEq(_account(0).nonce(), 1); // the bomb op is used up (logged success = false)
    }

    /// SR-02b: anyone can call executeBundle. With a hand-picked gas limit a big op's call runs out of gas while
    /// the bundle still completes (the leftover 1/64 is enough for the tail): the op is used up (key rotated,
    /// nonce bumped) without having run. Property: the executor's gas choice must not change an op's outcome.
    function test_underfundedBundleCannotBurnOp() public {
        _checkBundleOutcomeIndependentOfGas(40); // ~900k gas op
        _checkBundleOutcomeIndependentOfGas(4); // ~110k gas op
    }

    function _checkBundleOutcomeIndependentOfGas(uint256 slots) internal {
        uint32 base = uint32(seeds.length);
        _createAccounts(2);
        Heavy heavy = new Heavy();
        Op[] memory ops = new Op[](2);
        ops[0] = _sign(base, recipient, AMOUNT, "");
        ops[1] = _sign(base + 1, address(heavy), 0, abi.encodeCall(Heavy.work, (slots)));
        uint256 id = _submitFinal(ops);
        bytes memory cd = _bundle(id, ops);
        bool ample = _doneAt(address(entry), cd, 25_000_000, heavy);
        uint256 g = _minGasThatSucceeds(address(entry), cd);
        bool tight = _doneAt(address(entry), cd, g, heavy);
        assertEq(tight, ample, "executor's gas choice changed the op outcome (op burned)");
    }

    /// SR-04: executeDirect is permissionless and the signature is public (DA document / mempool). With a
    /// hand-picked gas limit the call runs out of gas, the key still rotates, and the op is burned.
    function test_underfundedDirectCannotBurnOp() public {
        _createAccounts(1);
        Heavy heavy = new Heavy();
        Op memory op = _sign(0, address(heavy), 0, abi.encodeCall(Heavy.work, (40)));
        SigpressAccount a = _account(0);
        bytes memory cd = abi.encodeCall(SigpressAccount.executeDirect, (op.next, op.target, 0, op.data, op.sig));
        assertTrue(_doneAt(address(a), cd, 25_000_000, heavy), "op should run with ample gas");
        uint256 g = _minGasThatSucceeds(address(a), cd);
        assertTrue(_doneAt(address(a), cd, g, heavy), "op burned by an underfunded executeDirect");
    }

    /// @dev Run `cd` with `gas` in a snapshot; return whether it landed with heavy.done() set (state rolled back).
    function _doneAt(address to, bytes memory cd, uint256 gas, Heavy heavy) internal returns (bool done) {
        uint256 snap = vm.snapshotState();
        (bool ok,) = to.call{gas: gas}(cd);
        assertTrue(ok, "call should land");
        done = heavy.done();
        vm.revertToState(snap);
    }

    /// @dev Binary search for the smallest gas at which `to.call(cd)` succeeds (state rolled back each probe).
    function _minGasThatSucceeds(address to, bytes memory cd) internal returns (uint256) {
        uint256 lo = 21_000;
        uint256 hi = 25_000_000;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            uint256 snap = vm.snapshotState();
            (bool ok,) = to.call{gas: mid}(cd);
            vm.revertToState(snap);
            if (ok) hi = mid;
            else lo = mid + 1;
        }
        return lo;
    }
}

/// @notice Gas-limit overhead of the OP_GAS_LIMIT cap (SR-02). Monad charges the gas LIMIT, so what matters is
///         the smallest limit at which executeBundle succeeds versus the gas it actually uses. The cap's
///         pre-call check needs OP_GAS_LIMIT + OP_GAS_LIMIT/63 + CALL_OVERHEAD (~243k) left before each op's
///         call, which only binds on the LAST op: the overhead should be a one-time ~200-250k per bundle,
///         independent of the op count.
contract EntryGasOverheadTest is EntryFixture {
    function setUp() public {
        _deploy();
    }

    // One op count per test (a fresh EVM each, so 64 ops of WOTS signing fit in memory). The overhead is
    // bounded by the same constant for every count: it does not grow with the number of ops.
    uint256 constant MAX_OVERHEAD = 260_000;

    function test_gasLimitOverhead_4ops() public {
        assertLt(_overhead(4), MAX_OVERHEAD);
    }

    function test_gasLimitOverhead_32ops() public {
        assertLt(_overhead(32), MAX_OVERHEAD);
    }

    function test_gasLimitOverhead_64ops() public {
        assertLt(_overhead(64), MAX_OVERHEAD);
    }

    function _overhead(uint256 n) internal returns (uint256) {
        uint32 base = uint32(seeds.length);
        _createAccounts(n);
        Op[] memory ops = new Op[](n);
        for (uint32 i = 0; i < n; i++) {
            ops[i] = _sign(base + i, recipient, AMOUNT, "");
        }
        uint256 id = _submitFinal(ops);
        bytes memory cd = _bundle(id, ops);
        uint256 snap = vm.snapshotState();
        uint256 g0 = gasleft();
        (bool ok,) = address(entry).call{gas: 29_000_000}(cd);
        uint256 used = g0 - gasleft();
        vm.revertToState(snap);
        assertTrue(ok);
        uint256 lo = 21_000;
        uint256 hi = 29_000_000;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            uint256 s = vm.snapshotState();
            (bool k,) = address(entry).call{gas: mid}(cd);
            vm.revertToState(s);
            if (k) hi = mid;
            else lo = mid + 1;
        }
        emit log_named_uint(string.concat("ops ", vm.toString(n), ": gas used (inner call)"), used);
        emit log_named_uint(string.concat("ops ", vm.toString(n), ": min gas limit (inner call)"), lo);
        emit log_named_uint(string.concat("ops ", vm.toString(n), ": per-op used"), used / n);
        emit log_named_uint(string.concat("ops ", vm.toString(n), ": limit - used (cap overhead)"), lo - used);
        assertGt(lo - used, 200_000); // the last op's full OP_GAS_LIMIT must be available
        return lo - used;
    }
}
