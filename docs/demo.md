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

Needs at least 3 × the bond (1.5 MON at the current 0.5 MON bond) for beats 1-4, plus ~2.4 MON when Beat 5 runs.
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
- Beats 2-4 are the **optimistic** path (the fallback): signatures are checked off chain and fraud is
  caught by a bonded challenge within the window. Beat 5 is the STARK validity proof, the headline (below).

---

## Beat 5 (the headline): the trustless validity proof

Updated 4 Nov 2026 for binding v2 (`experiments/k10-terminal/binding-v2/README.md`). After beats 1-4, Beat 5
submits **one STARK over 2 × 1024 leanXMSS signers, each over its own 32-byte message**, to
`SigpressBindV2Gate` on Monad testnet in one tx. The gate rebuilds the proof's statement from the 2,048 raw public
keys and messages in calldata (no registrar, no register step). Proving takes ~1.5 min and ~6-14 GB, so the stage
**does not prove live**: it submits a proof built beforehand.

```sh
cd aggregator
# 1. before the demo: 2,048 fresh SDK keys each sign their own op hash; prove (holds the shared prover lock); no tx
SHAPE=2x1024 PROVE_ONLY=1 pnpm validity
# 2. on stage: beats 1-4, then Beat 5 submits the latest pre-built 2 x 1024 proof the gate has not accepted yet
KEY_VAR=PRIVATE_KEY_K14 STEP=1 pnpm stage            # Beat 5 runs automatically when such a proof exists
KEY_VAR=PRIVATE_KEY_K14 VALIDITY=1 STEP=1 pnpm stage # or force it (fails up front if there is no fresh proof)
```

| Env var | Meaning |
|---|---|
| `VALIDITY` | `1` = Beat 5 required, `0` = off; unset = on if a pre-built, not-yet-accepted proof exists |
| `VALIDITY_SHAPE` | `2x1024` (default) or `2x256` |
| `PROOF_DIR` | the proof to submit; default: newest under `out/validity/` for the shape that the gate has not accepted |

Each proof can be submitted **once**: the gate rejects a replay (`AlreadyAccepted`), so build a fresh proof per
stage run. A 2 × 1024 submit costs ~2.4 MON at 102 gwei (~22.1M gas estimate + 5%; Monad charges the limit), on top
of beats 1-4 (bond 0.5 MON on the current OptimisticAggregator; each tamper burns 0.25 MON). The stage checks the
balance before Beat 1. Before sending, it `eth_call`s the verifier and the unmodified submit, so a bad proof never
costs a reverted 22M-gas tx.

On screen: the signer count and "each over its own 32-byte message", the tx link, gas charged, calldata, gas/sig and
bytes/sig, then five `eth_call` negatives sent before the submit (1 bit flipped in the proof → `MERKLE_ROOT`; one
signer's message changed, one pubkey changed, the two batches swapped, slot + 1 → `RootMismatch`) and one after it
(the same submit again → `AlreadyAccepted`).

**Say out loud** (the screen prints it): bound on chain are the slot, every signer's public key, every signer's own
message, their order and count, and both batches. **Not bound / limits:** the gate binds keys, not Ethereum accounts
(the `ValidityEntry` registry does that: an account sets its key once, at creation); one verifier per batch shape
(2 × 256 and 2 × 1024 deployed; the service pads with filler signers); the cheap binding (keccak challenge +
polynomial identity over F_p^5) is our argument and has not been externally reviewed; one slot and two batches per
proof; security is the leanVM authors' 100-bit component targets, full-chain composition not analysed.

**Measured** (Monad testnet, 4 Nov 2026): see the stage run recorded in `docs/decisions.md` ("STARK path as the
default"), and `pnpm validity` (2 × 256, SDK-signed, 512 distinct messages):
[`0x58793519…f7b`](https://testnet.monadexplorer.com/tx/0x58793519fb294680ecd1b69dffe26580bc59e3ac5ddb4c28ceaec1396de99f7b),
estimate 14,968,702, charged 15,717,137 gas (30,698 gas/sig), calldata 139,844 B (273.1 B/sig).

The old v1 Beat 5 (registrar-trusted `SigpressTerminalGate`, one shared message per batch) is superseded; its run is
kept in `docs/decisions.md` (K10).
