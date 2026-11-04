#!/usr/bin/env python3
"""Off-chain mirror of SigpressValidityGate's binding computation (for cross-checking, and test vectors).

Recomputes, from a binding run's report.json (signer pubkeys + per-signer 32-byte messages + slot):
  child digest = poseidon_hash_slice(preimage), preimage = [1, n, 0*6] | const chunks | pubkeys_hash |
                 messages_hash | merkle_chunks(slot) | zeros(8)
  application root = poseidon_hash_slice([NOD1, 2, 0*6] | left | right)
and checks them against the prover's exported preimage / public input / root-fixture.
Uses leanVM's Apache-2.0 python reference for Poseidon1 (imported from vendor/, not copied).
Usage: statement.py RUN_DIR            -> JSON summary, exit 1 on mismatch
       statement.py RUN_DIR --export   -> also writes RUN_DIR/statement.json (gate calldata inputs)
       statement.py --vectors          -> JSON permutation/hash_message test vectors
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "vendor/leanVM/crates/lean_prover/python-verifier"))
from primitives import Fp, POSEIDON16  # noqa: E402

P = 2_130_706_433
NOD1 = 1_313_817_649
DOMAINSEP_MESSAGE_HASH = 1004


def perm(state):
    return [int(v.value) for v in POSEIDON16.permute([Fp(x % P) for x in state])]


def hash_slice(data):
    assert data and len(data) % 8 == 0
    st = [len(data)] + [0] * 15
    for i in range(0, len(data), 8):
        st[8:] = data[i:i + 8]
        st = perm(st)
    return st[8:]


def encode_message(m: bytes):
    x = int.from_bytes(m, "little")
    out = []
    for _ in range(9):
        out.append(x % P)
        x //= P
    return out


def hash_message(m: bytes):
    inp = [DOMAINSEP_MESSAGE_HASH] + encode_message(m) + [0] * 6
    out = perm(inp)
    return [(a + b) % P for a, b in zip(out, inp)][:8]


def merkle_chunks(slot):
    return [(~(slot >> (4 * k)) & 0xF) for k in range(8)]


def child_preimage(n, const_words, pubkeys, messages, slot):
    pk_flat = [w for pk in pubkeys for w in pk]
    hm = [w for m in messages for w in hash_message(m)]
    return [1, n, 0, 0, 0, 0, 0, 0] + const_words + hash_slice(pk_flat) + hash_slice(hm) + merkle_chunks(slot) + [0] * 8


def main():
    if sys.argv[1] == "--vectors":
        vec = {"perm": [], "hash_message": []}
        for seed in range(3):
            st = [(seed * 1_000_003 + i * 7919) % P for i in range(16)]
            vec["perm"].append({"in": st, "out": perm(st)})
        for m in [bytes(32), bytes([0xff]) * 32, bytes(range(32))]:
            vec["hash_message"].append({"m": "0x" + m.hex(), "out": hash_message(m)})
        print(json.dumps(vec))
        return 0
    run = Path(sys.argv[1])
    rep = json.loads((run / "report.json").read_text())
    digests, ok = [], True
    for app in rep["applications"]:
        pre = app["public_input_preimage"]
        n = app["signers"]
        pks = [e["pubkey_fe"] for e in app["entries"]]
        msgs = [bytes.fromhex(e["message_hex"][2:]) for e in app["entries"]]
        mine = child_preimage(n, pre[8:-32], pks, msgs, app["slot"])
        ok &= mine == pre
        d = hash_slice(mine)
        ok &= d == app["public_input"]
        digests.append(d)
    root = hash_slice([NOD1, 2, 0, 0, 0, 0, 0, 0] + digests[0] + digests[1])
    fx = run / "native/root-fixture.json"
    proof_root = [int(v) for v in json.loads(fx.read_text())["application_root"]] if fx.exists() else None
    ok &= proof_root is None or proof_root == root
    if "--export" in sys.argv:
        def side(app):
            return {"pubkeys": ["0x" + "".join(f"{w:08x}" for w in e["pubkey_fe"]) for e in app["entries"]],
                    "messages": [e["message_hex"] for e in app["entries"]]}
        apps = rep["applications"]
        (run / "statement.json").write_text(json.dumps({
            "slot": apps[0]["slot"], "const_words": apps[0]["public_input_preimage"][8:-32],
            "left": side(apps[0]), "right": side(apps[1]), "application_root": root}, indent=1))
    print(json.dumps({"preimage_and_digest_match": ok, "application_root": root,
                      "proof_application_root": proof_root,
                      "const_words": rep["applications"][0]["public_input_preimage"][8:-32]}))
    return 0 if ok else 1


sys.exit(main())
