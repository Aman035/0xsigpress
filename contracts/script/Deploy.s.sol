// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {NaiveLane} from "../src/NaiveLane.sol";
import {OptimisticAggregator} from "../src/OptimisticAggregator.sol";
import {PQAccountFactory} from "../src/PQAccountFactory.sol";

/// forge script script/Deploy.s.sol --rpc-url monad_testnet --broadcast
/// Env: PRIVATE_KEY (required), WINDOW (challenge window in seconds, default 120), BOND (default 0.5 ether),
///      REVEAL_DEPOSIT (default 0.05 ether), REVEAL_WINDOW (seconds, default 60). See DeployCompact for sizing.
contract Deploy is Script {
    function run() external returns (NaiveLane lane, OptimisticAggregator agg, PQAccountFactory factory) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        uint256 window = vm.envOr("WINDOW", uint256(120));
        uint256 bond = vm.envOr("BOND", uint256(0.5 ether));
        uint256 revealDeposit = vm.envOr("REVEAL_DEPOSIT", uint256(0.05 ether));
        uint256 revealWindow = vm.envOr("REVEAL_WINDOW", uint256(60));
        vm.startBroadcast(pk);
        lane = new NaiveLane();
        agg = new OptimisticAggregator(bond, window, revealDeposit, revealWindow);
        factory = new PQAccountFactory(agg);
        vm.stopBroadcast();
        console.log("chainId", block.chainid);
        console.log("NaiveLane", address(lane));
        console.log("OptimisticAggregator", address(agg));
        console.log("PQAccountFactory", address(factory));
    }
}
