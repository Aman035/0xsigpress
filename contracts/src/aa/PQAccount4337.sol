// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PackedUserOperation, IAccount, IEntryPoint} from "./IERC4337.sol";

/// @title PQAccount4337
/// @notice ERC-4337 account owned by a one-time WOTS key (pkHash). It never checks a signature itself:
///         validateUserOp names `aggregator` in validationData, so the EntryPoint only accepts the op through
///         handleAggregatedOps with that aggregator, which checks the op's leaf is in an accepted batch.
///         Every op rotates the key to nextPkHash = userOp.signature (32 bytes), which the WOTS message binds.
contract PQAccount4337 is IAccount {
    error NotEntryPoint();

    event KeyRotated(bytes32 indexed pkHash, bytes32 indexed nextPkHash);

    IEntryPoint public immutable entryPoint;
    address public immutable aggregator;
    bytes32 public pkHash;

    constructor(IEntryPoint entryPoint_, address aggregator_, bytes32 pkHash_) {
        entryPoint = entryPoint_;
        aggregator = aggregator_;
        pkHash = pkHash_;
    }

    modifier onlyEntryPoint() {
        if (msg.sender != address(entryPoint)) revert NotEntryPoint();
        _;
    }

    receive() external payable {}

    /// @inheritdoc IAccount
    function validateUserOp(PackedUserOperation calldata userOp, bytes32, uint256 missingAccountFunds)
        external
        onlyEntryPoint
        returns (uint256 validationData)
    {
        if (userOp.signature.length != 32) return 1; // SIG_VALIDATION_FAILED
        bytes32 next = bytes32(userOp.signature);
        emit KeyRotated(pkHash, next);
        pkHash = next;
        if (missingAccountFunds > 0) {
            (bool ok,) = payable(msg.sender).call{value: missingAccountFunds}("");
            (ok); // the EntryPoint checks the deposit itself
        }
        return uint256(uint160(aggregator));
    }

    function execute(address target, uint256 value, bytes calldata data) external onlyEntryPoint {
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
    }
}
