#!/usr/bin/env bash
# Deploy Poseidon1Hasher + generated verifier + SigpressValidityGate, run negative eth_calls, submit once,
# check replay is refused. Prints JSON lines. Gas limits: eth_estimateGas + 5% (Monad charges the limit).
# Usage: RPC=... PK=... tools/flow.sh RUN_DIR LABEL [EXISTING_VERIFIER]
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
RUN=$1; LABEL=$2; VERIFIER=${3:-}; HASHER=${HASHER:-}
SOL=$HERE/../vendor/sol-whir-p3-binding; N=LeanVmTwoCommitmentTerminal_$LABEL
CD_BIN=$SOL/testdata/leanvm_terminal/$LABEL/calldata.bin
FROM=$(cast wallet address "$PK")
lim() { echo $(( $1 * 105 / 100 )); }
send_create() {
  local est; est=$(cast estimate --rpc-url "$RPC" --from "$FROM" --create "$1")
  cast send --rpc-url "$RPC" --private-key "$PK" --gas-limit "$(lim "$est")" --create "$1" --json \
    | grep "^{" | jq -c --arg est "$est" '{contractAddress,status,gasUsed,transactionHash,estimate:$est}'
}
send_call() {
  local est; est=$(cast estimate --rpc-url "$RPC" --from "$FROM" "$1" "$2")
  cast send --rpc-url "$RPC" --private-key "$PK" --gas-limit "$(lim "$est")" "$1" "$2" --json \
    | grep "^{" | jq -c --arg est "$est" '{status,gasUsed,transactionHash,estimate:$est}'
}
revert_of() { (cast call --rpc-url "$RPC" --from "$FROM" "$1" "$2" 2>&1 || true) | tr -d '\n"' | grep -oE 'custom error 0x[0-9a-f]{8}|revert[^,]*|Error[^,]*' | head -1 || echo "no-revert"; }
python3 -I "$HERE/tools/statement.py" "$RUN" --export >/dev/null
CONST=$(jq -c .const_words "$RUN/statement.json" | tr -d ' ')
if [ -z "$HASHER" ]; then
  R=$(send_create "$(jq -r .bytecode.object "$HERE/out/Poseidon1Hasher.sol/Poseidon1Hasher.json")"); echo "{\"step\":\"deploy_hasher\",\"r\":$R}"
  HASHER=$(jq -r .contractAddress <<<"$R")
fi
if [ -z "$VERIFIER" ]; then
  R=$(send_create "$(jq -r .bytecode.object "$SOL/out/$N.sol/$N.json")"); echo "{\"step\":\"deploy_verifier\",\"r\":$R}"
  VERIFIER=$(jq -r .contractAddress <<<"$R")
fi
GATE_BC=$(jq -r .bytecode.object "$HERE/out/SigpressValidityGate.sol/SigpressValidityGate.json")$(cast abi-encode "c(address,address,uint256[])" "$VERIFIER" "$HASHER" "$CONST" | cut -c3-)
R=$(send_create "$GATE_BC"); echo "{\"step\":\"deploy_gate\",\"r\":$R}"; GATE=$(jq -r .contractAddress <<<"$R")
for m in swap-batches wrong-message wrong-signer wrong-slot; do
  echo "{\"step\":\"eth_call_$m\",\"result\":\"$(revert_of "$GATE" "$(python3 -I "$HERE/tools/submit_calldata.py" "$CD_BIN" "$RUN/statement.json" "$m")")\"}"
done
TAMP=$(mktemp); python3 -I -c "import sys;d=bytearray(open(sys.argv[1],'rb').read());d[60000]^=1;open(sys.argv[2],'wb').write(d)" "$CD_BIN" "$TAMP"
echo "{\"step\":\"eth_call_tampered_proof\",\"result\":\"$(revert_of "$GATE" "$(python3 -I "$HERE/tools/submit_calldata.py" "$TAMP" "$RUN/statement.json")")\"}"; rm -f "$TAMP"
SUB=$(python3 -I "$HERE/tools/submit_calldata.py" "$CD_BIN" "$RUN/statement.json")
echo "{\"step\":\"submit_calldata_bytes\",\"result\":$(( (${#SUB} - 2) / 2 ))}"
R=$(send_call "$GATE" "$SUB"); echo "{\"step\":\"submit\",\"r\":$R}"
echo "{\"step\":\"eth_call_replay\",\"result\":\"$(revert_of "$GATE" "$SUB")\"}"
COMMIT=$(cast keccak "$(cast abi-encode "f(uint32,bytes32[],bytes32[],bytes32[],bytes32[])" "$(jq .slot "$RUN/statement.json")" "$(jq -c .left.pubkeys "$RUN/statement.json" | tr -d '"')" "$(jq -c .left.messages "$RUN/statement.json" | tr -d '"')" "$(jq -c .right.pubkeys "$RUN/statement.json" | tr -d '"')" "$(jq -c .right.messages "$RUN/statement.json" | tr -d '"')")")
echo "{\"step\":\"accepted\",\"result\":\"$(cast call --rpc-url "$RPC" "$GATE" "accepted(bytes32)(bool)" "$COMMIT")\",\"commitment\":\"$COMMIT\",\"verifier\":\"$VERIFIER\",\"hasher\":\"$HASHER\",\"gate\":\"$GATE\"}"
