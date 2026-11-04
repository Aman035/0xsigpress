#!/usr/bin/env python3
"""Recompute the terminal application root from the two child public inputs (off-chain mapping check).

root = poseidon_hash_slice([NOD1, 2, 0*6] + left + right), with poseidon_hash_slice as in leanVM
crates/backend/symetric/src/poseidon_utils.rs (state[0] = len, overwrite rate half, permute).
Uses leanVM's Apache-2.0 python reference (imported from vendor/, not copied).
Usage: app_root.py RUN_DIR
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "vendor/leanVM/crates/lean_prover/python-verifier"))
from primitives import Fp, POSEIDON16  # noqa: E402

NOD1 = 1_313_817_649


def poseidon_hash_slice(data):
    assert data and len(data) % 8 == 0
    state = [Fp(0)] * 16
    state[0] = Fp(len(data))
    for i in range(0, len(data), 8):
        state[8:] = [Fp(v) for v in data[i:i + 8]]
        state = POSEIDON16.permute(state)
    return [int(v.value) if hasattr(v, "value") else int(v) for v in state[8:]]


run = Path(sys.argv[1])
report = json.loads((run / "report.json").read_text())
fixture = json.loads((run / "native/root-fixture.json").read_text())
left, right = (app["public_input"] for app in report["applications"])
root = poseidon_hash_slice([NOD1, 2, 0, 0, 0, 0, 0, 0] + left + right)
proof_root = [int(v) for v in fixture["application_root"]]
print(json.dumps({
    "left_batch_root": report["applications"][0]["batch_root_hex"],
    "right_batch_root": report["applications"][1]["batch_root_hex"],
    "left_child_public_input": left,
    "right_child_public_input": right,
    "recomputed_application_root": root,
    "proof_application_root": proof_root,
    "match": root == proof_root,
}, indent=2))
sys.exit(0 if root == proof_root else 1)
