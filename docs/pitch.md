# Pitch

**Sigpress — post-quantum signature aggregation for Monad.**

Every number below is either **sourced** (primary-source link) or **measured on Monad testnet** (with a
tx hash in `decisions.md`). Where something is an estimate, it says so.

> **One-line framing:** optimistic aggregation is **live on Monad testnet today**, and the hash-based-STARK
> validity proof **now runs end to end on our own signatures**: leanXMSS batches → leanVM → Keccak
> terminal proof → **verified on Monad in one tx, ~12.2M gas** ([tx](https://testnet.monadexplorer.com/tx/0x55212a0000c95dd33fcdc9510a32434afe1143dd73b1391bcde0098d79904f92)). Remaining: trustless
> batch binding and per-op messages. See §3 (efforts) and §4 (unknowns).

---

## The 30-second version

> Monad packs ~3,750 transactions into a 300 ms block because an ECDSA signature is 65 bytes. Switch to
> the post-quantum scheme in Monad's own account-auth draft (ML-DSA, ~3.7 KB) and the same block holds
> about **370** — a **~90% cut in block capacity**. Nobody has said this out loud; Monad's own roadmap
> never mentions signature size.
>
> Sigpress gives the capacity back: users sign with quantum-safe keys; an aggregator folds a batch into
> **one hash-based proof** and Monad checks it once. Live on testnet today, one 32-byte root per batch
> (signature overhead **0.89 B/op**; a whole executed op is **98 B** vs 2,276 B naive, measured); the one-STARK-over-1,024-signatures version is proven feasible and is the
> product.

---

## 1. The problem

Monad's throughput is a byte budget, not magic. [MIP-12](https://mips.monad.xyz/MIPs/MIP-12) (Final) caps
a block at **1,500,000 bytes and 3,750 transactions** every **300 ms**
([docs](https://docs.monad.xyz/developer-essentials/summary)) — ~400 bytes per transaction, which only
works because ECDSA is 65 bytes. Post-quantum signatures are 10–120× bigger, so they eat the budget:

| Signature | Bytes/tx | Tx per block | vs ECDSA |
|---|---|---|---|
| ECDSA (today) | ~400 | 3,750 | — |
| ML-DSA-44, sig + key | ~4,067 | **~370** | −90% |
| ML-DSA-44, sig only (key stored) | ~2,755 | ~540 | −85% |
| Falcon-512 | ~1,001 | ~1,500 | −60% |
| SLH-DSA-128s | ~8,191 | ~183 | −95% |

*(Block-capacity ceiling from MIP-12 + [FIPS 204](https://csrc.nist.gov/pubs/fips/204/final); a capacity
limit, not a live-TPS claim. See `decisions.md`, K1.)*

And it is an **acknowledged-but-unsolved** problem on Monad. The
[PQ roadmap](https://monad.xyz/blog/post-quantum-roadmap) (Ahmadvand, 28 Sep 2026) and the
[account-auth draft](https://forum.monad.xyz/t/flexible-and-upgradeable-account-authentication/526)
(Babel & Camenisch) make accounts quantum-safe but give **no number for signature size or block
capacity**. Monad's consensus paper *Quantum Cadence* ([arXiv 2610.32803](https://arxiv.org/abs/2610.32803))
drops BLS quorum certificates precisely because "no post-quantum scheme yet matches [BLS]'s aggregate
size and speed." Open at the account layer, explicitly unsolved at the consensus layer.

**The idea:** don't put the signatures on chain — put a proof that they were valid. Users sign every op
with a hash-based key; the aggregator proves "all N signatures verify" in one hash-based STARK; one Monad
contract verifies it. The proof is hash-based (Keccak Merkle + Fiat–Shamir + a WHIR commitment), so the
whole path is quantum-safe — **no pairings, no trusted setup, no BLS, no Groth16** (unlike the Groth16/PLONK
SP1 gateways already on Monad, which are *not* post-quantum).

**Credit where it's due:** this aggregation approach is **not ours** — Vitalik Buterin & Thomas Coratger
proposed in-mempool PQ signature + STARK aggregation for Ethereum's protocol in
[EIP-8288](https://eips.ethereum.org/EIPS/eip-8288) (Draft, Jun 2026). Sigpress is a working **app-layer
implementation of that design** on the chain that needs it first, with the on-chain hash-based verifier
EIP-8288 only specifies. We build on 8288; we don't claim the idea.

## 2. Why it's worth building

**The threat is scheduled, not hypothetical.** NIST finalized the PQ signature standards in Aug 2024
(ML-DSA / FIPS 204, SLH-DSA / FIPS 205); Ethereum targets a quantum-resistant L1 by ~Dec 2029; Monad has
published a PQ roadmap. The industry has already decided PQ is coming — the open question is the *cost*
of getting there. The day elliptic-curve crypto falls, every ECDSA account whose public key is on chain
(any address that has ever spent) can be forged and drained. Migration takes years, so the work must
start before Q-day, not after.

**Every throughput chain hits the same wall — Monad first.** PQ signatures are 10–120× bigger than
ECDSA, so going quantum-safe costs 60–95% of block capacity on any chain that is full. That makes
aggregation the *enabling primitive* for PQ at scale, not a nice-to-have. Monad, whose product is
throughput, is where it bites first and hardest — so a working answer is most valuable and most visible
here.

**It's infrastructure, not a feature.** A shared PQ-verification service is something wallets, games,
exchanges and the protocol itself come to depend on — a primitive like a bundler or a DA layer, with the
moat that comes from being depended on. The natural end state is Monad adopting it natively; being the
reference implementation is the position you want when that happens.

**The timing window is open now.** A year ago no hash-based STARK verifier ran in the EVM; the tooling
(leanVM, WHIR, sol-whir) only reached feasibility in 2026 — which this project just demonstrated on
Monad testnet. Once chains ship PQ aggregation natively it becomes table stakes. The window to be first,
and to shape the standard, is short and open today.

**The downside is already useful.** Even if the full validity-proof path slips, the optimistic version
is live and delivers a 2.3× byte reduction with real PQ signatures on Monad now. This is not a bet that
pays only on a research breakthrough — it ships value at every stage.

## 3. Why only Monad — and not any other ecosystem

Three reasons, each now backed by a measurement, not a claim:

1. **The byte budget is Monad's product.** Throughput squeezed from 1.5 MB / 3,750 tx / 300 ms is the
   whole pitch of the chain, so signature bytes are the *binding constraint* — exactly what aggregation
   removes. On a low-throughput L1 nobody notices signature size, so nobody needs this. Aggregation pays
   above ~200 sigs/batch ([Sanso, Thiery & Wagner](https://ethresear.ch/t/revisiting-falcon-signature-aggregation-for-pq-mempools/24431));
   a Monad block holds far more.
2. **The verifier fits *and* is affordable — measured.** Our hash-based STARK verifier is **62.7 KB**: it
   deploys under Monad's **128 KB** contract limit ([MIP-2](https://mips.monad.xyz/MIPs/MIP-2)) but
   **would not deploy on Ethereum** (24 KB). Verifying a proof cost **~12.84M gas** in one transaction on
   Monad testnet — Monad gives **30M gas per transaction** (Ethereum: 30M per *block*), so it's cents
   here and tens of dollars, if it fit at all, on Ethereum mainnet.
3. **The rails and the gap are already on Monad.** ERC-4337 EntryPoints (v0.6–v0.8), EIP-7702 and a P-256
   precompile are deployed, so the aggregator plugs in with no fork. Monad has publicly committed to a PQ
   roadmap that leaves the size question open. The design we implement,
   [EIP-8288](https://eips.ethereum.org/EIPS/eip-8288) (Buterin & Coratger, Draft), targets Ethereum as a
   *consensus-breaking protocol change* that requires frame transactions (EIP-8141) and does not exist yet.
   We ship the same idea at the **app layer, on the chain that needs it, today.** And [ERC-7766](https://eips.ethereum.org/EIPS/eip-7766)
   (signature aggregation for 4337) was *withdrawn* for "no production adoption of aggregateable signature
   schemes" — post-quantum is that scheme.

## 4. The efforts — what's built and measured (all on Monad testnet)

**Optimistic lane — live end to end:**
- **Naive PQ baseline:** one WOTS (hash-based) signature verified fully on chain — **118,606 gas, 2,276 B**.
- **Sigpress batch:** 256 ops folded into one 32-byte Merkle root — **102,063 gas, 0.89 bytes/op** of
  signature overhead.
- **Compact execution:** 128 PQ ops executed in one `executeBundle` tx — **98 bytes/op on chain**, ~27k
  gas/op (vs 2,276 B naive, 990 B via ERC-4337).
- **The kill shot:** one tampered signature → `challenge` → **bond slashed, batch rejected on chain**.
- **PQ accounts:** ERC-4337-style accounts execute transfers only from a finalized batch, key rotating
  per op — **~134,634 gas/execute**.
- **Standard 4337 holds (K8):** a 4-op aggregated bundle runs through `handleAggregatedOps` on the real
  v0.8 EntryPoint on Monad testnet (**828,003 gas**), via a custom `IAggregator`.

**Validity-proof path — proven feasible:**
- **Verifier (K4):** a hash-based STARK verifier (sol-spartan-whir, KoalaBear + Keccak, no pairings,
  no Poseidon in the EVM) deployed on Monad testnet and **verified a proof in one tx at ~12.84M gas**;
  a 1-bit-tampered proof reverts (`MERKLE_ROOT`).
- **End to end on our signatures (K10):** 2 × 4 leanXMSS signatures → leanVM → lift → Keccak terminal
  proof (≈110 KB) → our generated verifier + gate on Monad: **one tx, ~12.2M gas** ([tx](https://testnet.monadexplorer.com/tx/0x55212a0000c95dd33fcdc9510a32434afe1143dd73b1391bcde0098d79904f92)).
  On anvil 2 × 256 costs the same (~12.1M gas, 106,628 B calldata) → **~24k gas, ~208 B per signature**,
  flat in N. Proving 40-58 s, ~6 GB RSS on a 16 GB M4. Not yet bound: trustless batch link, per-op messages.
- **Prover (K5):** leanVM aggregates **1,024 leanXMSS signatures → 326 B/sig** in **2.29 s** (verify
  9.5 ms); 4×1,024 recursion reaches **~61 B/sig**. Comfortably under the 400 B/sig and 3 s bars.

## 5. The gap and the unknowns (said before anyone asks)

**The chain now runs end to end on our own signatures** (K10): leanXMSS batch → leanVM → lift → Keccak
terminal proof → **verified on Monad in one tx (~12.2M gas)**, tampered proof and swapped roots revert,
and cost is **flat in N (~208 B, ~24k gas per signature)**. The feasibility question — "can one hash-based
STARK prove many PQ signatures and be checked on Monad in budget?" — is answered *yes*. What remains is
**hardening, not feasibility**:

- **Trustless batch binding.** Today the batch-root ↔ proof link is posted by one trusted address; it
  needs a trustless on-chain link between the proof's public input and the batch.
- **Per-op messages.** All signers in a batch currently sign one shared message; real operations need a
  distinct per-op message bound into the proof.
- **Scheme alignment.** The working chain uses Poseidon-based leanXMSS, not our on-chain Keccak WOTS; the
  two must converge.
- **Proving speed.** The terminal proof takes ~40–58 s on a 16 GB laptop (~6 GB RSS) — longer than a
  block, so batches span blocks or need better hardware.
- **K9 (bytes/op): the generic 4337 path missed the 1.5× target (990 B/op) — now fixed.** The compact
  `SigpressEntry` bundle (root recomputed on chain, no per-op proofs) measures **98 B/op at N=128 on
  Monad testnet — 0.25–0.32× a normal tx**, well under target. The plain `handleAggregatedOps` path
  stays 990 B/op because of UserOp ABI padding.
- **Latency:** proving ~2.3 s > a 300 ms block, so batches span blocks; single-op verification is always
  available as a fallback.
- **Licences (checked):** leanMultisig/Plonky3/Stwo are MIT/Apache; but sol-whir pulls in GPL-3.0
  `solidity-bn254`, sol-spartan-whir has **no LICENSE file** (README says MIT), and eth-infinitism is
  GPL-3.0 — so our 4337 interfaces were written fresh (MIT) and nothing GPL is copied. A clean licence is
  required before reusing the verifier.
- **Bundler/mempool:** the on-chain path works, but no third-party bundler (Rundler) or hosted Monad
  bundler has accepted ops for our aggregator yet; v0.9 untested.
- **Stateful keys:** WOTS/XMSS one-time keys must never be reused; the wallet rotates per op.

## 6. What can be done next

- **Now (shipped):** optimistic PQ aggregation + PQ 4337 accounts, live on testnet.
- **Days:** compact bundle format to beat the K9 byte target; test a real bundler (Rundler).
- **1–4 weeks:** obtain/rebuild the terminal prover, bind its public input to our batch root, align the
  signature scheme → **close the end-to-end validity proof** (prove 1,024 real signatures → terminal
  proof → verify on Monad in one tx). This is the headline.
- **Later:** a shared verification service — any app's hash-based signatures or STARKs folded into one
  proof (EIP-8288's dependency model, at the app layer) — and a reference for Monad adding aggregation
  natively, the size answer its roadmap and *Quantum Cadence* are missing.

---

## 90-second demo script (the four beats)

Full detail in `docs/demo.md`.

1. **(0:00–0:20) Problem.** "Monad fits ~3,750 tx in a 1.5 MB block. Switch to the PQ scheme in Monad's
   own account-auth draft and it holds ~370 — a 90% cut. The roadmap never mentions signature size."
2. **(0:20–0:50) Idea + money shot.** "Don't put signatures on chain — put one commitment per batch.
   Here's 256 real PQ signatures as a single 32-byte root." → `submitBatch` tx on the explorer:
   102,063 gas, **0.89 bytes/op** of signature overhead.
3. **(0:50–1:10) Comparison.** Two gauges (labelled *capacity model*): naive PQ fills the block; Sigpress
   returns it to the tx-count ceiling. Scoreboard: a whole PQ op goes from 2,276 B → **98 B** on chain (23x).
4. **(1:10–1:30) Kill shot.** Tamper one signature → `challenge` tx: **bond slashed, batch rejected on
   chain.** "On chain, not on trust. Optimistic today; and the STARK validity proof already verifies our
   own signature batches on Monad in one transaction — that is the product."

## One-liners for Q&A

- **"Why not just use Falcon? It's smaller."** Falcon-512 is ~666 B/sig — still ~10× ECDSA and ~1.6×
  today's budget, with no aggregation in production. Aggregation fixes size for *any* scheme.
- **"Isn't this just EIP-8288?"** The idea *is* EIP-8288's — we credit it plainly. The difference is that
  EIP-8288 is a Draft *Ethereum protocol* change (needs a hard fork; nothing works today), and we built a
  working **app-layer** version on Monad, with the on-chain hash-based verifier EIP-8288 only specifies.
  Our contribution is the implementation and the Monad case, not the concept.
- **"Is the verify number real?"** Yes — ~12.84M gas, one tx, on Monad testnet (tx hash in
  `decisions.md`); the verifier is 62.7 KB and would not fit Ethereum's 24 KB limit.
- **"What's not done?"** Joining the prover to the on-chain verifier for *our* signature statement. The
  terminal prover is now found and Apache-2.0 licensed and runs; what's left is wiring our proof chain,
  regenerating the verifier for the current profile, and binding to our batch — **~1–2 weeks**. Everything
  else is measured and live.
- **"If the aggregator goes down?"** Single-signature verification fallback — slower, never stuck. A
  prover can't forge a batch, only refuse to include one.

## Sources

- Monad: [MIP-12](https://mips.monad.xyz/MIPs/MIP-12), [MIP-2](https://mips.monad.xyz/MIPs/MIP-2),
  [Deployment Summary](https://docs.monad.xyz/developer-essentials/summary),
  [PQ roadmap](https://monad.xyz/blog/post-quantum-roadmap),
  [account-auth draft](https://forum.monad.xyz/t/flexible-and-upgradeable-account-authentication/526),
  [Quantum Cadence](https://arxiv.org/abs/2610.32803)
- Aggregation: [EIP-8288](https://eips.ethereum.org/EIPS/eip-8288),
  [ERC-7766 (withdrawn)](https://eips.ethereum.org/EIPS/eip-7766),
  [Falcon aggregation analysis](https://ethresear.ch/t/revisiting-falcon-signature-aggregation-for-pq-mempools/24431)
- Crypto: [FIPS 204 (ML-DSA)](https://csrc.nist.gov/pubs/fips/204/final),
  [FIPS 205 (SLH-DSA)](https://csrc.nist.gov/pubs/fips/205/final),
  [leanMultisig](https://github.com/leanEthereum/leanMultisig)
- All measured numbers with tx hashes: [`decisions.md`](decisions.md).
