#!/usr/bin/env bash
# Deploy to Monad testnet and run naive, demo and tamper. Needs PRIVATE_KEY in .env.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
set -a; source "$ROOT/.env"; set +a
cd "$ROOT/contracts"
forge script script/Deploy.s.sol --rpc-url monad_testnet --broadcast --slow
RUN="broadcast/Deploy.s.sol/10143/run-latest.json"
NAIVE=$(jq -r '[.transactions[]|select(.contractName=="NaiveLane")][0].contractAddress' "$RUN")
AGG=$(jq -r '[.transactions[]|select(.contractName=="OptimisticAggregator")][0].contractAddress' "$RUN")
cat > "$ROOT/aggregator/deployments.json" <<JSON
{ "chainId": 10143, "naiveLane": "$NAIVE", "aggregator": "$AGG", "explorer": "https://testnet.monadexplorer.com" }
JSON
mkdir -p "$ROOT/web/public" && cp "$ROOT/aggregator/deployments.json" "$ROOT/web/public/deployments.json"
cd "$ROOT/aggregator"
pnpm -s naive && pnpm -s demo && pnpm -s tamper
echo "Done. Results: web/public/results.json"
