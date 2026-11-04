#!/usr/bin/env python3
"""One-line-per-layer summary of a prover report.json (rows, proving time, proof size)."""
import json
import sys

for path in sys.argv[1:]:
    d = json.load(open(path))
    print(path, "total proving ms", round(d.get("total_leanvm_proving_ms", 0)))
    for l in d["layers"]:
        raw = l.get("raw") or {}
        print(" ", l["layer"], "ms", round(l["proving_ms"]), "B", l["proof_bytes"], "stackedvars", l["stacked_num_variables"],
              "exec_rows", raw.get("execution_rows"), "ext_rows", raw.get("extension_rows"),
              "poseidon", raw.get("poseidon_calls"), "mem", raw.get("memory_cells"),
              "log_rows", {k: v["log_rows"] for k, v in l["tables"].items()})
