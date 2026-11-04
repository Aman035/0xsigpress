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

/// sigpress research gate (K10 binding). One tx: verify the Keccak terminal proof AND recompute, from
/// calldata, the statement the proof is about. No registrar.
///
/// Statement (patched leanVM aggregation program, see binding/patches): for each of two batches, every
/// signer i holds a leanXMSS signature at `slot` by public key pk_i over its own 32-byte message m_i.
/// The terminal verifier authenticates proof.applicationRoot = Poseidon1 hash of the two child digests;
/// this contract recomputes that root from (slot, pubkeys, messages) with Poseidon1 over KoalaBear:
///   child = hash_slice([1, n, 0*6] | K | hash_slice(pk_0..pk_n-1) | hash_slice(H(m_0)..H(m_n-1))
///                      | merkle_chunks(slot) | 0*8)
///   root  = hash_slice([NOD1, 2, 0*6] | left | right)
/// with H = xmss::hash_message (domain-separated Poseidon1 compression of the message's base-p embedding)
/// and K = 128 constant words of the fixed aggregation program (zero bytecode claim for a raw-only batch,
/// Fiat-Shamir domain separator). K is a deploy-time constant like the verifier's pinned programs: a wrong
/// K makes every proof fail, it cannot make a false statement pass.
///
/// Pubkey encoding: bytes32 = 8 big-endian uint32 KoalaBear limbs [merkle_root(4) | public_param(4)],
/// each < p. Messages: raw 32 bytes (e.g. a userOp hash).
contract SigpressValidityGate {
    /// One batch: signer i's pubkey and its own 32-byte message, same order.
    struct Batch {
        bytes32[] pubkeys;
        bytes32[] messages;
    }

    uint256 internal constant P = 2_130_706_433;
    uint256 internal constant NOD1 = 1_313_817_649;
    uint256 internal constant DOMAINSEP_MESSAGE_HASH = 1004;
    uint256 internal constant N_CONST_CHUNKS = 16;
    uint256 internal constant PREIMAGE_LEN = 8 * (1 + N_CONST_CHUNKS + 4); // 168 field elements
    uint256 internal constant MAX_SIGNERS = 1 << 15;

    ILeanVmTerminalC1 public immutable verifier;
    address public immutable hasher;

    /// K, 8 limbs per word (big-endian uint32s).
    bytes32[N_CONST_CHUNKS] internal constChunks;
    /// Sponge state after absorbing [1, n, 0*6] | K, per batch size n (permissionless cache).
    mapping(uint256 n => bytes32[2]) internal midstates;

    mapping(bytes32 commitment => bool) public accepted;

    event ShapePrepared(uint256 indexed n);
    event BatchAccepted(
        bytes32 indexed commitment, uint32 slot, uint256 leftSigners, uint256 rightSigners, bytes32 applicationRootHash
    );

    error NonCanonical();
    error BadLengths();
    error RootMismatch();
    error ProofRejected();
    error HasherFailed();
    error AlreadyAccepted();

    constructor(ILeanVmTerminalC1 verifier_, address hasher_, uint256[] memory constWords) {
        if (constWords.length != 8 * N_CONST_CHUNKS) revert BadLengths();
        verifier = verifier_;
        hasher = hasher_;
        for (uint256 c; c < N_CONST_CHUNKS; ++c) {
            uint256 w;
            for (uint256 i; i < 8; ++i) {
                uint256 v = constWords[8 * c + i];
                if (v >= P) revert NonCanonical();
                w = (w << 32) | v;
            }
            constChunks[c] = bytes32(w);
        }
    }

    // ------------------------------------------------------------------ entry points

    /// Verify the terminal proof and bind it to (slot, signer lists, per-signer messages) in one tx.
    function submit(ILeanVmTerminalC1.Proof calldata proof, uint32 slot, Batch calldata left, Batch calldata right)
        external
        returns (bytes32 commitment)
    {
        // Replay protection: a statement (hence its proof) is accepted at most once. A proof cannot be
        // re-bound to a different statement, because the recomputed root would differ.
        commitment = batchCommitment(slot, left, right);
        if (accepted[commitment]) revert AlreadyAccepted();
        uint256[8] memory root = applicationRoot(slot, left, right);
        for (uint256 i; i < 8; ++i) {
            if (root[i] != proof.applicationRoot[i]) revert RootMismatch();
        }
        if (!verifier.verifyC1V1(proof)) revert ProofRejected();
        accepted[commitment] = true;
        emit BatchAccepted(commitment, slot, left.pubkeys.length, right.pubkeys.length, keccak256(abi.encode(root)));
    }

    /// Cache the sponge midstate for batch size n (anyone may call; also done lazily by submit).
    function prepareShape(uint256 n) external {
        _midstate(n);
    }

    // ------------------------------------------------------------------ views

    /// keccak256(abi.encode(slot, left.pubkeys, left.messages, right.pubkeys, right.messages)).
    function batchCommitment(uint32 slot, Batch calldata left, Batch calldata right) public pure returns (bytes32) {
        return keccak256(abi.encode(slot, left.pubkeys, left.messages, right.pubkeys, right.messages));
    }

    /// The application root the proof must carry for this statement (Poseidon1, recomputed on chain).
    /// Not `view`: it fills the per-n midstate cache on first use.
    function applicationRoot(uint32 slot, Batch calldata left, Batch calldata right)
        public
        returns (uint256[8] memory root)
    {
        uint256[8] memory l = childDigest(slot, left.pubkeys, left.messages);
        uint256[8] memory r = childDigest(slot, right.pubkeys, right.messages);
        uint256[16] memory st;
        st[0] = 24;
        st[8] = NOD1;
        st[9] = 2;
        _perm(st);
        for (uint256 i; i < 8; ++i) st[8 + i] = l[i];
        _perm(st);
        for (uint256 i; i < 8; ++i) st[8 + i] = r[i];
        _perm(st);
        for (uint256 i; i < 8; ++i) root[i] = st[8 + i];
    }

    /// Public input (8 words) of the aggregation program for one batch.
    function childDigest(uint32 slot, bytes32[] calldata pubkeys, bytes32[] calldata messages)
        public
        returns (uint256[8] memory digest)
    {
        uint256 n = pubkeys.length;
        if (n == 0 || n > MAX_SIGNERS || messages.length != n) revert BadLengths();
        uint256[16] memory st = _midstate(n);

        uint256[8] memory h = _hashPubkeys(pubkeys);
        for (uint256 i; i < 8; ++i) st[8 + i] = h[i];
        _perm(st);
        h = _hashMessages(messages);
        for (uint256 i; i < 8; ++i) st[8 + i] = h[i];
        _perm(st);
        for (uint256 k; k < 8; ++k) st[8 + k] = (~(uint256(slot) >> (4 * k))) & 0xF;
        _perm(st);
        for (uint256 i; i < 8; ++i) st[8 + i] = 0;
        _perm(st);
        for (uint256 i; i < 8; ++i) digest[i] = st[8 + i];
    }

    /// xmss::hash_message: compress([1004 | base-p limbs of m read little-endian (9) | 0*6]), feed-forward.
    function hashMessage(bytes32 m) public view returns (uint256[8] memory out) {
        uint256[16] memory st;
        uint256[16] memory inp;
        uint256 x = _reverseBytes(uint256(m));
        inp[0] = DOMAINSEP_MESSAGE_HASH;
        for (uint256 i = 1; i < 10; ++i) {
            inp[i] = x % P;
            x /= P;
        }
        for (uint256 i; i < 16; ++i) st[i] = inp[i];
        _perm(st);
        for (uint256 i; i < 8; ++i) out[i] = addmod(st[i], inp[i], P);
    }

    // ------------------------------------------------------------------ internals

    function _hashPubkeys(bytes32[] calldata pubkeys) internal view returns (uint256[8] memory out) {
        uint256[16] memory st;
        st[0] = 8 * pubkeys.length;
        for (uint256 j; j < pubkeys.length; ++j) {
            uint256 w = uint256(pubkeys[j]);
            for (uint256 i; i < 8; ++i) {
                uint256 v = (w >> (224 - 32 * i)) & 0xffffffff;
                if (v >= P) revert NonCanonical();
                st[8 + i] = v;
            }
            _perm(st);
        }
        for (uint256 i; i < 8; ++i) out[i] = st[8 + i];
    }

    function _hashMessages(bytes32[] calldata messages) internal view returns (uint256[8] memory out) {
        uint256[16] memory st;
        st[0] = 8 * messages.length;
        for (uint256 j; j < messages.length; ++j) {
            uint256[8] memory h = hashMessage(messages[j]);
            for (uint256 i; i < 8; ++i) st[8 + i] = h[i];
            _perm(st);
        }
        for (uint256 i; i < 8; ++i) out[i] = st[8 + i];
    }

    function _midstate(uint256 n) internal returns (uint256[16] memory st) {
        bytes32[2] storage cached = midstates[n];
        bytes32 a = cached[0];
        bytes32 b = cached[1];
        if (a != 0 || b != 0) {
            for (uint256 i; i < 8; ++i) {
                st[i] = (uint256(a) >> (224 - 32 * i)) & 0xffffffff;
                st[8 + i] = (uint256(b) >> (224 - 32 * i)) & 0xffffffff;
            }
            return st;
        }
        if (n == 0 || n > MAX_SIGNERS) revert BadLengths();
        st[0] = PREIMAGE_LEN;
        st[8] = 1;
        st[9] = n;
        _perm(st);
        for (uint256 c; c < N_CONST_CHUNKS; ++c) {
            uint256 w = uint256(constChunks[c]);
            for (uint256 i; i < 8; ++i) st[8 + i] = (w >> (224 - 32 * i)) & 0xffffffff;
            _perm(st);
        }
        uint256 pa;
        uint256 pb;
        for (uint256 i; i < 8; ++i) {
            pa = (pa << 32) | st[i];
            pb = (pb << 32) | st[8 + i];
        }
        cached[0] = bytes32(pa);
        cached[1] = bytes32(pb);
        emit ShapePrepared(n);
    }

    /// In-place Poseidon1 permutation via the generated hasher contract.
    function _perm(uint256[16] memory st) internal view {
        address h = hasher;
        bool ok;
        assembly ("memory-safe") {
            ok := staticcall(gas(), h, st, 512, st, 512)
            ok := and(ok, eq(returndatasize(), 512))
        }
        if (!ok) revert HasherFailed();
    }

    function _reverseBytes(uint256 v) internal pure returns (uint256) {
        v = ((v & 0xFF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00) >> 8)
            | ((v & 0x00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF) << 8);
        v = ((v & 0xFFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000) >> 16)
            | ((v & 0x0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF) << 16);
        v = ((v & 0xFFFFFFFF00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF00000000) >> 32)
            | ((v & 0x00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF) << 32);
        v = ((v & 0xFFFFFFFFFFFFFFFF0000000000000000FFFFFFFFFFFFFFFF0000000000000000) >> 64)
            | ((v & 0x0000000000000000FFFFFFFFFFFFFFFF0000000000000000FFFFFFFFFFFFFFFF) << 64);
        return (v >> 128) | (v << 128);
    }
}
