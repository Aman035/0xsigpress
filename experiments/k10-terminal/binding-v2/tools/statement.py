#!/usr/bin/env python3
"""Off-chain mirror of SigpressBindV2Gate's statement (cross-check + gate inputs). Research, MIT.

From a v2 run's report.json (per-signer pubkeys + 32-byte messages + slot) recomputes, per batch:
  D   = compress(hash_slice(pk_0..), hash_slice(hash_message(m_0)..))       prover commitment (calldata)
  r   = keccak challenge: h = keccak256(keccak256("sigpress-bind-v2") | u256 slot | u256 n | D (8 x u32 BE)
        | pk_i (8 x u32 BE) ... | m_i (32 B) ...);  r_k = ((h >> 48k) & (2^48-1)) mod p
  v   = Horner_{rho=r^17} over signers of s_i(r) = sum_k pk_i[k] r^k + sum_k limb_i[k] r^(8+k)  in F_p[X]/(X^5+X^2-1)
  child = hash_slice([1, n, 0*6] | K | D | v,0,0,0 | merkle_chunks(slot) | r,0,0,0)
and root = hash_slice([NOD1, 2, 0*6] | left | right); checks all against the prover's report / root-fixture.
Poseidon1 from leanVM's Apache-2.0 python reference (imported from vendor/, not copied).
Usage: statement.py RUN_DIR [--export]   (export writes RUN_DIR/statement.json for the gate)
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "vendor/leanVM/crates/lean_prover/python-verifier"))
sys.path.insert(0, str(HERE.parents[1] / "tools"))
from primitives import Fp, POSEIDON16  # noqa: E402
from terminal_hashes import keccak256  # noqa: E402

P = 2_130_706_433
NOD1 = 1_313_817_649
DOMAINSEP_MESSAGE_HASH = 1004
TAG = keccak256(b"sigpress-bind-v2")


def perm(state):
    return [int(v.value) for v in POSEIDON16.permute([Fp(x % P) for x in state])]


def hash_slice(data):
    assert data and len(data) % 8 == 0
    st = [len(data)] + [0] * 15
    for i in range(0, len(data), 8):
        st[8:] = data[i:i + 8]
        st = perm(st)
    return st[8:]


def compress(a, b):
    inp = list(a) + list(b)
    return [(x + y) % P for x, y in zip(perm(inp), inp)][:8]


def encode_message(m: bytes):
    x = int.from_bytes(m, "little")
    out = []
    for _ in range(9):
        out.append(x % P)
        x //= P
    return out


def hash_message(m: bytes):
    return compress([DOMAINSEP_MESSAGE_HASH] + encode_message(m)[:7], encode_message(m)[7:] + [0] * 6)


def merkle_chunks(slot):
    return [(~(slot >> (4 * k)) & 0xF) for k in range(8)]


# ---- F_p[X]/(X^5 + X^2 - 1)
def emul(a, b):
    c = [0] * 9
    for i in range(5):
        for j in range(5):
            c[i + j] += a[i] * b[j]
    for k in range(8, 4, -1):  # X^k = X^(k-5) * X^5 = X^(k-5) * (1 - X^2)
        c[k - 5] += c[k]
        c[k - 3] -= c[k]
        c[k] = 0
    return [x % P for x in c[:5]]


def eadd(a, b):
    return [(x + y) % P for x, y in zip(a, b)]


def escale(a, s):
    return [(x * s) % P for x in a]


def challenge(slot, d, pks, msgs):
    buf = TAG + slot.to_bytes(32, "big") + len(pks).to_bytes(32, "big")
    buf += b"".join(x.to_bytes(4, "big") for x in d)
    buf += b"".join(x.to_bytes(4, "big") for pk in pks for x in pk)
    buf += b"".join(msgs)
    h = int.from_bytes(keccak256(buf), "big")
    return [((h >> (48 * k)) & ((1 << 48) - 1)) % P for k in range(5)]


def evaluate(r, pks, msgs):
    pw = [[1, 0, 0, 0, 0]]
    for _ in range(16):
        pw.append(emul(pw[-1], r))
    rho = emul(pw[16], r)
    acc = [0] * 5
    for pk, m in zip(pks, msgs):
        s = [0] * 5
        for k, c in enumerate(list(pk) + encode_message(m)):
            s = eadd(s, escale(pw[k], c))
        acc = eadd(emul(acc, rho), s)
    return acc


def batch_statement(n, const_words, pks, msgs, slot):
    d = compress(hash_slice([w for pk in pks for w in pk]), hash_slice([w for m in msgs for w in hash_message(m)]))
    r = challenge(slot, d, pks, msgs)
    v = evaluate(r, pks, msgs)
    pre = [1, n, 0, 0, 0, 0, 0, 0] + const_words + d + v + [0, 0, 0] + merkle_chunks(slot) + r + [0, 0, 0]
    return d, r, v, pre


def main():
    run = Path(sys.argv[1])
    rep = json.loads((run / "report.json").read_text())
    digests, ok, sides = [], True, []
    for app in rep["applications"]:
        pre = app["public_input_preimage"]
        n = app["signers"]
        pks = [e["pubkey_fe"] for e in app["entries"]]
        msgs = [bytes.fromhex(e["message_hex"][2:]) for e in app["entries"]]
        const_words = pre[8:-32]
        d, r, v, mine = batch_statement(n, const_words, pks, msgs, app["slot"])
        b = app.get("bind_v2", {})
        ok &= mine == pre and b.get("d_commit") == d and b.get("r") == r and b.get("v") == v
        dig = hash_slice(mine)
        ok &= dig == app["public_input"]
        digests.append(dig)
        sides.append({"pubkeys": ["0x" + "".join(f"{w:08x}" for w in pk) for pk in pks],
                      "messages": [e["message_hex"] for e in app["entries"]],
                      "commitment": "0x" + "".join(f"{w:08x}" for w in d)})
    root = hash_slice([NOD1, 2, 0, 0, 0, 0, 0, 0] + digests[0] + digests[1])
    fx = run / "native/root-fixture.json"
    proof_root = [int(v) for v in json.loads(fx.read_text())["application_root"]] if fx.exists() else None
    ok &= proof_root is None or proof_root == root
    if "--export" in sys.argv:
        apps = rep["applications"]
        (run / "statement.json").write_text(json.dumps({
            "slot": apps[0]["slot"], "const_words": apps[0]["public_input_preimage"][8:-32],
            "left": sides[0], "right": sides[1], "application_root": root}, indent=1))
    print(json.dumps({"statement_matches_prover": ok, "application_root": root, "proof_application_root": proof_root}))
    return 0 if ok else 1


sys.exit(main())
