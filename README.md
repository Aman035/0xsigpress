# Sigpress

**Post-quantum signature aggregation for Monad.** Users sign every transaction with a hash-based
post-quantum key; an aggregator proves a whole batch of those signatures valid in **one hash-based
STARK**; a single contract on Monad verifies the proof. Quantum-safe transactions stop eating Monad's
block space.

> Switch Monad's transactions to the post-quantum scheme in its own account-authentication draft
> (ML-DSA, ~3.7 KB) and a block's capacity drops from ~3,750 transactions to ~370 — a ~90% cut.
> Sigpress gives that capacity back at ~263 bytes per signature, on Monad today, with no fork.

This is a research-and-pitch repo targeting a [Monad Blitz](https://blitz.devnads.com) hackathon entry,
then a ~4-month product. Nothing is built until the kill tests pass.

## Docs

| File | What it is |
|---|---|
| [`docs/idea.md`](docs/idea.md) | What it is, what's new, honest limits |
| [`docs/pitch.md`](docs/pitch.md) | The pitch, with sources; bracketed numbers await measurement |
| [`docs/plan.md`](docs/plan.md) | Kill tests K1-K10, then the build — the source of truth for what to do next |
| [`docs/research.md`](docs/research.md) | Sourced facts on Monad, PQ verifiers, EIPs and aggregation |
| [`docs/decisions.md`](docs/decisions.md) | The fact-check pass and every kill-test answer, with sources |
| [`docs/demo.md`](docs/demo.md) | What the Blitz demo looks like, and the build checklist |

## What's live on Monad testnet (chain 10143)

The Blitz build ships the **optimistic** design from [`docs/demo.md`](docs/demo.md) — post-quantum end to
end, no STARK required yet. Real WOTS (hash-based) signatures, an optimistic aggregator that puts only a
32-byte Merkle root per batch on chain, PQ smart accounts that execute from finalized batches, and a
tamper → challenge → slash path.

Source-verified on MonadVision / Sourcify:

- **NaiveLane** `0xcFc286564ed4281E200c6D052f9E1A932b31E845`
- **OptimisticAggregator** `0xEAA3AC4807767F8fe5B8caD979cB523A926b2A1E`
- **PQAccountFactory** `0x7335b48f2d794d4a196618916Ec196a1a1615442`
- **SigpressAggregator4337** (IAggregator) `0xe6869caa26a2581880a8d237c1a1f9a26c6c212e`
- **PQAccount4337Factory** `0x21d2ee544075fb5da08bc44bd9a68f6d736e6563`
- Explorers: https://testnet.monadexplorer.com · https://testnet.monadvision.com

Measured so far: naive PQ verify **118,606 gas** / 2,276 B calldata; batch of 256 ops in one
`submitBatch` at **102,063 gas** (**0.89 bytes/op**); PQ-account execute **~134,634 gas**; one bad
signature **slashed on chain**. (See [`docs/decisions.md`](docs/decisions.md) for tx hashes.)

## Demo page

`web/` is a single static page: two capacity-model lanes (naive vs Sigpress), a scoreboard, the tamper
result, and Monad explorer links — all read from `web/public/results.json` + `deployments.json`.

```sh
cd web && python3 -m http.server 8080   # then open http://localhost:8080
```

It also opens directly from the filesystem (it falls back to embedded numbers if it can't fetch the JSON).
Gauges are labelled **"capacity model"** — the page never shows a faked live-TPS figure.

## Run the contracts and aggregator

```sh
# contracts (Foundry)
cd contracts && forge test

# aggregator (Node + viem): WOTS keygen/sign, Merkle batching, demo/tamper scripts
cd aggregator && pnpm install && pnpm test

# one-shot testnet deploy + demo (needs a funded PRIVATE_KEY in .env, never committed)
./scripts/testnet.sh
```

## Honest limits

- **Optimistic, not a validity proof (yet).** Today's on-chain object is a Merkle root + bond with a
  challenge window; the aggregator serves the signature data. The one-hash-based-STARK-over-N-signatures
  version is the product (kill tests K3–K6, ~4 months).
- **Stateful keys.** WOTS one-time keys must never be reused; the account rotates to a fresh key per op,
  signed into each message.
- Every number in the repo, on the page, or in the pitch is either measured on testnet (with a tx hash)
  or labelled a capacity model / sample.

## Status (4 Nov 2026)

Tier 0 kill tests pass: **K1** (naive ML-DSA cuts block capacity 85-90%) and **K2** (nobody has shipped
PQ aggregation on any chain). **K3** has a first local data point (a Spartan-WHIR Solidity verifier runs
on anvil at ~1.1M gas for an example proof); **K4** (a signature-batch proof verified on Monad testnet)
is still the go/no-go. See [`docs/decisions.md`](docs/decisions.md).

All numbers are either sourced (with links) or marked as unmeasured placeholders. Several EIP, Monad and
benchmark claims were corrected against primary sources on 4 Nov 2026.

## Licence

[MIT](LICENSE).
