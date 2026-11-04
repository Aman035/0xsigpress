// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OptimisticAggregator} from "../../src/OptimisticAggregator.sol";
import {SigpressEntry} from "../../src/SigpressEntry.sol";

/// @notice SR-05 / SR-06: parameter and ETH-handling edge cases.
contract ParamsTest is Test {
    receive() external payable {}

    /// SR-05: deadline is uint64(block.timestamp + window). A window >= 2^64 silently truncates, so the
    /// challenge window can be zero (finalize at once) while the contract reports a huge window.
    function test_hugeWindowRejected() public {
        vm.expectRevert(bytes4(keccak256("BadWindow()")));
        new OptimisticAggregator(1, uint256(type(uint64).max) + 1, 0.001 ether, 60);
    }

    function test_hugeWindowWouldTruncate() public {
        uint256 w = uint256(type(uint64).max) + 1; // truncates to deadline = block.timestamp
        try new OptimisticAggregator(1, w, 0.001 ether, 60) returns (OptimisticAggregator agg) {
            uint256 id = agg.submitBatch{value: 1}(bytes32(uint256(1)), 1, "");
            vm.expectRevert(OptimisticAggregator.WindowOpen.selector);
            agg.finalize(id); // must still be inside the window
        } catch {}
    }

    /// SR-06: createAccounts([]) with value keeps the ETH in SigpressEntry, which has no way to send it out.
    function test_createNoAccountsWithValueReverts() public {
        SigpressEntry entry = new SigpressEntry(new OptimisticAggregator(1, 120, 0.001 ether, 60));
        vm.deal(address(this), 1 ether);
        vm.expectRevert(bytes4(keccak256("NoAccounts()")));
        entry.createAccounts{value: 1 ether}(new bytes32[](0));
        assertEq(address(entry).balance, 0);
    }

    function test_createNoAccountsWithoutValueIsNoop() public {
        SigpressEntry entry = new SigpressEntry(new OptimisticAggregator(1, 120, 0.001 ether, 60));
        assertEq(entry.createAccounts(new bytes32[](0)), 0);
        assertEq(entry.accountCount(), 0);
    }
}
