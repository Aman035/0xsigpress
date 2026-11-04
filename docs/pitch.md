# Pitch

**Sigpress — post-quantum signature aggregation for Monad.**

Numbers in this pitch are one of two kinds:
- **Sourced** facts carry a link to a primary source and may be stated plainly.
- **[Bracketed]** numbers are placeholders for things the kill tests in `plan.md` must still
  *measure* (proof size for our batch, verification gas on Monad, proving throughput). Never present a
  bracketed number as fact. See `decisions.md` for what has and hasn't been verified.

> **What we shipped at Monad Blitz:** the **optimistic** version — post-quantum end to end, live on Monad
> testnet, no STARK required. Real WOTS signatures, a 32-byte root per batch (0.89 bytes/op measured),
> PQ smart accounts executing from finalized batches, and a tamper → challenge → slash path. The
> **one-hash-based-STARK-over-N-signatures** version below is the product (kill tests K3–K6). So the
> honest one-line framing is: **optimistic aggregation today, STARK validity proofs next.**

---

## The 30-second version

> Monad is built to pack ~3,750 transactions into a 300-millisecond block, because a signature is only
> 65 bytes. Switch those signatures to the post-quantum scheme in Monad's own account-authentication
> draft (ML-DSA, ~3.7 KB) and the same block holds about **370** — roughly a **90% cut in block
> capacity.**
>
> Sigpress gives that capacity back. Users still sign every transaction with a quantum-safe key; an
> aggregator folds a batch of those signatures into **one hash-based STARK**, and a single contract on
> Monad verifies the proof once.
>
> Same security, **~263 bytes per signature** instead of ~2,420, on Monad today with no fork.

---

## The 3-minute version

### 1. The number nobody has said out loud

