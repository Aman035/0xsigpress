// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// ABI-identical to LeanVmTwoCommitmentTerminalVerifier.Proof (sol-whir-p3) so calldata matches.
interface ILeanVmTerminalC1 {
    struct Proof {
        bytes transcript;
        bytes openings;
        uint256[8] applicationRoot;
        uint256[] sparkPoint;
        uint256 sparkValue;
        uint256[] liftPoint;
        uint256 liftValue;
        uint256 rootValue;
    }

    function verifyC1V1(Proof calldata proof) external view returns (bool);
}

/// sigpress research gate (K10-terminal). Binds a verified terminal proof to two 32-byte batch roots.
///
/// What is bound: the terminal verifier authenticates `proof.applicationRoot` (8 KoalaBear words) as the
/// public memory of the root program, i.e. Poseidon1("NOD1", 2, leftDigest, rightDigest), where each
/// digest is the leanXMSS aggregation program's public input for one batch (N signers over one 32-byte
/// message = the batch root). This contract checks that root equals the value registered for the pair.
///
/// What is NOT bound on chain yet: the mapping (leftBatchRoot, rightBatchRoot) -> applicationRoot is
/// computed off chain (Poseidon1 over KoalaBear, includes the signer-set hash and slot) and registered
/// by `registrar`. A verifier would recompute it from the batch data before trusting a registration.
contract SigpressTerminalGate {
    ILeanVmTerminalC1 public immutable verifier;
    address public immutable registrar;

    mapping(bytes32 pairKey => bytes32 rootHash) public registeredRoot;
    mapping(bytes32 pairKey => bool) public accepted;

    event RootRegistered(bytes32 indexed leftBatchRoot, bytes32 indexed rightBatchRoot, uint256[8] applicationRoot);
    event BatchPairAccepted(bytes32 indexed leftBatchRoot, bytes32 indexed rightBatchRoot, bytes32 rootHash);

    constructor(ILeanVmTerminalC1 verifier_) {
        verifier = verifier_;
        registrar = msg.sender;
    }

    function pairKey(bytes32 leftBatchRoot, bytes32 rightBatchRoot) public pure returns (bytes32) {
        return keccak256(abi.encode(leftBatchRoot, rightBatchRoot));
    }

    function register(bytes32 leftBatchRoot, bytes32 rightBatchRoot, uint256[8] calldata applicationRoot)
        external
    {
        require(msg.sender == registrar, "NOT_REGISTRAR");
        bytes32 key = pairKey(leftBatchRoot, rightBatchRoot);
        require(registeredRoot[key] == bytes32(0), "ALREADY_REGISTERED");
        registeredRoot[key] = keccak256(abi.encode(applicationRoot));
        emit RootRegistered(leftBatchRoot, rightBatchRoot, applicationRoot);
    }

    function submit(ILeanVmTerminalC1.Proof calldata proof, bytes32 leftBatchRoot, bytes32 rightBatchRoot)
        external
    {
        bytes32 key = pairKey(leftBatchRoot, rightBatchRoot);
        bytes32 rootHash = keccak256(abi.encode(proof.applicationRoot));
        require(registeredRoot[key] != bytes32(0) && registeredRoot[key] == rootHash, "ROOT_MISMATCH");
        require(verifier.verifyC1V1(proof), "PROOF_REJECTED");
        accepted[key] = true;
        emit BatchPairAccepted(leftBatchRoot, rightBatchRoot, rootHash);
    }
}
