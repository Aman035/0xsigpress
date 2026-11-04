// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PQAccount4337} from "./PQAccount4337.sol";
import {IEntryPoint} from "./IERC4337.sol";

/// @title PQAccount4337Factory
/// @notice CREATE2 factory for PQAccount4337. Address fixed by (initial pkHash, salt).
contract PQAccount4337Factory {
    event AccountCreated(address indexed account, bytes32 indexed pkHash, bytes32 salt);

    IEntryPoint public immutable entryPoint;
    address public immutable aggregator;

    constructor(IEntryPoint entryPoint_, address aggregator_) {
        entryPoint = entryPoint_;
        aggregator = aggregator_;
    }

    function create(bytes32 pkHash, bytes32 salt) external returns (PQAccount4337 account) {
        address a = addressOf(pkHash, salt);
        if (a.code.length > 0) return PQAccount4337(payable(a));
        account = new PQAccount4337{salt: salt}(entryPoint, aggregator, pkHash);
        emit AccountCreated(address(account), pkHash, salt);
    }

    function addressOf(bytes32 pkHash, bytes32 salt) public view returns (address) {
        bytes32 initHash =
            keccak256(abi.encodePacked(type(PQAccount4337).creationCode, abi.encode(entryPoint, aggregator, pkHash)));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initHash)))));
    }
}
