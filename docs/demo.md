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

---

## Running the demo

One command runs all four beats against the deployed contracts on Monad testnet
(`aggregator/deployments.json`), using `PRIVATE_KEY` from the root `.env`:

```sh
cd aggregator
STEP=1 pnpm stage        # on stage: waits for Enter between beats
pnpm stage               # straight through (~15-20 s)
```

| Env var | Default | Meaning |
|---|---|---|
| `N` | `256` | ops in the batch (1-4096) |
| `STEP` | off | `1` = pause for Enter before each beat |
| `NAIVE` | off | `live` = send a fresh naive tx in Beat 3 instead of reusing the one in `results.json` |
| `BAD_INDEX` | `7` | which signature gets the flipped bit in Beat 4 |
| `RPC_URL`, `DEPLOYMENTS` | Monad testnet | point at anvil or another deployment |

Needs at least ~0.03 MON (two 0.01 MON bonds plus gas; the tamper bond comes back to the challenger).
Every run uses fresh keys, so it can be repeated. Results go to `aggregator/out/results.json` and
`web/public/results.json` (same shape as before, plus a `stage` field with tx hashes and timestamps).

**Expected output** (testnet run, 4 Nov 2026, N=256):

```
BEAT 1  What post-quantum signatures do to a Monad block  [CAPACITY MODEL, not live TPS]
  ECDSA (today)                                3,750 tx/block
  ML-DSA-44, sig + pk                            369 tx/block
  our naive WOTS (measured 2,276 B calldata)     659 tx/block
BEAT 2  Sign 256 post-quantum ops, put ONE batch on chain  [LIVE on Monad testnet]
  signed 256 WOTS ops (keygen + sign + Merkle root) in ~4-8 s
  submitBatch https://testnet.monadexplorer.com/tx/0x1078…
  gas charged 110,494 (432 gas/op) · calldata 228 B → 0.89 B/op
BEAT 3  Naive post-quantum vs Sigpress batch  [LIVE on Monad testnet]
  bytes on chain per op      2,276 B   vs   98 B (whole executed op; 0.89 B is only the root share)
BEAT 4  Flip ONE bit in ONE of 256 signatures  [LIVE on Monad testnet]
  challenger re-checks all 256 signatures off chain in ~40 ms → signature #7 is INVALID
  BATCH REJECTED, bond slashed
```

**What is live and what is a model:**
- Live on Monad testnet, with explorer links printed: the batch `submitBatch`, the naive tx (reused
  from `results.json` unless `NAIVE=live`), the tampered `submitBatch` and the `challenge` that slashes it.
- Capacity model, labelled on screen: Beat 1 (K1 block-capacity arithmetic from MIP-12 caps and FIPS 204
  sizes; the WOTS row uses our measured calldata) and the "PQ ops/block" row in Beat 3, which counts
  signature bytes only and ignores each op's execution gas. Neither is measured throughput.
- Gas figures are gas *charged*: Monad charges the gas limit, and our writes add a 30% buffer to viem's
  estimate, so a fresh naive tx shows ~143k rather than the earlier 118,606 (set without the buffer).
- This is the **optimistic** path (K7 fallback), not the STARK validity proof: signatures are checked
  off chain and fraud is caught by a bonded challenge within the window.
