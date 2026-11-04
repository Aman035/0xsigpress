#!/usr/bin/env bash
# For one deployed fixed-shape verifier + gate: per case, off-chain root check, eth_call verify,
# register the (left,right) pair, eth_call submit. Optionally send submit as a tx (SEND_SUBMIT=<name>).
# Usage: RPC=... PK=... tools/monad_shape_checks.sh DEPLOYED_JSON OUT_JSONL "name run label" ...
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd); DEP=$1; OUT=$2; shift 2
V=$(jq -r .verifier.address "$DEP"); G=$(jq -r .gate.address "$DEP"); FROM=$(cast wallet address "$PK")
SOL=$HERE/vendor/sol-whir-p3/testdata/leanvm_terminal
send() { local est; est=$(cast estimate --rpc-url "$RPC" --from "$FROM" "$1" "$2")
  cast send --rpc-url "$RPC" --private-key "$PK" --gas-limit $((est * 105 / 100)) "$1" "$2" --json \
    | jq -c --arg est "$est" '{status,gasUsed,transactionHash,estimate:$est}'; }
for spec in "$@"; do
  read -r NAME RUN LBL <<<"$spec"
  APP=$(python3 -I "$HERE/tools/app_root.py" "$HERE/runs/$RUN")
  LEFT=$(jq -r .left_batch_root <<<"$APP"); RIGHT=$(jq -r .right_batch_root <<<"$APP")
  ROOT=$(jq -c .proof_application_root <<<"$APP" | tr -d ' ')
  echo "{\"step\":\"${NAME}_app_root_offchain_match\",\"result\":$(jq .match <<<"$APP"),\"left\":\"$LEFT\",\"right\":\"$RIGHT\"}" | tee -a "$OUT"
  BIN=$SOL/$LBL/calldata.bin; CD=0x$(xxd -p "$BIN" | tr -d '\n')
  echo "{\"step\":\"${NAME}_eth_call_verifyC1V1\",\"result\":\"$(cast call --rpc-url "$RPC" "$V" "$CD")\",\"estimate\":\"$(cast estimate --rpc-url "$RPC" --from "$FROM" "$V" "$CD")\",\"calldata_bytes\":$(stat -f %z "$BIN")}" | tee -a "$OUT"
  KEY=$(cast call --rpc-url "$RPC" "$G" "pairKey(bytes32,bytes32)(bytes32)" "$LEFT" "$RIGHT")
  if [ "$(cast call --rpc-url "$RPC" "$G" "registeredRoot(bytes32)(bytes32)" "$KEY")" = "0x0000000000000000000000000000000000000000000000000000000000000000" ]; then
    R=$(send "$G" "$(cast calldata 'register(bytes32,bytes32,uint256[8])' "$LEFT" "$RIGHT" "$ROOT")"); echo "{\"step\":\"${NAME}_register\",\"r\":$R}" | tee -a "$OUT"
  fi
  SUB=$(python3 -I "$HERE/tools/submit_calldata.py" "$BIN" "$LEFT" "$RIGHT")
  echo "{\"step\":\"${NAME}_eth_call_submit\",\"result\":\"$(cast call --rpc-url "$RPC" --from "$FROM" "$G" "$SUB")\",\"estimate\":\"$(cast estimate --rpc-url "$RPC" --from "$FROM" "$G" "$SUB")\",\"calldata_bytes\":$(( (${#SUB} - 2) / 2 ))}" | tee -a "$OUT"
  if [ "${SEND_SUBMIT:-}" = "$NAME" ]; then
    R=$(send "$G" "$SUB"); echo "{\"step\":\"${NAME}_submit_tx\",\"r\":$R}" | tee -a "$OUT"
    echo "{\"step\":\"${NAME}_accepted\",\"result\":\"$(cast call --rpc-url "$RPC" "$G" "accepted(bytes32)(bool)" "$KEY")\"}" | tee -a "$OUT"
  fi
done
