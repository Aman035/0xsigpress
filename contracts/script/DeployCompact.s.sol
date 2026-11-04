// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {OptimisticAggregator} from "../src/OptimisticAggregator.sol";
import {SigpressEntry} from "../src/SigpressEntry.sol";

/// forge script script/DeployCompact.s.sol --rpc-url monad_testnet --broadcast --slow
/// Env: KEY_VAR (name of the private-key env var, default PRIVATE_KEY_K9), WINDOW (seconds, default 120),
///      BOND (wei, default 0.5 ether), REVEAL_DEPOSIT (wei, default 0.05 ether), REVEAL_WINDOW (seconds, default 60),
///      BATCHES (reuse an OptimisticAggregator; default: deploy a new one).
///      Sizing rule: bond/2 (the challenger's share since SR-R2) must stay >= ~10x the worst-case gas cost of a
///      challenge or slashUnrevealed tx, or watchers lose money. A challenge measured ~0.021 MON on Monad
///      testnet, so the bond default is 0.5 MON. The reveal deposit is refunded to an answered requester; it
///      only needs to make spam requests cost something (see docs/security-review.md, SR-R1).
contract DeployCompact is Script {
    function run() external returns (OptimisticAggregator batches, SigpressEntry entry) {
        uint256 pk = vm.envUint(vm.envOr("KEY_VAR", string("PRIVATE_KEY_K9")));
        uint256 window = vm.envOr("WINDOW", uint256(120));
        uint256 bond = vm.envOr("BOND", uint256(0.5 ether));
        uint256 revealDeposit = vm.envOr("REVEAL_DEPOSIT", uint256(0.05 ether));
        uint256 revealWindow = vm.envOr("REVEAL_WINDOW", uint256(60));
        address reuse = vm.envOr("BATCHES", address(0));
        vm.startBroadcast(pk);
        batches = reuse == address(0) ? new OptimisticAggregator(bond, window, revealDeposit, revealWindow) : OptimisticAggregator(reuse);
        entry = new SigpressEntry(batches);
        vm.stopBroadcast();
        console.log("chainId", block.chainid);
        console.log("OptimisticAggregator", address(batches));
        console.log("SigpressEntry", address(entry));
        console.log("SigpressAccount impl", address(entry.accountImpl()));
    }
}
