#!/usr/bin/env bash
# eth_call each negative mutation via raw JSON-RPC so the revert data (error selector) is visible on Monad.
# Usage: RPC=... FROM=0x... tools/raw_calls.sh GATE RUN_DIR LABEL MUTATION...   ("none" = unmodified)
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
GATE=$1; RUN=$2; LABEL=$3; shift 3
TMP=$(mktemp)
for m in "$@"; do
  mm=$m; [ "$m" = none ] && mm=""
  D=$(python3 -I "$HERE/tools/submit_calldata.py" "$HERE/results/$LABEL/calldata.bin" "$RUN/statement.json" $mm)
  printf '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"from":"%s","to":"%s","data":"%s","gas":"0x1c9c380"},"latest"]}' "$FROM" "$GATE" "$D" > "$TMP"
  for t in 1 2 3 4 5; do
    R=$(curl -s -X POST "$RPC" -H 'content-type: application/json' --data @"$TMP") && ! grep -q "429\|Rate limit" <<<"$R" && [ -n "$R" ] && break; sleep 6
  done
  echo "{\"step\":\"eth_call_raw_$m\",\"response\":$(jq -c '.error // .' <<<"$R")}"; sleep 4
done
rm -f "$TMP"
