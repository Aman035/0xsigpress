#!/usr/bin/env python3
"""Build SigpressValidityGate.submit(proof, slot, left, right) calldata.
calldata.bin (sol-whir-p3 generator) = selector(verifyC1V1) ++ word(0x20) ++ proofTuple.
Usage: submit_calldata.py CALLDATA_BIN STATEMENT_JSON [MUTATION]  -> hex on stdout
MUTATION (negative checks): swap-batches | wrong-message | wrong-signer | wrong-slot
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools"))
from terminal_hashes import keccak256  # noqa: E402

data = Path(sys.argv[1]).read_bytes()
assert int.from_bytes(data[4:36], "big") == 0x20
proof_tuple = data[36:]
st = json.loads(Path(sys.argv[2]).read_text())
mut = sys.argv[3] if len(sys.argv) > 3 else ""
slot, left, right = st["slot"], st["left"], st["right"]
if mut == "swap-batches":
    left, right = right, left
elif mut == "wrong-message":
    left = dict(left, messages=["0x" + "11" * 32] + left["messages"][1:])
elif mut == "wrong-signer":
    pk0 = int(left["pubkeys"][0], 16) ^ 1
    left = dict(left, pubkeys=[f"0x{pk0:064x}"] + left["pubkeys"][1:])
elif mut == "wrong-slot":
    slot += 1
elif mut:
    sys.exit(f"unknown mutation {mut}")


def word(x):
    return x.to_bytes(32, "big")


def arr(items):
    return word(len(items)) + b"".join(bytes.fromhex(i[2:]) for i in items)


def batch(b):
    pk, ms = arr(b["pubkeys"]), arr(b["messages"])
    return word(0x40) + word(0x40 + len(pk)) + pk + ms


lb, rb = batch(left), batch(right)
head_len = 4 * 32
off_proof = head_len
off_left = off_proof + len(proof_tuple)
off_right = off_left + len(lb)
sig = "submit((bytes,bytes,uint256[8],uint256[],uint256,uint256[],uint256,uint256),uint32,(bytes32[],bytes32[]),(bytes32[],bytes32[]))"
out = keccak256(sig.encode())[:4] + word(off_proof) + word(slot) + word(off_left) + word(off_right) + proof_tuple + lb + rb
print("0x" + out.hex())
