// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {OptimisticAggregator} from "../src/OptimisticAggregator.sol";
import {IEntryPoint} from "../src/aa/IERC4337.sol";
import {SigpressAggregator4337} from "../src/aa/SigpressAggregator4337.sol";
import {PQAccount4337Factory} from "../src/aa/PQAccount4337Factory.sol";

/// KEY_VAR=PRIVATE_KEY_K8 forge script script/DeployAA.s.sol --rpc-url monad_testnet --broadcast --slow
/// Env: KEY_VAR (name of the private-key env var, default PRIVATE_KEY),
///      ENTRYPOINT (default v0.8 0x4337084D…f108), BATCHES (OptimisticAggregator, default the live testnet one).
contract DeployAA is Script {
    function run() external returns (SigpressAggregator4337 sa, PQAccount4337Factory factory) {
        uint256 pk = vm.envUint(vm.envOr("KEY_VAR", string("PRIVATE_KEY")));
        IEntryPoint ep = IEntryPoint(vm.envOr("ENTRYPOINT", address(0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108)));
        OptimisticAggregator batches =
            OptimisticAggregator(vm.envOr("BATCHES", address(0xEAA3AC4807767F8fe5B8caD979cB523A926b2A1E)));
        vm.startBroadcast(pk);
        sa = new SigpressAggregator4337(ep, batches);
        factory = new PQAccount4337Factory(ep, address(sa));
        vm.stopBroadcast();
        console.log("SigpressAggregator4337", address(sa));
        console.log("PQAccount4337Factory", address(factory));
    }
}
