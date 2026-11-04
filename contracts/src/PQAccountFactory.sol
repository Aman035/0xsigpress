// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PQAccount} from "./PQAccount.sol";
import {OptimisticAggregator} from "./OptimisticAggregator.sol";

/// @title PQAccountFactory
/// @notice CREATE2 factory for PQAccount. The address is fixed by (initial pkHash, salt).
contract PQAccountFactory {
    event AccountCreated(address indexed account, bytes32 indexed pkHash, bytes32 salt);

    OptimisticAggregator public immutable aggregator;

    constructor(OptimisticAggregator aggregator_) {
        aggregator = aggregator_;
    }

    /// @notice Deploys the account, or returns it if it already exists.
    function create(bytes32 pkHash, bytes32 salt) external returns (PQAccount account) {
        address a = addressOf(pkHash, salt);
        if (a.code.length > 0) return PQAccount(payable(a));
        account = new PQAccount{salt: salt}(aggregator, pkHash);
        emit AccountCreated(address(account), pkHash, salt);
    }

    function addressOf(bytes32 pkHash, bytes32 salt) public view returns (address) {
        bytes32 initHash = keccak256(abi.encodePacked(type(PQAccount).creationCode, abi.encode(aggregator, pkHash)));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initHash)))));
    }
}
