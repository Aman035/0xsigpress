// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {NaiveLane} from "../src/NaiveLane.sol";
import {OptimisticAggregator} from "../src/OptimisticAggregator.sol";

/// forge script script/Deploy.s.sol --rpc-url monad_testnet --broadcast
contract Deploy is Script {
    function run() external returns (NaiveLane lane, OptimisticAggregator agg) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);
        lane = new NaiveLane();
        agg = new OptimisticAggregator(0.01 ether, 120);
        vm.stopBroadcast();
        console.log("chainId", block.chainid);
        console.log("NaiveLane", address(lane));
        console.log("OptimisticAggregator", address(agg));
    }
}
