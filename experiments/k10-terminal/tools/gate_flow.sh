#!/usr/bin/env bash
# Deploy verifier + gate, register the pair's application root, submit the proof. Prints JSON lines.
# Usage: RPC=... PK=... tools/gate_flow.sh RUN_DIR LABEL [EXISTING_VERIFIER]
# Gas limits: eth_estimateGas + 5% (Monad charges the limit).
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
RUN=$1; LABEL=$2; VERIFIER=${3:-}
SOL=$HERE/vendor/sol-whir-p3; N=LeanVmTwoCommitmentTerminal_$LABEL
CD_BIN=$SOL/testdata/leanvm_terminal/$LABEL/calldata.bin
lim() { echo $(( $1 * 105 / 100 )); }
send_create() { # bytecode
  local est; est=$(cast estimate --rpc-url "$RPC" --from "$(cast wallet address "$PK")" --create "$1")
  cast send --rpc-url "$RPC" --private-key "$PK" --gas-limit "$(lim "$est")" --create "$1" --json \
    | jq -c --arg est "$est" '{contractAddress,status,gasUsed,transactionHash,estimate:$est}'
}
send_call() { # to data
  local est; est=$(cast estimate --rpc-url "$RPC" --from "$(cast wallet address "$PK")" "$1" "$2")
  cast send --rpc-url "$RPC" --private-key "$PK" --gas-limit "$(lim "$est")" "$1" "$2" --json \
    | jq -c --arg est "$est" '{status,gasUsed,transactionHash,estimate:$est}'
}
APP=$(python3 -I "$HERE/tools/app_root.py" "$RUN")
LEFT=$(jq -r .left_batch_root <<<"$APP"); RIGHT=$(jq -r .right_batch_root <<<"$APP")
ROOT=$(jq -c .proof_application_root <<<"$APP" | tr -d ' ')
if [ -z "$VERIFIER" ]; then
  R=$(send_create "$(jq -r .bytecode.object "$SOL/out/$N.sol/$N.json")"); echo "{\"step\":\"deploy_verifier\",\"r\":$R}"
  VERIFIER=$(jq -r .contractAddress <<<"$R")
fi
CD=0x$(xxd -p "$CD_BIN" | tr -d '\n')
echo "{\"step\":\"eth_call_verifyC1V1\",\"result\":\"$(cast call --rpc-url "$RPC" "$VERIFIER" "$CD")\"}"
if [ "${SKIP_VERIFY_TX:-0}" != 1 ]; then R=$(send_call "$VERIFIER" "$CD"); echo "{\"step\":\"verify_tx\",\"r\":$R}"; fi
GATE_BC=$(jq -r .bytecode.object "$HERE/gate/out/SigpressTerminalGate.sol/SigpressTerminalGate.json")$(cast abi-encode "c(address)" "$VERIFIER" | cut -c3-)
R=$(send_create "$GATE_BC"); echo "{\"step\":\"deploy_gate\",\"r\":$R}"; GATE=$(jq -r .contractAddress <<<"$R")
R=$(send_call "$GATE" "$(cast calldata "register(bytes32,bytes32,uint256[8])" "$LEFT" "$RIGHT" "$ROOT")"); echo "{\"step\":\"register\",\"r\":$R}"
SUB=$(python3 -I "$HERE/tools/submit_calldata.py" "$CD_BIN" "$LEFT" "$RIGHT")
WRONG=$(python3 -I "$HERE/tools/submit_calldata.py" "$CD_BIN" "$RIGHT" "$LEFT")
SWAPPED=$( (cast call --rpc-url "$RPC" "$GATE" "$WRONG" 2>&1 || true) | grep -o -m1 ROOT_MISMATCH || echo unexpected)
echo "{\"step\":\"submit_swapped_roots_eth_call\",\"result\":\"$SWAPPED\"}"
R=$(send_call "$GATE" "$SUB"); echo "{\"step\":\"submit\",\"r\":$R}"
echo "{\"step\":\"accepted\",\"result\":\"$(cast call --rpc-url "$RPC" "$GATE" "accepted(bytes32)(bool)" "$(cast call --rpc-url "$RPC" "$GATE" "pairKey(bytes32,bytes32)(bytes32)" "$LEFT" "$RIGHT")")\",\"verifier\":\"$VERIFIER\",\"gate\":\"$GATE\",\"left\":\"$LEFT\",\"right\":\"$RIGHT\"}"