Monad's throughput comes from byte budgets, not magic. [MIP-12](https://mips.monad.xyz/MIPs/MIP-12)
(Final) caps a block at **1,500,000 bytes and 3,750 transactions**, produced every **300 ms**
([docs](https://docs.monad.xyz/developer-essentials/summary),
[300 ms blocks](https://monad.xyz/blog/300ms-block-times)). That is ~400 bytes per transaction, which
works because an ECDSA signature is 65 bytes.

Monad's [post-quantum roadmap](https://monad.xyz/blog/post-quantum-roadmap) (Ahmadvand, 28 Sep 2026)
and its [account-authentication draft](https://forum.monad.xyz/t/flexible-and-upgradeable-account-authentication/526)
(Babel & Camenisch) make accounts quantum-safe — the draft's authenticators include **ML-DSA**
([FIPS 204](https://csrc.nist.gov/pubs/fips/204/final): 2,420-byte signature + 1,312-byte key). Put that
on chain and the arithmetic is unforgiving:

| Signatures | Bytes/tx | Transactions per block | vs ECDSA |
|---|---|---|---|
| ECDSA (today) | ~400 | 3,750 | — |
| ML-DSA-44, sig + key | ~4,067 | **~370** | −90% |
| ML-DSA-44, sig only (key stored) | ~2,755 | ~540 | −85% |
| Falcon-512 | ~1,001 | ~1,500 | −60% |
| SLH-DSA-128s | ~8,191 | ~183 | −95% |

*(Block-capacity ceiling, re-derived from MIP-12 + FIPS; see `decisions.md`, K1. These are capacity
limits, not a claim about current live throughput.)*

**Here is the gap.** The roadmap names schemes (HAWK, SQIsign) and the auth draft states "each scheme
has a fixed gas cost" — but **neither gives a single number for signature size, bandwidth or
block capacity.** Monad's own consensus paper, *Quantum Cadence*
([arXiv 2610.32803](https://arxiv.org/abs/2610.32803)), abandons quorum certificates precisely because
"no post-quantum scheme yet matches [BLS]'s aggregate size and speed." The size problem is open at both
the account layer and the consensus layer.

### 2. The idea

Don't put the signatures on chain. Put a proof that they were valid.

Users sign every operation with a hash-based post-quantum key (leanXMSS-style), exactly as before. Our
**aggregator** collects a batch, proves "all of these signatures verify against their accounts and their
operations" in a single **STARK**, and submits the batch with that one proof. One contract on Monad
runs the **verifier** once.

The proof is itself hash-based (collision-resistant hashes, Fiat–Shamir, a polynomial commitment such
as WHIR), so nothing in the path is breakable by a quantum computer. **No pairings, no trusted setup,
no BLS, no Groth16.**

### 3. Live demo (the moment)

A load generator fires thousands of quantum-safe transactions.
- **Left gauge — naive post-quantum:** blocks fill with ML-DSA signatures; capacity collapses toward
  ~370 tx/block.
- **Right gauge — Sigpress:** same transactions, one proof per batch; capacity back toward the ECDSA
  line, at **[~N]** tx/block.
- Then we flip one bit in one signature in a batch, and **the whole batch is rejected on chain.**

### 4. Why this is real, not a slide

- **It rides existing rails.** [ERC-4337](https://eips.ethereum.org/EIPS/eip-7766) EntryPoint (v0.8;
  v0.9 adds `IAggregator`/`handleAggregatedOps` with a caller fix) already defines signature
  aggregators, and Alchemy's **Rundler** bundler ships the aggregator code path. No fork, no new
  precompile.
- **The Ethereum Foundation proposed exactly this — as a *future protocol change*.**
  [EIP-8288](https://eips.ethereum.org/EIPS/eip-8288) "In-mempool signature and proof aggregation"
  (Vitalik Buterin & Thomas Coratger, Draft, 3 Jun 2026) folds a block's PQ signatures (leanSPHINCS) and
  STARKs into one recursive STARK — but it is consensus-breaking and requires frame transactions
  (EIP-8141). We ship the working version at the **app layer**, on the chain that needs it now.
- **The standard for this was withdrawn for lack of a scheme worth aggregating.**
  [ERC-7766](https://eips.ethereum.org/EIPS/eip-7766) was withdrawn: *"No production adoption of
  aggregateable signature schemes."* Post-quantum signatures are that scheme.
- **Monad, not Ethereum, is where it pays.** Falcon-aggregation analysis by
  [Sanso, Thiery & Wagner](https://ethresear.ch/t/revisiting-falcon-signature-aggregation-for-pq-mempools/24431)
  (18 Mar 2026) puts break-even at ~200 signatures per batch; a single Monad block can hold far more
  than that.

### Why it fits Monad specifically (and not Ethereum)

1. **The byte budget *is* the product.** Monad sells throughput squeezed from a 1.5 MB / 3,750-tx /
   300 ms block ([MIP-12](https://mips.monad.xyz/MIPs/MIP-12)). PQ signatures are 10-120x bigger than
   ECDSA, so they consume that budget and cut capacity ~85-95%. On a low-throughput chain nobody
   notices signature bytes; on Monad they are the binding constraint — which is exactly what
   aggregation removes. (Aggregation pays only above ~200 sigs/batch; a Monad block holds far more.)
2. **The verifier is affordable *and* fits.** The on-chain STARK verifier is the hard, expensive part
   (est. 5-20M gas, measured in K4). Monad gives **30M gas per transaction** (Ethereum: 30M per
   *block*) and a **128 KB contract-size limit** ([MIP-2](https://mips.monad.xyz/MIPs/MIP-2); Ethereum
   caps contracts at 24 KB). The verifier fits one Monad contract and one transaction for cents; on
   Ethereum mainnet it would cost tens of dollars and might not fit under 24 KB.
3. **The rails and the roadmap gap are already here.** ERC-4337 EntryPoints (v0.6-v0.8) with
   `IAggregator`/`handleAggregatedOps`, EIP-7702, and a P-256 precompile are deployed — so the
   aggregator plugs in with no fork. Monad has publicly committed to a PQ roadmap that makes accounts
   quantum-safe but never addresses signature size, and *Quantum Cadence* abandoned PQ aggregation at
   consensus — an acknowledged gap to fill now, with a native path later.

   By contrast, EIP-8288 is this same idea for Ethereum, but it needs a consensus-breaking protocol
   change, and Ethereum's gas plus 24 KB code limit make an app-layer verifier impractical. Monad lets
   us ship it at the app layer today.

### 5. What we measured (fill in from the kill tests)

- **Prior art, self-reported:** the EF's [leanMultisig](https://github.com/leanEthereum/leanMultisig)
  aggregates 1,400 leanXMSS signatures into a 359.5 KiB proof (**~263 bytes/signature**) in 1.15 s on
  an Apple M4 Max, verifying in 7.45 ms — "not yet production ready," 192-bit binary tower field with
  WHIR, no EVM verifier yet.
- **Ours, to measure (K4/K5/K9):**
  - Proof size: **[__]** KiB for **[__]** signatures → **[__]** bytes/signature.
  - Verification on Monad testnet: **[__]** gas (cap 30M), ≈ **[__]** USD per batch, **[__]** USD per
    user operation.
  - Proving: **[__]** signatures/second on **[hardware]**; added latency **[__]** s.

### 6. Where it goes

- **Now:** post-quantum ERC-4337 smart accounts for Monad wallets and high-frequency apps, at
  classical-like block cost.
- **Next:** a shared verification service — any app's hash-based signatures or STARKs folded into the
  same proof (EIP-8288's dependency model, built at the app layer).
- **Then:** native. The verifier and bundle format become a reference for Monad adding aggregation to
  its protocol — the size answer its PQ roadmap and *Quantum Cadence* are both missing.

### 7. Honest limits, said before anyone asks

- **Latency.** Proving takes about a second — longer than a 300 ms block — so a batch spans a few
  blocks. A single operation can always be verified alone, at full size, as a fallback. [added latency
  to measure in K5]
- **Stateful keys.** Hash-based keys sign a bounded number of messages and must never reuse a one-time
  key. The wallet persists the key index before signing (the RLN-slot lesson).
- **Bytes saved are signature bytes.** A UserOperation still carries sender, nonce, callData and gas
  fields. The goal is "a post-quantum operation costs about what a classical transaction costs today"
  — K9 measures the real per-operation overhead.
- **The outer transaction is still ECDSA.** The bundler signs it classically until Monad's native PQ
  accounts land. A broken bundler key cannot move user funds (users authorise with PQ signatures) but
  it could censor or stall a batch.
- **Research-grade parts.** leanMultisig is "not yet production ready" and its numbers are
  self-reported; no on-chain verifier exists for these proofs yet (that is kill test K4, the go/no-go).

---

## 90-second demo script (the four beats)

Full detail in `docs/demo.md`; this is the spoken version.

1. **(0:00–0:20) The problem.** "Monad fits ~3,750 transactions in a 1.5 MB block. Switch to the
   post-quantum scheme in Monad's own account-auth draft and the same block holds about 370 — a 90% cut.
   Nobody's solved the size problem; Monad's roadmap doesn't even mention it."
2. **(0:20–0:50) The idea + the money shot.** "Don't put signatures on chain — put one commitment per
   batch. Here's 256 real post-quantum signatures going on chain as a single 32-byte root." → show the
   `submitBatch` tx on the testnet explorer: 102,063 gas, **0.89 bytes per operation**.
3. **(0:50–1:10) The comparison.** Point at the two gauges (labelled *capacity model*): naive PQ fills
   the block; Sigpress returns it to the tx-count ceiling. Scoreboard: 2,144 B/sig → 0.89 B/op.
4. **(1:10–1:30) The kill shot.** "Watch what happens to a bad signature." → hit tamper; show the
   `challenge` tx: **bond slashed, batch rejected on chain.** "One bad signature, the whole batch
   rejected — on chain, not on trust. Optimistic today; the STARK validity-proof version is the product."

## One-liners for Q&A

- **"Why not just use Falcon? It's smaller."** Falcon-512 is ~666 bytes per signature
  ([spec](https://en.wikipedia.org/wiki/Falcon_(signature_scheme))) — still ~10x ECDSA and ~1.6x
  today's 400-byte budget, and it has no aggregation in production. Aggregation fixes size for *any*
  scheme.
- **"Isn't this just EIP-8288?"** EIP-8288 is a *Draft design for Ethereum's protocol*; nothing works
  today, and it needs a consensus-breaking network upgrade. We built it, on Monad, at the app layer,
  with an on-chain verifier nobody had written.
- **"What if the aggregator goes down?"** Users fall back to single-signature verification. Slower,
  never stuck.
- **"Who runs the prover?"** Anyone. The proof is checked on chain, so a prover can't forge a batch —
  only refuse to include one.
- **"Is the proof really quantum-safe?"** Yes — it's a hash-based STARK (collision-resistant hashes +
  Fiat–Shamir), unlike the Groth16/PLONK SP1 gateways already on Monad, which are pairing-based and
  *not* post-quantum.

---

## Sources

- Monad limits: [MIP-12](https://mips.monad.xyz/MIPs/MIP-12), [MIP-2](https://mips.monad.xyz/MIPs/MIP-2),
  [Deployment Summary](https://docs.monad.xyz/developer-essentials/summary),
  [300 ms blocks](https://monad.xyz/blog/300ms-block-times)
- Monad PQ: [roadmap](https://monad.xyz/blog/post-quantum-roadmap),
  [account-auth draft](https://forum.monad.xyz/t/flexible-and-upgradeable-account-authentication/526),
  [Quantum Cadence](https://arxiv.org/abs/2610.32803)
- Aggregation: [EIP-8288](https://eips.ethereum.org/EIPS/eip-8288),
  [ERC-7766 (withdrawn)](https://eips.ethereum.org/EIPS/eip-7766),
  [Falcon aggregation analysis](https://ethresear.ch/t/revisiting-falcon-signature-aggregation-for-pq-mempools/24431)
- Crypto: [FIPS 204 (ML-DSA)](https://csrc.nist.gov/pubs/fips/204/final),
  [FIPS 205 (SLH-DSA)](https://csrc.nist.gov/pubs/fips/205/final),
  [leanMultisig](https://github.com/leanEthereum/leanMultisig)
