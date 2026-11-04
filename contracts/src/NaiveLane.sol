// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {WOTS} from "./WOTS.sol";

/// @title NaiveLane
/// @notice Baseline: every post-quantum signature is verified on chain, one per transaction.
contract NaiveLane {
    error InvalidSignature();

    event Verified(bytes32 indexed pkHash, bytes32 m);

    function submit(bytes32 pkHash, bytes32 m, bytes calldata sig) external {
        if (!WOTS.verify(pkHash, m, sig)) revert InvalidSignature();
        emit Verified(pkHash, m);
    }
}
