// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Minimal ERC-4337 (EntryPoint v0.8) interfaces, written fresh from the ERC-4337 spec / on-chain ABI.
// Only the members Sigpress uses. No code copied from eth-infinitism/account-abstraction (GPL-3.0 repo).

/// @notice ERC-4337 v0.7+/v0.8 packed user operation.
/// accountGasLimits = verificationGasLimit (high 128 bits) | callGasLimit (low 128 bits).
/// gasFees = maxPriorityFeePerGas (high 128 bits) | maxFeePerGas (low 128 bits).
struct PackedUserOperation {
    address sender;
    uint256 nonce;
    bytes initCode;
    bytes callData;
    bytes32 accountGasLimits;
    uint256 preVerificationGas;
    bytes32 gasFees;
    bytes paymasterAndData;
    bytes signature;
}

/// @notice validationData = uint160 aggregator | uint48 validUntil << 160 | uint48 validAfter << 208.
/// aggregator 0 = signature valid, 1 = signature failed, other = the aggregator that must validate it.
interface IAccount {
    function validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash, uint256 missingAccountFunds)
        external
        returns (uint256 validationData);
}

interface IAggregator {
    /// @notice Reverts unless `signature` is a valid aggregated signature over `userOps`. Called by the EntryPoint.
    function validateSignatures(PackedUserOperation[] calldata userOps, bytes calldata signature) external;

    /// @notice Off-chain helper for bundlers: checks one op and returns the value for its signature field.
    function validateUserOpSignature(PackedUserOperation calldata userOp) external view returns (bytes memory);

    /// @notice Off-chain helper for bundlers: builds the aggregated signature.
    function aggregateSignatures(PackedUserOperation[] calldata userOps) external view returns (bytes memory);
}

struct UserOpsPerAggregator {
    PackedUserOperation[] userOps;
    IAggregator aggregator;
    bytes signature;
}

interface IEntryPoint {
    error FailedOp(uint256 opIndex, string reason);
    error FailedOpWithRevert(uint256 opIndex, string reason, bytes inner);
    error SignatureValidationFailed(address aggregator);

    function handleOps(PackedUserOperation[] calldata ops, address payable beneficiary) external;

    function handleAggregatedOps(UserOpsPerAggregator[] calldata opsPerAggregator, address payable beneficiary)
        external;

    function getUserOpHash(PackedUserOperation calldata userOp) external view returns (bytes32);

    function getNonce(address sender, uint192 key) external view returns (uint256);

    function depositTo(address account) external payable;

    function balanceOf(address account) external view returns (uint256);
}
