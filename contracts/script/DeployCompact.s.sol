// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {OptimisticAggregator} from "../src/OptimisticAggregator.sol";
import {SigpressEntry} from "../src/SigpressEntry.sol";

/// forge script script/DeployCompact.s.sol --rpc-url monad_testnet --broadcast --slow
/// Env: KEY_VAR (name of the private-key env var, default PRIVATE_KEY_K9), WINDOW (seconds, default 120),
///      BOND (wei, default 0.001 ether), BATCHES (reuse an OptimisticAggregator; default: deploy a new one).
contract DeployCompact is Script {
    function run() external returns (OptimisticAggregator batches, SigpressEntry entry) {
        uint256 pk = vm.envUint(vm.envOr("KEY_VAR", string("PRIVATE_KEY_K9")));
        uint256 window = vm.envOr("WINDOW", uint256(120));
        uint256 bond = vm.envOr("BOND", uint256(0.001 ether));
        address reuse = vm.envOr("BATCHES", address(0));
        vm.startBroadcast(pk);
        batches = reuse == address(0) ? new OptimisticAggregator(bond, window) : OptimisticAggregator(reuse);
        entry = new SigpressEntry(batches);
        vm.stopBroadcast();
        console.log("chainId", block.chainid);
        console.log("OptimisticAggregator", address(batches));
        console.log("SigpressEntry", address(entry));
        console.log("SigpressAccount impl", address(entry.accountImpl()));
    }
}
