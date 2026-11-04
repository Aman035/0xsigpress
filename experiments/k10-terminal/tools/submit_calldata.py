#!/usr/bin/env python3
"""Build SigpressTerminalGate.submit(proof, left, right) calldata from the generator's calldata.bin.
calldata.bin = selector(verifyC1V1) ++ abi.encode((Proof)) = selector ++ word(0x20) ++ proofTuple.
Usage: submit_calldata.py CALLDATA_BIN LEFT_ROOT_HEX RIGHT_ROOT_HEX  -> hex on stdout
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from terminal_hashes import keccak256  # noqa: E402

data = Path(sys.argv[1]).read_bytes()
assert int.from_bytes(data[4:36], "big") == 0x20
proof_tuple = data[36:]
left = bytes.fromhex(sys.argv[2].removeprefix("0x"))
right = bytes.fromhex(sys.argv[3].removeprefix("0x"))
assert len(left) == len(right) == 32
sig = "submit((bytes,bytes,uint256[8],uint256[],uint256,uint256[],uint256,uint256),bytes32,bytes32)"
out = keccak256(sig.encode())[:4] + (0x60).to_bytes(32, "big") + left + right + proof_tuple
print("0x" + out.hex())
