<div align="center">

# Sigpress

### Post-quantum signatures without losing Monad's throughput

One hash-based proof replaces a whole batch of post-quantum signatures, so Monad can go quantum-safe
**without a 90% cut in block capacity.**

[![Monad testnet](https://img.shields.io/badge/Monad-testnet%20(10143)-836EF9)](https://testnet.monadexplorer.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Built at](https://img.shields.io/badge/built%20at-Monad%20Blitz-111)](https://blitz.devnads.com)
[![Status](https://img.shields.io/badge/optimistic-live%20on%20testnet-35D07F)](docs/decisions.md)
[![Demo](https://img.shields.io/badge/demo-live-836EF9)](https://aman035.github.io/sigpress/)

</div>

---

## The problem

**Monad is fast because it rations bytes.** A block is capped at **1.5 MB and 3,750 transactions**, every
**300 ms** ([MIP-12](https://mips.monad.xyz/MIPs/MIP-12)). That budget only works because an ECDSA
signature is **65 bytes**, so an average transaction is ~400 bytes and 3,750 of them fit.

**Quantum computers break that signature.** Shor's algorithm recovers an ECDSA private key from its public
key — so the day a large quantum computer exists, any account whose key has touched the chain can be
drained. The fix is **post-quantum signatures**, but they are **10–120× bigger**: ML-DSA-44, the scheme in
Monad's own account-auth draft, is **~3.7 KB** (signature + key).

**Put those on chain and the signature *is* the transaction** — so far fewer fit in a block:

| Signature | Bytes/tx | Tx per 1.5 MB block | vs ECDSA |
|---|---:|---:|---:|
| ECDSA (today) | ~400 | **3,750** | — |
| ML-DSA-44 (Monad's PQ draft) | ~4,067 | **~370** | **−90%** |
| Falcon-512 | ~1,001 | ~1,500 | −60% |
| SLH-DSA-128s | ~8,191 | ~183 | −95% |

<sub>Capacity ceiling from [MIP-12](https://mips.monad.xyz/MIPs/MIP-12) + [FIPS 204](https://csrc.nist.gov/pubs/fips/204/final) — a capacity limit, not a live-TPS claim.</sub>

At MIP-12's ~400 B/tx model that's a **~90% capacity cut** for ML-DSA; even at today's *measured* mainnet
mix (~1,728 B/tx average) it's still a **58–76% cut**. Either way, quantum-safe Monad is a far slower Monad.

**And it's coming, unaddressed.** NIST finalized the PQ signature standards in 2024, Ethereum targets a
quantum-safe L1 by ~2029, and Monad has published a PQ roadmap — but that roadmap makes accounts
quantum-safe **without once mentioning signature size**, and Monad's own consensus paper *Quantum Cadence*
gave up on aggregate signatures because "no post-quantum scheme matches BLS." Nobody has even sized this
problem, let alone solved it.

**Sigpress's answer:** don't put the signatures on chain — put **one hash-based proof** that they were all
valid, and let Monad check the proof once. Users still sign with quantum-safe keys; a post-quantum
operation costs **98 bytes** on chain instead of 2,276 (**23× smaller**, measured on testnet today).

---

## What we built — live & measured on Monad testnet

> **Optimistic aggregation is live today, and the STARK validity-proof chain now runs end to end:** our own
> leanXMSS signature batches → leanVM → Keccak terminal proof → verified on Monad in **one tx (~12.2M gas)**
> ([tx](https://testnet.monadexplorer.com/tx/0x55212a0000c95dd33fcdc9510a32434afe1143dd73b1391bcde0098d79904f92)). On-chain cost is flat in N (~208 B and ~24k gas per signature at 2 × 256, anvil). Binding
> to per-op messages and a trustless batch link are still in progress. Every number below
> has a tx hash in [`decisions.md`](docs/decisions.md).

| | Measured on Monad testnet |
|---|---|
| 🟢 **Batch of 256 ops → one 32-byte root** | **102,063 gas · 0.89 bytes/op of signature overhead** |
| 🟢 **Compact bundle: 128 PQ ops executed in one tx** | **98 bytes/op on chain** · ~27k gas/op ([tx](https://testnet.monadexplorer.com/tx/0xf37a32806cda56f3493d2880bf181df2abf0c084e2894e87dca7edd7df1defbd)) |
| ⚪ Naive PQ (one signature on chain) | 118,606 gas · 2,276 bytes |
| 🔪 **Tamper one signature** | `challenge` → **bond slashed, batch rejected on chain** |
| 👤 PQ 4337 account executes from a finalized batch | ~134,634 gas |
| 🔗 Standard `handleAggregatedOps` (EntryPoint v0.8) | 4-op aggregated bundle executes (828,003 gas) |
| 🧮 **STARK verifier (hash-based, no pairings)** | deployed on Monad, **verifies a proof in one tx (~12.84M gas)**; tampered proof reverts |
| 🧮 **Our own signatures through the STARK chain** | 2 × 4 leanXMSS sigs → terminal proof → **verified on Monad, one tx, ~12.2M gas** ([tx](https://testnet.monadexplorer.com/tx/0x55212a0000c95dd33fcdc9510a32434afe1143dd73b1391bcde0098d79904f92)); tampered proof and swapped roots revert |
| ⚙️ Prover | **1,024 signatures → 326 bytes/sig in 2.29 s** (→ ~61 B/sig with recursion) |

---

## Try it

```sh
# Demo page (two capacity lanes + scoreboard + live explorer links)
cd web && python3 -m http.server 8080   # → http://localhost:8080

# Contracts & aggregator
cd contracts && forge test
cd aggregator && pnpm install && pnpm test

# One-shot testnet deploy + demo (needs a funded PRIVATE_KEY in .env)
./scripts/testnet.sh
```

🔗 **Live demo page: https://aman035.github.io/sigpress/**

---

## How it works

```
 user keys (WOTS)          aggregator (viem)              Monad testnet (Solidity)
 ───────────────           ─────────────────              ────────────────────────
 sign each op       ──────▶ batch N signed ops            NaiveLane.submit        ← naive lane
                            build Merkle root ──root+bond▶ OptimisticAggregator.submitBatch
 challenger         ── leaf+sig ──────────────────────────▶   verify 1 WOTS sig → slash  ← tamper beat
 web/ demo page     ◀── deployments.json + results.json    PQAccount executes from finalized batch
```

The proof is hash-based end to end (Keccak Merkle + Fiat–Shamir + a WHIR commitment) — **no pairings, no
trusted setup, no BLS, no Groth16.** That's why it's quantum-safe, unlike the Groth16/PLONK SP1 gateways
already on Monad. ([Why hash-based = quantum-proof, in `pitch.md`.](docs/pitch.md))

---

## Why Monad — and not any other chain

1. **The byte budget *is* Monad's product.** PQ signatures eat 60–95% of block capacity on any full chain;
   on a throughput chain that's the binding constraint, which is exactly what aggregation removes.
2. **The verifier fits *and* is cheap — measured.** Our STARK verifier is **62.7 KB: it deploys under
   Monad's 128 KB limit but would *not* fit Ethereum's 24 KB**, and a proof verifies for **~12.84M gas**
   (Monad gives 30M gas *per tx*; Ethereum gives 30M per *block*).
3. **The rails and the gap are already here.** ERC-4337, EIP-7702 and a P-256 precompile are deployed, and
   Monad's roadmap leaves the size question open. We ship it at the **app layer, today.**

> **Credit:** the aggregation idea is **EIP-8288's** (Buterin & Coratger) — proposed for Ethereum's
> protocol, needing a hard fork, not working anywhere yet. Sigpress is a working **app-layer
> implementation** of that design on Monad, with the on-chain verifier it only specifies. We build on
> 8288; we don't claim the concept.

---

## Honest limits

- **Validity proof is early.** The STARK chain verifies our own signature batches on Monad, but today:
  the batch-root ↔ proof link is set by one trusted address, all signers in a batch sign one message,
  it uses the older Poseidon leanXMSS (not our Keccak WOTS), and proving takes ~40-60 s on a laptop.
  The live product path is still the optimistic one (root + bond + challenge window).
- **Stateful keys.** Hash-based one-time keys must never be reused; the account rotates per op.
- **Every number** here is measured on testnet (tx hash in [`decisions.md`](docs/decisions.md)) or
  labelled a capacity model.

---

## Repo

| Path | What |
|---|---|
| [`docs/pitch.md`](docs/pitch.md) | The full pitch: problem, why-build, why-Monad, efforts, gaps, next |
| [`docs/idea.md`](docs/idea.md) | What it is, what's new, honest limits |
| [`docs/demo.md`](docs/demo.md) | The demo script |
| [`docs/decisions.md`](docs/decisions.md) | Every measured number, with tx hashes |
| [`docs/sdk.md`](docs/sdk.md) | TS SDK: XMSS accounts + crash-safe key state |
| `contracts/` · `aggregator/` · `web/` | Solidity · TS aggregator + SDK · demo page |

**Verified contracts (MonadVision / Sourcify):** NaiveLane `0xcFc2…E845` · OptimisticAggregator
`0xEAA3…2A1E` · PQAccountFactory `0x7335…5442` · SigpressAggregator4337 `0xe686…212e` ·
PQAccount4337Factory `0x21d2…6563`.

---

<div align="center">
<sub>Built at Monad Blitz · MIT licensed · post-quantum, on the chain that needs it first.</sub>
</div>
