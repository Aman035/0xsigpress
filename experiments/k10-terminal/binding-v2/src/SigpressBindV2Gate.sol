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

/// sigpress research gate (K10 binding v2). One tx: verify the Keccak terminal proof AND bind it to the
/// (slot, pubkeys, per-signer messages) in calldata, with O(1) Poseidon permutations per batch instead of
/// ~3 per signer.
///
/// How the binding works (patched leanVM aggregation program, see binding-v2/patches):
///  - The prover commits to the signer data it verified: D = compress(hash_slice(pk_i), hash_slice(H(m_i))),
///    carried in calldata (`Batch.commitment`, 8 KoalaBear limbs).
///  - This contract derives a challenge r in F_p^5 = F_p[X]/(X^5 + X^2 - 1) from
///    keccak256(TAG | slot | n | D | pubkeys | messages) and evaluates, from calldata,
///      v = Horner_{rho = r^17} over signers of s_i(r) = sum_k pk_i[k] r^k + sum_k limb_k(m_i) r^(8+k)
///    (limb_k = base-p digits of m_i read little-endian, as xmss::encode_message).
///  - The guest evaluates the same polynomial on the data it actually verified and exposes D, r, v in its
///    public input; this contract recomputes that public input (4 permutations per batch) and the
///    application root (3 permutations) and requires equality with the proof's root.
/// If the calldata data S differs from the proven data S', the two degree < 17n polynomials differ, and since
/// r is a random-oracle output of (S, D) with D binding S', they agree at r with probability <= 17n / p^5
/// (~2^-141 at n = 2^14) per attempt.
///
/// child = hash_slice([1, n, 0*6] | K | D | v,0,0,0 | merkle_chunks(slot) | r,0,0,0)
/// root  = hash_slice([NOD1, 2, 0*6] | left | right)
/// K = 128 constant words of the fixed aggregation program (deploy-time constant like the pinned programs).
contract SigpressBindV2Gate {
    struct Batch {
        bytes32[] pubkeys; // 8 big-endian uint32 KoalaBear limbs each, [merkle_root(4) | public_param(4)], < p
        bytes32[] messages; // signer i's own 32-byte message
        bytes32 commitment; // D, 8 big-endian uint32 limbs < p (from the prover)
    }

    uint256 internal constant P = 2_130_706_433;
    uint256 internal constant NOD1 = 1_313_817_649;
    uint256 internal constant N_CONST_CHUNKS = 16;
    uint256 internal constant PREIMAGE_LEN = 8 * (1 + N_CONST_CHUNKS + 4); // 168 field elements
    uint256 internal constant MAX_SIGNERS = 1 << 15;
    bytes32 internal constant TAG = keccak256("sigpress-bind-v2");

    ILeanVmTerminalC1 public immutable verifier;
    address public immutable hasher;

    bytes32[N_CONST_CHUNKS] internal constChunks;
    mapping(uint256 n => bytes32[2]) internal midstates;
    mapping(bytes32 commitment => bool) public accepted;

    event ShapePrepared(uint256 indexed n);
    event BatchAccepted(bytes32 indexed commitment, uint32 slot, uint256 leftSigners, uint256 rightSigners);

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

    function submit(ILeanVmTerminalC1.Proof calldata proof, uint32 slot, Batch calldata left, Batch calldata right)
        external
        returns (bytes32 commitment)
    {
        commitment = batchCommitment(slot, left, right);
        if (accepted[commitment]) revert AlreadyAccepted();
        uint256[8] memory root = applicationRoot(slot, left, right);
        for (uint256 i; i < 8; ++i) {
            if (root[i] != proof.applicationRoot[i]) revert RootMismatch();
        }
        if (!verifier.verifyC1V1(proof)) revert ProofRejected();
        accepted[commitment] = true;
        emit BatchAccepted(commitment, slot, left.pubkeys.length, right.pubkeys.length);
    }

    function prepareShape(uint256 n) external {
        _midstate(n);
    }

    // ------------------------------------------------------------------ views

    /// keccak256(abi.encode(slot, left.pubkeys, left.messages, right.pubkeys, right.messages)) (same as v1).
    function batchCommitment(uint32 slot, Batch calldata left, Batch calldata right) public pure returns (bytes32) {
        return keccak256(abi.encode(slot, left.pubkeys, left.messages, right.pubkeys, right.messages));
    }

    function applicationRoot(uint32 slot, Batch calldata left, Batch calldata right)
        public
        returns (uint256[8] memory root)
    {
        uint256[8] memory l = childDigest(slot, left);
        uint256[8] memory r = childDigest(slot, right);
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
    function childDigest(uint32 slot, Batch calldata b) public returns (uint256[8] memory digest) {
        uint256 n = b.pubkeys.length;
        if (n == 0 || n > MAX_SIGNERS || b.messages.length != n) revert BadLengths();
        (uint256[5] memory r, uint256[5] memory v) = challengeAndEval(slot, b);
        uint256[16] memory st = _midstate(n);
        uint256 d = uint256(b.commitment);
        for (uint256 i; i < 8; ++i) {
            uint256 x = (d >> (224 - 32 * i)) & 0xffffffff;
            if (x >= P) revert NonCanonical();
            st[8 + i] = x;
        }
        _perm(st);
        for (uint256 i; i < 5; ++i) st[8 + i] = v[i];
        st[13] = 0;
        st[14] = 0;
        st[15] = 0;
        _perm(st);
        for (uint256 k; k < 8; ++k) st[8 + k] = (~(uint256(slot) >> (4 * k))) & 0xF;
        _perm(st);
        for (uint256 i; i < 5; ++i) st[8 + i] = r[i];
        st[13] = 0;
        st[14] = 0;
        st[15] = 0;
        _perm(st);
        for (uint256 i; i < 8; ++i) digest[i] = st[8 + i];
    }

    /// r = challenge from keccak over the batch calldata, v = binding polynomial at r (both in F_p^5).
    /// Reverts NonCanonical if a pubkey limb is >= p.
    function challengeAndEval(uint32 slot, Batch calldata b) public pure returns (uint256[5] memory r, uint256[5] memory v) {
        bytes32[] calldata pks = b.pubkeys;
        bytes32[] calldata msgs = b.messages;
        uint256 n = pks.length;
        bytes32 h;
        bytes32 tag = TAG;
        bytes32 d = b.commitment;
        assembly ("memory-safe") {
            let m := mload(0x40)
            mstore(m, tag)
            mstore(add(m, 0x20), slot)
            mstore(add(m, 0x40), n)
            mstore(add(m, 0x60), d)
            let len := shl(5, n)
            calldatacopy(add(m, 0x80), pks.offset, len)
            calldatacopy(add(add(m, 0x80), len), msgs.offset, len)
            h := keccak256(m, add(0x80, shl(1, len)))
        }
        for (uint256 k; k < 5; ++k) {
            r[k] = ((uint256(h) >> (48 * k)) & 0xffffffffffff) % P;
        }
        v = _eval(r, pks, msgs);
    }

    // ------------------------------------------------------------------ binding polynomial

    function _eval(uint256[5] memory r, bytes32[] calldata pks, bytes32[] calldata msgs)
        internal
        pure
        returns (uint256[5] memory v)
    {
        uint256 bad;
        assembly ("memory-safe") {
            // b = a * q + (sA, sB lanes) in F_p[X]/(X^5 + X^2 - 1); X^5 = 1 - X^2 folds c8..c5 down.
            // Subtractions first add a multiple of p (values stay non-negative, < 2^142).
            // sA packs coefficients 0..2, sB 3..4, in 72-bit lanes.
            function step(a, q, b, sA, sB) {
                let t8 := mul(mload(add(a, 0x80)), mload(add(q, 0x80)))
                let t7 := add(mul(mload(add(a, 0x60)), mload(add(q, 0x80))), mul(mload(add(a, 0x80)), mload(add(q, 0x60))))
                let t6 := add(add(mul(mload(add(a, 0x40)), mload(add(q, 0x80))), mul(mload(add(a, 0x60)), mload(add(q, 0x60)))), mul(mload(add(a, 0x80)), mload(add(q, 0x40))))
                let t5 := sub(add(add(add(add(mul(mload(add(a, 0x20)), mload(add(q, 0x80))), mul(mload(add(a, 0x40)), mload(add(q, 0x60)))), mul(mload(add(a, 0x60)), mload(add(q, 0x40)))), mul(mload(add(a, 0x80)), mload(add(q, 0x20)))), shl(72, 2130706433)), t8)
                mstore(b, addmod(add(mul(mload(a), mload(q)), t5), and(sA, 0xffffffffffffffffff), 2130706433))
                mstore(add(b, 0x20), addmod(add(add(mul(mload(a), mload(add(q, 0x20))), mul(mload(add(a, 0x20)), mload(q))), t6), and(shr(72, sA), 0xffffffffffffffffff), 2130706433))
                mstore(add(b, 0x40), addmod(sub(add(add(add(add(mul(mload(a), mload(add(q, 0x40))), mul(mload(add(a, 0x20)), mload(add(q, 0x20)))), mul(mload(add(a, 0x40)), mload(q))), t7), shl(110, 2130706433)), t5), shr(144, sA), 2130706433))
                mstore(add(b, 0x60), addmod(sub(add(add(add(add(add(mul(mload(a), mload(add(q, 0x60))), mul(mload(add(a, 0x20)), mload(add(q, 0x40)))), mul(mload(add(a, 0x40)), mload(add(q, 0x20)))), mul(mload(add(a, 0x60)), mload(q))), t8), shl(72, 2130706433)), t6), and(sB, 0xffffffffffffffffff), 2130706433))
                mstore(add(b, 0x80), addmod(sub(add(add(add(add(add(mul(mload(a), mload(add(q, 0x80))), mul(mload(add(a, 0x20)), mload(add(q, 0x60)))), mul(mload(add(a, 0x40)), mload(add(q, 0x40)))), mul(mload(add(a, 0x60)), mload(add(q, 0x20)))), mul(mload(add(a, 0x80)), mload(q))), shl(72, 2130706433)), t7), shr(72, sB), 2130706433))
            }
            function bswap(x) -> y {
                y := or(shr(8, and(x, 0xFF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00)),
                        shl(8, and(x, 0x00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF)))
                y := or(shr(16, and(y, 0xFFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000)),
                        shl(16, and(y, 0x0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF)))
                y := or(shr(32, and(y, 0xFFFFFFFF00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF00000000)),
                        shl(32, and(y, 0x00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF)))
                y := or(shr(64, and(y, 0xFFFFFFFFFFFFFFFF0000000000000000FFFFFFFFFFFFFFFF0000000000000000)),
                        shl(64, and(y, 0x0000000000000000FFFFFFFFFFFFFFFF0000000000000000FFFFFFFFFFFFFFFF)))
                y := or(shr(128, y), shl(128, y))
            }
            // s_i(r) of one signer as packed lanes; bb = 1 if a pubkey limb is >= p. Coefficient k uses
            // r^k from tbl (2 words per power): pk limbs (big-endian uint32) at k = 0..7, message base-p
            // digits (little-endian integer, as xmss::encode_message) at k = 8..16.
            function signer(tbl, w, m) -> sA, sB, bb {
                { let cf := and(shr(224, w), 0xffffffff) bb := or(bb, gt(cf, 2130706432)) sA := add(sA, mul(cf, mload(add(tbl, 0x0)))) sB := add(sB, mul(cf, mload(add(tbl, 0x20)))) }
                { let cf := and(shr(192, w), 0xffffffff) bb := or(bb, gt(cf, 2130706432)) sA := add(sA, mul(cf, mload(add(tbl, 0x40)))) sB := add(sB, mul(cf, mload(add(tbl, 0x60)))) }
                { let cf := and(shr(160, w), 0xffffffff) bb := or(bb, gt(cf, 2130706432)) sA := add(sA, mul(cf, mload(add(tbl, 0x80)))) sB := add(sB, mul(cf, mload(add(tbl, 0xa0)))) }
                { let cf := and(shr(128, w), 0xffffffff) bb := or(bb, gt(cf, 2130706432)) sA := add(sA, mul(cf, mload(add(tbl, 0xc0)))) sB := add(sB, mul(cf, mload(add(tbl, 0xe0)))) }
                { let cf := and(shr(96, w), 0xffffffff) bb := or(bb, gt(cf, 2130706432)) sA := add(sA, mul(cf, mload(add(tbl, 0x100)))) sB := add(sB, mul(cf, mload(add(tbl, 0x120)))) }
                { let cf := and(shr(64, w), 0xffffffff) bb := or(bb, gt(cf, 2130706432)) sA := add(sA, mul(cf, mload(add(tbl, 0x140)))) sB := add(sB, mul(cf, mload(add(tbl, 0x160)))) }
                { let cf := and(shr(32, w), 0xffffffff) bb := or(bb, gt(cf, 2130706432)) sA := add(sA, mul(cf, mload(add(tbl, 0x180)))) sB := add(sB, mul(cf, mload(add(tbl, 0x1a0)))) }
                { let cf := and(w, 0xffffffff) bb := or(bb, gt(cf, 2130706432)) sA := add(sA, mul(cf, mload(add(tbl, 0x1c0)))) sB := add(sB, mul(cf, mload(add(tbl, 0x1e0)))) }
                let x := bswap(m)
                { let cf := mod(x, 2130706433) sA := add(sA, mul(cf, mload(add(tbl, 0x200)))) sB := add(sB, mul(cf, mload(add(tbl, 0x220)))) }
                x := div(x, 2130706433)
                { let cf := mod(x, 2130706433) sA := add(sA, mul(cf, mload(add(tbl, 0x240)))) sB := add(sB, mul(cf, mload(add(tbl, 0x260)))) }
                x := div(x, 2130706433)
                { let cf := mod(x, 2130706433) sA := add(sA, mul(cf, mload(add(tbl, 0x280)))) sB := add(sB, mul(cf, mload(add(tbl, 0x2a0)))) }
                x := div(x, 2130706433)
                { let cf := mod(x, 2130706433) sA := add(sA, mul(cf, mload(add(tbl, 0x2c0)))) sB := add(sB, mul(cf, mload(add(tbl, 0x2e0)))) }
                x := div(x, 2130706433)
                { let cf := mod(x, 2130706433) sA := add(sA, mul(cf, mload(add(tbl, 0x300)))) sB := add(sB, mul(cf, mload(add(tbl, 0x320)))) }
                x := div(x, 2130706433)
                { let cf := mod(x, 2130706433) sA := add(sA, mul(cf, mload(add(tbl, 0x340)))) sB := add(sB, mul(cf, mload(add(tbl, 0x360)))) }
                x := div(x, 2130706433)
                { let cf := mod(x, 2130706433) sA := add(sA, mul(cf, mload(add(tbl, 0x380)))) sB := add(sB, mul(cf, mload(add(tbl, 0x3a0)))) }
                x := div(x, 2130706433)
                { let cf := mod(x, 2130706433) sA := add(sA, mul(cf, mload(add(tbl, 0x3c0)))) sB := add(sB, mul(cf, mload(add(tbl, 0x3e0)))) }
                x := div(x, 2130706433)
                { let cf := mod(x, 2130706433) sA := add(sA, mul(cf, mload(add(tbl, 0x400)))) sB := add(sB, mul(cf, mload(add(tbl, 0x420)))) }
            }
            // Scratch: two 5-word buffers at base and base ^ 0x100 (base 0x200-aligned), then the packed
            // power table (34 words) and rho = r^17 (5 words).
            function run(rr, po, mo, n, out) -> bad_ {
                let a := and(add(mload(0x40), 0x1ff), not(0x1ff))
                let tbl := add(a, 0x200)
                let q := add(tbl, 0x440)
                mstore(0x40, add(q, 0xa0))
                // powers r^0..r^17: cur in a, next in a ^ 0x100
                mstore(a, 1) mstore(add(a, 0x20), 0) mstore(add(a, 0x40), 0) mstore(add(a, 0x60), 0) mstore(add(a, 0x80), 0)
                for { let k := 0 } lt(k, 17) { k := add(k, 1) } {
                    let pp := add(tbl, shl(6, k))
                    mstore(pp, or(or(mload(a), shl(72, mload(add(a, 0x20)))), shl(144, mload(add(a, 0x40)))))
                    mstore(add(pp, 0x20), or(mload(add(a, 0x60)), shl(72, mload(add(a, 0x80)))))
                    step(a, rr, xor(a, 0x100), 0, 0)
                    a := xor(a, 0x100)
                }
                mcopy(q, a, 0xa0)
                mstore(a, 0) mstore(add(a, 0x20), 0) mstore(add(a, 0x40), 0) mstore(add(a, 0x60), 0) mstore(add(a, 0x80), 0)
                for { let i := 0 } lt(i, n) { i := add(i, 1) } {
                    let sA, sB, bb := signer(tbl, calldataload(add(po, shl(5, i))), calldataload(add(mo, shl(5, i))))
                    bad_ := or(bad_, bb)
                    step(a, q, xor(a, 0x100), sA, sB)
                    a := xor(a, 0x100)
                }
                mcopy(out, a, 0xa0)
            }
            bad := run(r, pks.offset, msgs.offset, pks.length, v)
        }
        if (bad != 0) revert NonCanonical();
    }

    // ------------------------------------------------------------------ Poseidon sponge (as v1)

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

    function _perm(uint256[16] memory st) internal view {
        address h = hasher;
        bool ok;
        assembly ("memory-safe") {
            ok := staticcall(gas(), h, st, 512, st, 512)
            ok := and(ok, eq(returndatasize(), 512))
        }
        if (!ok) revert HasherFailed();
    }
}
