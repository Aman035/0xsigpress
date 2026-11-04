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

## Status (4 Nov 2026)

Tier 0 kill tests pass: **K1** (naive ML-DSA cuts block capacity 85-90%) and **K2** (nobody has shipped
PQ aggregation on any chain). The critical path now starts at **K3** (choose a proof system) → **K4**
(verify a real proof on Monad testnet — the go/no-go). See [`docs/decisions.md`](docs/decisions.md).

All numbers are either sourced (with links) or marked as unmeasured placeholders. Several EIP, Monad and
benchmark claims were corrected against primary sources on 4 Nov 2026.
