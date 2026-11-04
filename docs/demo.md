# Demo

What Sigpress looks like on stage at Monad Blitz. The guiding rule: **the credible core is live on
Monad testnet; the throughput gauges are a visualization driven by measured numbers, and we say so.**
A judge who catches an unlabeled fake throughput meter discounts the whole project.

Numbers in **[brackets]** come from the kill tests (`plan.md`) and must be real by demo day.

---

## The screen

One page, two lanes racing the *same* stream of quantum-safe transactions, with a live Monad testnet
explorer panel underneath.

```
┌─────────────────────────────┬─────────────────────────────┐
│  NAIVE POST-QUANTUM         │  SIGPRESS (aggregated)       │
│                             │                              │
│  Block ▓▓▓▓▓▓▓▓░░  FULL     │  Block ▓░░░░░░░░░             │
│  ~370 tx / block            │  [N] tx / block              │
│  2,420 bytes / signature    │  ~263 bytes / signature      │
└─────────────────────────────┴─────────────────────────────┘
┌──────────────────────────────────────────────────────────┐
│  MONAD TESTNET   tx 0xabc…  ✓ 1,024 sigs verified          │
│                  [__]M gas · proof [__] KiB · 1 tx         │
│  [ Tamper one signature ]                     explorer ↗   │
└──────────────────────────────────────────────────────────┘
```

A corner **scoreboard** holds the five judge-facing numbers, each measured (not bracketed) by demo day:
bytes/signature · tx/block capacity · gas/batch · gas/operation · proving time.

---

## The four beats (~90 seconds)

1. **Start the load generator.** The same batch of PQ-signed ERC-4337 `UserOperation`s flows into both
   lanes. The left lane puts each full ML-DSA signature on chain — the block bar fills in a few hundred
   ops and shows "FULL — ~370 tx." The right lane sends signatures to the aggregator; nothing large
   goes on chain.

2. **The money shot — real on-chain verification.** The aggregator proves the batch (a ~1 s spinner,
   genuinely real), then submits **one** transaction to Monad testnet. The explorer panel lights up
   with the *actual* tx: "1,024 signatures verified · [__]M gas · proof [__] KiB · single transaction,"
   with a clickable testnet-explorer link. **This is the part nobody has done before.**

3. **The comparison.** Both counters settle: left ~370 tx/block of capacity, right [N]; bytes per
   signature 2,420 → ~263. Same security, capacity restored.

4. **The kill shot.** Hit **"Tamper one signature"** — it flips one bit in one signature in the batch,
   re-proves, and re-submits. The verifier contract **reverts on chain**, and the explorer shows the
   failed tx. The line: *"One bad signature, the whole batch rejected — on chain, not on trust."*

---

## What is real vs. what is a visualization (said out loud)

**Genuinely live on Monad testnet** (the credible core):
- Hash-based (leanXMSS) keys and signatures.
- The hash-based STARK proof over the batch.
- The verification transaction and its real gas cost.
- The tamper rejection.
- All with Monad testnet explorer links the audience can open.

**A visualization, driven by *measured* numbers and labeled as such:**
- The two block-filling gauges and capacity counters. We cannot safely drive Monad at full block rate
  from a booth, and the honest claim is **block capacity**, not live TPS — so the gauges animate the
  K1 capacity math and the K4/K5 proof figures. They do not fake a 10k-TPS firehose, and the screen
  labels them "capacity model."

---

## Build checklist for the Blitz day

Per `plan.md` Part 3, only research and kill-test measurements happen before the event; the pieces below
are rebuilt on the day in a public repo, deployed on Monad testnet. Each maps to a kill test that must
already have passed.

| # | Piece | Depends on | Notes |
|---|---|---|---|
| 1 | PQ test account + aggregator contract with the verifier | **K4** (go/no-go) | The hard part — this is why K4 must already pass. If K4's verifier can't be rebuilt in a day, pre-stage it and only wire it up. |
| 2 | Prove a batch of real leanXMSS signatures off chain; verify on testnet | **K5**, **K6** | Produces the real tx for Beat 2. |
| 3 | `handleAggregatedOps` path (or own entry contract) | **K8**, **K9** | Use EntryPoint v0.8 + Rundler; fall back to our own entry contract if aggregation is blocked. |
| 4 | Two-gauge demo page + scoreboard | K1 capacity + K4/K5 numbers | The visualization layer; label the gauges "capacity model." |
| 5 | Tamper button → on-chain rejection | K4 | The kill shot (Beat 4). |

---

## If K4 slips (the honest fallback)

If the full validity-proof verifier is not ready on testnet in time, the demo degrades gracefully and
still verifies a real PQ signature on Monad, which nothing else does:

- **Single-signature on-chain PQ verification** (hash-based, ~73k-150k gas, self-reported) live on
  testnet, and
- the **optimistic-aggregation** path (K7): signatures off chain with a bond, where the tamper moment
  becomes a fraud proof that slashes the bond.

Same four beats, same kill shot, smaller headline number — and the pitch is reworded to "optimistic"
per the go/no-go table in `plan.md`.
