#!/usr/bin/env bash
# Build (if needed) and run the v2 prover for 2 x N under the shared lock.
# Usage: tools/prove.sh N RUN_NAME   (env passes through: SIGPRESS_BATCH_LEFT/RIGHT, SIGPRESS_MIN_LOG_ROWS, ...)
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
VM=$HERE/../vendor/leanVM-binding-v2
N=$1; RUN=$HERE/runs/$2
mkdir -p "$RUN"
cd "$VM"
"$HERE/tools/locked.sh" bash -c "cargo build --release -j 6 -p spartan_whir_guest --bin sigpress-bindv2-terminal 2>&1 | grep -E '^error|Finished' ; \
  LEANVM_PROVING_TIMEOUT_SECONDS=0 LEANVM_TERMINAL_EXPORT='$RUN/native' /usr/bin/time -l \
  ./target/release/sigpress-bindv2-terminal $N '$RUN/report.json' '$HERE/../profiles/sigpress_c1.json' > '$RUN/proving.log' 2>&1"
