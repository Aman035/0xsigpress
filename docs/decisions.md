# Decisions

Every kill test and fact-check: what was measured, the source or command, and the decision.
Per `CLAUDE.md`: never state an unmeasured number as fact; secondary-source claims are marked unverified.

---

## Fact-check pass (4 Nov 2026)

A pass over every load-bearing claim in `idea.md`, `pitch.md` and `research.md` against primary
sources. Verdicts: TRUE / PARTIAL / FALSE / UNVERIFIED. This pass substantially answers **K1**
(re-derive throughput from primary sources) and **K2** (nobody has shipped it), except for the
live-mainnet block sampling noted under K1.

### Monad protocol (primary sources: docs.monad.xyz, mips.monad.xyz)

| Claim | Verdict | Source |
|---|---|---|
| Gas charged on gas limit, not gas used | TRUE | docs.monad.xyz/developer-essentials/gas-pricing |
| 30M gas per transaction | TRUE | docs.monad.xyz/developer-essentials/summary |
| 150M gas per block (target 120M), down from 200M | TRUE | MIP-12 (Final), mips.monad.xyz/MIPs/MIP-12 |
| 300 ms blocks, 600 ms finality (down from 400/800) | TRUE | monad.xyz/blog/300ms-block-times |
| 3,750 tx per block (down from 5,000) | TRUE | MIP-12 (Final) |
| Block byte cap = `proposal_byte_limit` 1,500,000 bytes | PARTIAL | MIP-12. Raw byte count, no unit given. 1,500,000 B = 1.5 MB (decimal) ≈ 1.43 MiB. Say "1.5 MB (1,500,000 bytes)", not "1.5 MiB". |
| 128 KB contract code size | TRUE | MIP-2 (Final): `MAX_CODE_SIZE` = 131,072 B = 128 KiB |
| Chain IDs: testnet 10143, mainnet 143; RPC/faucet URLs | TRUE | docs.monad.xyz/developer-essentials/{testnets,network-information} |
| P-256 precompile (0x0100, EIP-7951) + BLS12-381 (EIP-2537) | TRUE | docs.monad.xyz/developer-essentials/precompiles |
| EIP-7702 with 10 MON reserve | TRUE (nuance) | docs.monad.xyz/developer-essentials/eip-7702. It's a reserve *floor* on delegated EOAs, not a requirement to hold 10 MON. |
| Calldata priced at **40 gas/byte** | TRUE (as Monad's existing floor) | MIP-15 cites "Monad's existing calldata floor cost of 40 gas per byte". |
| ...via **EIP-7981** | **FALSE** | EIP-7981 is *Increase Access List Cost* (64 gas/B for access lists), not calldata. MIP-15 (status **Review**) adopts EIP-7981 for access lists and merely *references* the pre-existing 40 gas/B calldata floor. Do not attribute 40 gas/B to EIP-7981. |
| Max tx size ~384 KiB (monad-bft txpool) | **UNVERIFIED** | No per-tx 384 KiB constant found in category-labs/monad-bft; the txpool file defines only aggregate pool limits. Weakest Monad claim — keep flagged "to verify". |
| EntryPoint v0.6-v0.9 deployed on Monad | PARTIAL | v0.6-v0.8 standard canonical addresses; **v0.9 on Monad is unverified** (explorer shows unverified; absent from canonical-contracts docs; open forum question forum.monad.xyz/t/.../413). Pitch should say "v0.8" to be safe. |
| Mainnet live; launched 24 Nov 2025 | TRUE | monad.xyz/blog/300ms-block-times and launch coverage |
| "12,500 TPS" / "10,000 TPS" | PARTIAL / reframe | 12,500 = 3,750 tx ÷ 0.3 s = theoretical *block-capacity* max. 10k TPS is a **design target / devnet benchmark**, not measured sustained mainnet. No verified live TPS or avg tx size found. **Frame as block capacity, not live throughput.** |

### Monad PQ roadmap (primary: monad.xyz/blog, forum.monad.xyz, arxiv.org)

| Claim | Verdict | Source / correction |
|---|---|---|
| PQ roadmap blog, Mohsen Ahmadvand, 28 Sep 2026, phases P0-P5 | TRUE | monad.xyz/blog/post-quantum-roadmap. P0 accounts, P1 consensus, P2 staking, P3 PQ EVM precompiles, P4 proofs/STARKs, P5 encrypted mempool. |
| Roadmap "picks ML-DSA" | **FALSE (reframe)** | The roadmap blog names **HAWK and SQIsign** (NIST additional-signatures round), not ML-DSA. **ML-DSA appears in the account-auth draft**, which is roadmap phase P0. Attribute ML-DSA to the auth draft. |
| Roadmap silent on signature size / bandwidth / throughput | TRUE | Confirmed — no quantitative size discussion anywhere. This is the gap the project targets. |
| Account-auth draft: rotatable authenticators (secp256k1, P-256, Ed25519, ML-DSA), 3-block delay | TRUE | forum.monad.xyz/t/flexible-and-upgradeable-account-authentication/526. Authors Kushal Babel & Jan Camenisch, 21 Aug 2026. States "each scheme has a fixed gas cost" but **gives no numbers**; Falcon/SLH-DSA not mentioned. |
| Quantum Cadence drops quorum certs ("no PQ aggregate sig matches BLS") | TRUE | arXiv 2610.32803, 23 Oct 2026, Jalalzai/Klenze/Komatovic. Abstract confirms the paraphrase. |
| Scheduled Transactions: system txs, no signature, no nonce | TRUE | forum.monad.xyz/t/scheduled-transactions/567, Constantinescu & Heimbach, 22 Oct 2026. |
| BTX encrypted mempool is classical (BLS12-381); PQ is P5 | TRUE | monad.xyz/blog/btx-batch-threshold-encryption. BTX = Batch Threshold Encryption. |
| SP1 verifier gateways on chain 143 (Groth16/PLONK, not PQ) | TRUE (doc-sourced) | docs.succinct.xyz contract-addresses. On-chain bytecode not independently queried. |

### Aggregation stack (primary: eips.ethereum.org, ethereum-magicians.org, eth-infinitism)

| Claim | Verdict | Source / correction |
|---|---|---|
| EIP-8288 "In-mempool signature and proof aggregation", Draft, 2026-06-03 | TRUE | eips.ethereum.org/EIPS/eip-8288. Authors **Vitalik Buterin & Thomas Coratger** (not "Antonio"). *Requires* EIP-2718 and **EIP-8141**. Scheme is **leanSPHINCS**; "leanVM" is a tangential mention, not "one leanVM STARK". Consensus-breaking Ethereum protocol change. |
| ERC-7766 withdrawn: "No production adoption of aggregateable signature schemes..." | TRUE | eips.ethereum.org/EIPS/eip-7766. Status Withdrawn. Quote accurate. |
| EntryPoint v0.9 keeps `IAggregator`/`handleAggregatedOps` | TRUE | v0.9 (~Nov 2025) restricts `handleOps`/`handleAggregatedOps` to top-level EOA callers (griefing fix); aggregation API retained. |
| Bundlers support the aggregator path | PARTIAL | **Rundler** (Alchemy) confirmed (ships BLS + PBH aggregators). **Alto / Voltaire / Skandha UNVERIFIED** — do not assert. |
| EIP-7981 = calldata 40 gas/B | **FALSE** | See Monad table above. EIP-7981 = Increase Access List Cost, 64 gas/B. |
| EIP-7702 live | TRUE | Pectra hard fork, 7 May 2025. |
| EIP-8051 / 8052 / 8355 = PQ precompiles (Draft) | TRUE | 8051 ML-DSA (Dubois/Masson), 8052 Falcon-512, 8355 ML-DSA (Ferrin). All Draft, Core. |
| EIP-8141 "headlines Hegotá" | PARTIAL | EIP-8141 = *Frame Transactions*; flagged "must-ship" for Hegotá but **not** selected as EL headliner at ACDE #233. "headlines" is imprecise. |
| Ethereum PQ L1 target ~Dec 2029 | TRUE | EF quantum-resistance target, Dec 2029. |

### PQ crypto sizes & benchmarks (primary: FIPS 204/205, Falcon spec, leanMultisig, ethresear.ch)

| Claim | Verdict | Source / correction |
|---|---|---|
| ML-DSA-44: sig 2,420 B, pk 1,312 B | TRUE | FIPS 204. **Sum = 3,732 B ≈ 3.7 KB**, not "3.9 KB" — fix. |
| Falcon-512: sig 666 B (max), pk 897 B | TRUE | Falcon spec. Typical sig ~650-690 B. "~800 B/tx" is high. |
| SLH-DSA-SHA2-128s: sig 7,856 B | TRUE | FIPS 205. |
| ECDSA secp256k1: 65 B (r+s+v) | TRUE | Ethereum serialization. |
| leanMultisig: 1,400 leanXMSS sigs, 1.15 s prove, 359.5 KiB proof, 7.45 ms verify, M4 Max | TRUE (self-reported) | github.com/leanEthereum/leanMultisig. **~263 B/sig** (359.5 KiB ÷ 1,400), not 257. Field is now a **192-bit binary tower field** (KoalaBear was prior); WHIR PCS; "not *yet* production ready"; a Python verifier exists but it is not "Python-only". |
| On-EVM PQ verifier gas | PARTIAL / self-reported | ZKNOX ETHFALCON (MIT): 1.5M gas EVM-friendly / 3.9M NIST-compliant (447k is an experimental branch). ML-DSA: Fireblocks ~1.23M (unaudited); ETHDILITHIUM NIST baseline 8.09M. FORS+C ~35k / WOTS+C ~73k, SPHINCS- 94-142k — all self-reported on testnets. "+~4M once per key" UNVERIFIED. |
| WHIR-in-Solidity "5.65M gas, 54 KB, sol-spartan-whir" | **UNVERIFIED** | Those exact numbers not sourced. Real repo: `privacy-ethereum/sol-whir`. Downgrade in K3 table. |
| Falcon aggregation break-even ~200 sigs/batch (Sanso, Thiery, Wagner) | TRUE | ethresear.ch/t/revisiting-falcon-signature-aggregation-for-pq-mempools/24431, 18 Mar 2026. |
| Licences | — | ZKNOX ETHFALCON MIT (usable). Kohaku pq-account, NiceTry (Solvency-Labs), nconsigny/SPHINCS- : no licence — do not copy. |

---

## K1 — throughput re-derivation (primary sources)

- **Inputs (all MIP-12 Final / FIPS):** block byte cap 1,500,000 B; tx cap 3,750; block time 300 ms;
  sizes ECDSA 65 B, ML-DSA-44 2,420 B (+1,312 B pk), Falcon-512 666 B, SLH-DSA-128s 7,856 B.
- **Method:** block *capacity* in tx = min(tx cap, byte cap ÷ bytes-per-tx). Baseline tx ≈ 400 B
  (1,500,000 ÷ 3,750 = 400). PQ tx ≈ 400 − 65 + sig(+pk).
- **Results (block-capacity, theoretical max TPS = tx ÷ 0.3 s):**

  | Scheme | Bytes/tx | Tx/block | Max TPS (cap) |
  |---|---|---|---|
  | ECDSA | ~400 | 3,750 (tx-cap bound) | 12,500 |
  | ML-DSA-44 (sig only, pk stored) | ~2,755 | ~544 | ~1,815 |
  | ML-DSA-44 (sig + pk) | ~4,067 | ~369 | ~1,230 |
  | Falcon-512 | ~1,001 | ~1,498 | ~5,000 |
  | SLH-DSA-128s | ~8,191 | ~183 | ~610 |

- **Decision: K1 PASS.** Naive ML-DSA cuts block capacity from 3,750 to ~370-540 tx — an **85-90%
  cut** (threshold was ≥70%). Hook holds. The byte cap binds before the 150M gas cap for PQ-sized txs.
- **Caveat / TODO:** these are block-*capacity* figures, not measured live TPS. "12,500 TPS" is the
  theoretical cap, and ~10k TPS is Monad's *design target*, not sustained mainnet throughput. Still
  TODO: sample a live mainnet block for real avg tx size to state utilisation honestly.

## K1 TODO — mainnet utilisation sample (4 Nov 2026)

- **Test:** what real Monad mainnet blocks use, versus the 1,500,000 B / 3,750 tx caps and the 400 B
  baseline assumed above.
- **Method:** `experiments/k1-mainnet/sample.mjs` (read-only, no keys) against `https://rpc.monad.xyz`
  (public QuickNode endpoint from docs.monad.xyz network-information; `cast chain-id` → 143). 250
  blocks: 200 spread every 1,426th block over ~24 h (118,997,899 → 119,281,673, 2026-11-03 08:47 →
  2026-11-04 08:40 UTC) plus 50 contiguous (119,281,674 → 119,281,723). Tx size = exact canonical
  encoding length per tx from `debug_getRawBlock` (`eth_getRawTransactionByHash` not exposed),
  cross-checked against `cast tx --raw` on one block (sums equal, 33,865 B).
- **Measured:**

  | Metric | Value (250 blocks, 5,518 txs) |
  |---|---|
  | Tx size avg / p50 / p95 | **1,728 B** / 1,180 B / 4,657 B |
  | Tx per block avg / p95 / max | **22.1** / 45 / 98 |
  | Tx bytes per block avg / max | 38,132 B (**2.5%** of cap) / 154,701 B (10.3%) |
  | Tx count vs 3,750 cap, avg | 0.59% |
  | Gas charged vs 150M limit, avg / max | 11.9% / 59.5% (gas *limit* sum, Monad charges the limit) |
  | Live throughput | ~73 tx/s (0.303 s/block measured) |
  | Tx types | 92.8% type 2, 7.0% legacy, 11 type 1, **1** type 4; 2 `handleOps`, 0 `handleAggregatedOps` |

- **What it does to the capacity table:** real txs are ~4x the 400 B baseline (large calldata,
  EIP-2930 access lists). At the mean mix the byte cap binds before the tx cap even for ECDSA
  (868 tx/block, ~2,900 TPS ceiling). Recomputed naive-PQ capacity (tx − 65 B + sig[+pk]):
  ML-DSA-44 sig-only 367 tx/block (**58% cut**; 67% at median size), ML-DSA-44 sig+pk 278 (**68%**;
  76% at median), Falcon-512 644 (26%; 34%), SLH-DSA-128s 157 (82%; 87%). Versus the 3,750-tx ceiling
  the cuts stay 89-96%, but that compares against a 400 B tx that doesn't exist on mainnet.
- **Decision:** K1 verdict left as PASS (the hook — PQ signatures dominate tx bytes and shrink the
  ceiling several-fold — holds: ML-DSA adds 2.4-3.7 KB, 59-69% of each PQ tx's bytes). **But the data
  weakens it:** against the measured tx mix the naive ML-DSA cut is 58-76%, straddling the ≥70% pass
  line (sig-only at mean mix fails it). Flagged for the user to decide whether to re-score K1.
- **Pitch implications:** (1) mainnet is at ~2.5% of the byte cap today, so frame the problem as the
  capacity ceiling Monad is designed to fill, not current congestion; (2) quote "~10k TPS" only as the
  design target; live is ~70 tx/s; (3) prefer "ML-DSA makes each tx ~2.4-4.1x bigger / cuts the byte
  ceiling by 58-76% at today's tx mix" over "85-90%"; (4) 4337 and 7702 are almost unused on mainnet
  (0.04% / 0.02% of txs) — adoption of the aggregator path cannot lean on existing 4337 volume.
- **Caveats:** one RPC, one 24 h window, 250 blocks; every-Nth sampling can miss bursts; gas is
  gas charged (limit), not executed.

## K2 — has anyone shipped PQ aggregation on Monad?

- **Decision: K2 PASS.** No PQ signature aggregator or on-chain aggregation verifier found on Monad,
  Ethereum, or any chain. ERC-7766 withdrawn for lack of a scheme worth aggregating; EIP-8288 is a
  Draft Ethereum *protocol* design (no working implementation); leanMultisig's verifier is a research
  prototype with no EVM verifier. Monad's own consensus paper (Quantum Cadence) explicitly has no PQ
  aggregation answer. **This would be the first working app-layer PQ aggregator with an on-chain verifier.**

## Blitz-day scope decision (4 Nov 2026)

- **Situation:** K3-K6 (STARK verifier on Monad) not measured; build window is 1.5 h.
- **Decision:** ship the `demo.md` fallback — on-chain WOTS (Keccak, hash-based) verification plus
  optimistic aggregation (Merkle root + bond on chain, single-signature fraud proof slashes the bond).
  Pitch says "optimistic today, validity proof (STARK) next". See `docs/hackathon-plan.md`.

## Blitz build — first measured numbers on Monad testnet (4 Nov 2026)

Deployed with `scripts/testnet.sh` (chain 10143). Explorer: https://testnet.monadexplorer.com/tx/<hash>.

| Contract | Address |
|---|---|
| NaiveLane | `0xcFc286564ed4281E200c6D052f9E1A932b31E845` |
| OptimisticAggregator (bond 0.01 MON, window 120 s) | `0xEAA3AC4807767F8fe5B8caD979cB523A926b2A1E` |
| PQAccountFactory | `0x7335b48f2d794d4a196618916Ec196a1a1615442` |

**Important measurement note:** on Monad the receipt's `gasUsed` equals the tx **gas limit** (checked with
`cast tx <h> gas` vs `cast receipt <h> gasUsed` — identical). So every gas figure below is *gas charged*
(= limit we set), not gas executed. Naive/batch/tamper used viem's estimate as the limit; the execute
flow used estimate × 1.3 (buffer added after a first `submitBatch` ran out of gas at an 85,468 limit,
tx `0xac9cd910…5fd23`). Execution-only gas from `forge test --gas-report` / anvil is lower (e.g. naive
WOTS verify ~110k on anvil).

| What | Measured (testnet, gas charged) | Tx |
|---|---|---|
| Naive: 1 WOTS signature verified on chain | 118,606 gas; 2,276 B calldata | `0x26f4bcbf31d0b508bc97d169b4951972d3246e8605c97da177133875180604b0` |
| Optimistic batch of 256 signed ops | 102,063 gas total (~399 gas/op); 228 B input (**0.89 B/op**) | `0x724ec6e8b54d4a8ec255276173d2b2daaf278b43d09303fee215ea663715c3ea` |
| Tamper: 256-op batch, sig #7 bad → challenge | slashed = true | submit `0x1761b395b10477de521f0c936dd9878f92227ca126612e6dd352385e14fe27e2`, challenge `0xfafe5108cb194d701f439fccac90bb5b0758e2727c7e5187401fc576f7f90399` (166,542 gas) |
| PQAccount executes op from finalized batch (4 accounts, 0.0001 MON each) | avg 134,634 gas (incl. 30% buffer) | first: `0xc3a6411d33ed43ea9c013a7ee387cef064ef7d3ca3e26f1ce7b88604e98c9353` |
| PQAccount direct (WOTS verified on chain, single-op fallback) | 186,088 gas (incl. 30% buffer) | `0x9b690e18962beaa97859fae38a063b8f17aa68d718844ef6d4b1eee3159ae2c6` |

**What this means:** *signature* bytes on chain per PQ-signed op drop from 2,276 B (naive) to under 1 B
(batch root). **Correction (later the same day):** the op itself still has to be on chain to execute —
measured at 98 B/op with the compact bundle (see "K9 fix — compact entry"), so a whole PQ op is ~99 B vs
2,276 B naive (23x), not <1 B. The block-byte cap still stops binding — but this is the **optimistic** design: a bad signature is
only caught if someone challenges within the window (shown working above). The validity-proof (STARK)
version is still gated on K3/K4. The per-op execute cost is dominated by the account call + Merkle
proof, not the signature.

## K3 — proof system choice (4 Nov 2026)

**Test:** find a hash-based proof system with a realistic path to a Solidity verifier; run any
existing verifier on its example proof (local K4 data point). Details, repro commands and the full
candidate table: `experiments/k3/README.md`; raw results in `experiments/k3/results/`.

**Measured (local anvil, NOT Monad):**

| What | Result | Source / command |
|---|---|---|
| LeanVM terminal verifier (sol-spartan-whir `LeanVmTwoCommitmentTerminal_KeccakPublicMemoryC1Pow28T6`, a complete recursive proof: LeanVM root AIR + LogUp/GKR + WHIR, running a Spartan-WHIR verifier in the guest), checked-in proof | **12,896,156 gas**, one tx, status 1, returns true; calldata **106,628 B**; runtime 62,732 B (fits Monad's 128 KB, not EIP-170); 2 tampered proofs revert | github.com/alxkzmn/sol-spartan-whir @ 18eda72; `cast send --create` + `cast send <addr> <calldata.bin>` on anvil (cancun, code-size-limit 65536). Matches the repo README's 12,896,156 exactly. |
| sol-whir (BN254 WHIR PCS opening only, 2^16 vars, 80-bit, capacity conjecture) | 1,135,052 gas, 28,740 B calldata | github.com/privacy-ethereum/sol-whir @ b719b97; `forge script script/Verify.s.sol --broadcast` |
| leanVM prover (leanEthereum/leanMultisig @ 4b67ca0), leanXMSS aggregation, `--log-inv-rate 1`, Apple M4 16 GB | 256 sigs: 299.8 KiB, 0.615 s. **1,024 sigs: 326.3 KiB (≈326 B/sig), 3.3 s**, 5.0 GiB. Rate 3: 207.3 KiB but 54.8 s. No EVM verifier exists for this (binary-field) version. | `cargo +nightly leanvm aggregate --xmss N` |

**Estimated, not measured:** on Monad the terminal tx would cost ~12.9M (if calldata pricing works like
EIP-7623's max(standard, floor)) to ~15.6M gas (execution 11.28M + 21k + 40 gas/B × 106,628 added on
top). Monad charges the gas *limit*, so the limit must be set close to this. Both are under K4's 25M bar.

**Licences (checked from files):** leanMultisig MIT + Apache-2.0; Plonky3 MIT/Apache-2.0; Stwo
Apache-2.0; starkex-contracts Apache-2.0. sol-whir is MIT but depends on `solidity-bn254`, which is
**GPL-3.0** — do not reuse. **sol-spartan-whir and its upstream ethereum/sol-whir-p3 have no LICENSE
file** (README says MIT; every `src/` file is SPDX MIT) — get a LICENSE file before copying code.

**Not found:** any Solidity verifier for Plonky3, Stwo, or current (binary-field) leanVM.

**Unverified (self-reported):** sol-whir-p3 grouped terminal 10,666,368 gas / 99,044 B ("security under
review"); standalone KoalaBear WHIR 2^22 @ 100-bit ~3.0-3.6M gas / ~54 KB; leanVM 1,400 sigs in 1.15 s on
M4 Max; the claim that sol-whir's capacity-bound conjecture "has since been disproven" (ethresear.ch
alxkzmn post, 19 May 2026).

**Decision: K3 PASS (conditional).** Choose **leanVM recursion → Keccak terminal proof → sol-spartan-whir
terminal verifier**. It is the only complete hash-based Solidity verifier found, it ran, and its proof
fits Monad's gas, size and code limits in one tx. K6 is answered structurally: the EVM side computes
only Keccak and 31-bit field arithmetic, no Poseidon2.
Blockers before K4 can pass for *our* statement: (1) the terminal-profile prover is not public in these
repos (scripts reference an external `../leanVM` workspace) — find it or ask the authors; (2) the
terminal's public input must be bound to our batch root; (3) the Solidity terminal targets the
KoalaBear-era leanVM, while leanVM main is binary-field; (4) our `WOTS.sol` is not leanXMSS — align the
scheme; (5) missing LICENSE file. Effort estimate (not measured): 1-2 weeks if the terminal prover is
obtainable; 4+ weeks otherwise.
**K4 status:** local anvil data point passes the gas/size bar for the authors' fixture proof; Monad
testnet run and a proof of our own statement are still to do. K4 is not yet passed.

## K4 — real hash-based proof verified on Monad testnet (4 Nov 2026)

- **Test:** deploy K3's chosen verifier (sol-spartan-whir LeanVM terminal, KoalaBear + Keccak, no
  pairings, no Poseidon in the EVM) to Monad testnet and verify its fixture proof in one transaction.
- **Measured:** verifier deploys (≈62.7 KB, fits MIP-2's 128 KB; would not deploy on Ethereum).
  Verify tx `0x3ab6054a444f6f52bc4054ccbfc2b621dfc91564ba324de62c4ab9cc8fec968c` **succeeded**; proof
  calldata **106,628 B**; `eth_estimateGas` **12,837,028**; charged 13,500,000 (Monad charges the limit).
  A 1-bit tampered proof reverts (`MERKLE_ROOT`). Details: `experiments/k4/README.md`.
- **Decision: K4 PASS** on the bar in `plan.md` (≤ 25M gas, one tx, ≤ 300 KiB). Max tx size is still
  unverified, but a 104 KiB tx was accepted. **Caveat:** the statement proven is the fixture, not our
  signature batch; producing that proof (terminal prover, public input bound to our batch root,
  leanXMSS vs our WOTS) is the remaining work — K3 estimates 1-2 weeks if the terminal prover is
  obtainable, 4+ otherwise (estimate, not measured). Go/no-go: full validity-proof version is
  **go on gas/size grounds**; the risk has moved to prover availability.

## K8 / K9 — ERC-4337 `handleAggregatedOps` on Monad testnet, and bytes per aggregated op (4 Nov 2026)

**Setup.**
- **EntryPoint:** v0.8 at `0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108` has code on Monad testnet (`cast code`). It is
  confirmed v0.8 by `eip712Domain()` = ("ERC4337", "1", chainId 10143) and `senderCreator()` =
  `0x449ED7C3e6Fee6a97311d4b55475DF59C44AdD33`. Its bytecode contains the `handleAggregatedOps` selector `0xdbed18e0`.
  v0.7 (`0x0000000071727De22E5E9d8BAf0edaC6f37da032`), v0.6 (`0x5FF137D4…2789`) and `0x433709009B8330FDa32311DF1C2AFA402eD8D009`
  also have code. We did not test them.
- **Licence:** eth-infinitism/account-abstraction is GPL-3.0 at the repo level (GitHub licence API). We copied nothing.
  `contracts/src/aa/IERC4337.sol` is minimal interfaces written fresh from the ERC-4337 ABI (MIT).
- **Contracts** (`contracts/src/aa/`, MIT):
  - `SigpressAggregator4337` (IAggregator): optimistic mode. `validateSignatures` checks that each op's leaf
    `keccak256(pkHash ‖ m ‖ sigHash)` is in a **finalized, unslashed** `OptimisticAggregator` batch, with
    `m = keccak256(abi.encode(chainId, OptimisticAggregator, pkHash, nextPkHash, userOpHash))`. It verifies no WOTS
    signature on chain.
  - `PQAccount4337`: its `validateUserOp` returns the aggregator address in validationData and rotates the key to
    `nextPkHash = userOp.signature` (32 B).
  - `PQAccount4337Factory`: CREATE2 factory.
- **Bundling:** an EOA calls `handleAggregatedOps` directly; no bundler is involved. The ERC-7562 storage and opcode rules
  bind bundlers' mempool simulation, not on-chain execution. They did not block us. Our aggregator reads account storage
  and calls back into `EntryPoint.getUserOpHash`, which a public-mempool bundler might reject. **This means we have not
  tested a third-party bundler (Rundler or others) or a hosted Monad bundler.**

**Tests.** `forge test --match-path test/aa/Aggregated4337.t.sol` runs against a fork of Monad testnet, using the real
v0.8 EntryPoint. 7/7 tests pass:
- An aggregated bundle of 4 ops executes: 4 transfers, keys rotated, nonces bumped.
- Two ops from one account in one bundle chain their keys.
- These revert with `SignatureValidationFailed(aggregator)`: batch not finalized; wrong sigHash; op callData changed after
  signing; `nextPkHash` swapped.
- `handleOps` without the aggregator reverts with `FailedOp(0, "AA24 signature error")`.

**Testnet run** (`KEY_VAR=PRIVATE_KEY_K8 pnpm aa`, EOA `0x5C67CeA0B2e717E7AB3c0A7a04AD25D749D0F8e1`):

| Step | Tx |
|---|---|
| Deploy SigpressAggregator4337 `0xe6869caa26a2581880a8d237c1a1f9a26c6c212e` | `0x56e4ab3301fd88dae4a0c508f8f7ef3a44a958e337369f374aa228d93b62ed83` |
| Deploy PQAccount4337Factory `0x21d2ee544075fb5da08bc44bd9a68f6d736e6563` | `0x75a03fc1a9c928f59e09941e4aeb0960099d1e71b29ae1aa8791d1ca1f64aa76` |
| submitBatch (batch 7, 4 leaves) on the live OptimisticAggregator `0xEAA3…2A1E` | `0x2c60751ffc1c69e3dea7bc5972b613e808bb36c7ae81d8e90020927af7233f94` |
| finalize after the 120 s window | `0xf6288141f4a75774264162a0acee709c96c7712d1ab0c806fd00c3efe1354bee` |
| **handleAggregatedOps, 4 UserOps, all `UserOperationEvent.success = true`** | `0xaad5ef866a9068c3c59f49d63801199a17433805c7caf4d6c38cca1cb7026ee5` |

- **Gas charged:** 828,003 for the `handleAggregatedOps` tx (~207k per op). On Monad, receipt `gasUsed` equals the gas
  limit. Here the limit was viem's estimate × 1.3.
- **Gas executed:** the same script on an anvil fork of Monad testnet used 454,743 gas (~114k per op). This was not
  measured on Monad itself.
- Each op had vGL 100k, cGL 50k, PVG 50k and maxFee 112.2 gwei, so the prefund was 0.0224 MON per op.

- **Decision: K8 PASS.** An ERC-4337 aggregated bundle (EntryPoint v0.8, custom IAggregator) executes on Monad testnet.
  The "standard 4337" pitch line holds for the **on-chain** path.
- **Open:** bundler and mempool support for this aggregator. We have not tested Rundler, and we have not asked hosted Monad
  bundlers whether they accept ops for an unknown aggregator. We also did not test v0.9.

**K9 — bytes per op, measured from the tx above (4 ops):**

| Quantity | Bytes |
|---|---|
| tx input (calldata) | 3,844, of which 2,971 are zero bytes (77%) |
| signed raw tx (re-serialised from RPC fields) | 3,960 → **990 B per op** |
| one ABI-encoded UserOp (plain transfer, empty initCode/paymaster, 32 B sig field) | 672 |
| aggregated signature (batchId + 4 × (index, 2-level proof, sigHash)) | 992 (248 per op) |

Comparisons:
- **Naive on-chain WOTS:** 2,276 B per signature. The 4337 path is **2.3x smaller**.
- **A "normal Monad tx" (~400 B, from the MIP-12 arithmetic in K1; not measured here):** the 4337 path is **2.5x bigger**.
  The pass line was 1.5x, so this fails. The ABI-encoded UserOp alone (672 B, 1.7x) breaks the line before any PQ data
  is added.
- **Derived from ABI encoding rules, not measured:** the aggregated signature costs `128 + 32·log2(N)` B per op. It grows
  to ~384 B per op at N = 256, which gives ~1,060 B per op in total.

- **Decision: K9 FAIL** against the 1.5x line, though not fatal. It is still a 2.3x byte reduction over naive PQ
  verification. The overhead is 4337's ABI padding (mostly zero bytes) and the Merkle proofs, not the PQ signature.
- **Fallback, as plan.md says:** a compact bundle format through our own entry contract. It could pack fields, share gas
  fields per bundle, and recompute the root from the whole batch so that no per-op proofs are needed. This is a design
  idea and is unmeasured. A middle step that stays within 4337 is a "whole batch" aggregated-signature mode: bundle =
  batch, root recomputed, 32 B sigHash per op. That would make the signature part ~32 B per op, but the 672 B UserOp
  remains.

## K5 / K6 — proof size, prove time, and hash on both sides (4 Nov 2026)

- **Test:** leanMultisig/leanVM @ `4b67ca0` (MIT + Apache-2.0, checked from files), leanXMSS
  aggregation, measured on Apple M4 (base, 10 cores) 16 GB. Commands, raw output and the
  verifier-counting patch: `experiments/k5/README.md`, `experiments/k5/results/`.
  `./target/release/leanvm aggregate --xmss N --log-inv-rate 1 --repeat 3` under `/usr/bin/time -l`;
  `leanvm recursion --n 4 --xmss-per-leaf 1024`.
- **Measured (K5):** N=256: 306,992 B proof (1,199 B/sig), 0.554 s, 1.8 GB. **N=1,024: 334,104 B
  (326 B/sig), 2.289 s mean of 3 (2.13-2.44 s), 6.3 GB, verify 9.5 ms (Rust).** With the signer set
  (pubkey+message, 64 B/sig) on the wire: 400,217 B (391 B/sig). N=2,048: 357,408 B (175 B/sig) but
  28.4 s, memory-bound (12.8 GB footprint on 16 GB). N=4,096 in one leaf **fails**
  (`WitnessOutOfRange`, log 29); as 4×1,024 leaves + 4→1 recursion: 342.6 KiB at rate 1/2 (≈86 B/sig,
  step 0.94 s) or 245.5 KiB at rate 1/4 (≈61 B/sig, step 0.78 s).
  Self-reported (M4 Max 48 GB, not ours): 1,400 sigs, 359.5 KiB, 1.15 s; we are ~2.7× slower per sig.
- **Measured (K6):** signature hash = Keccak-256 truncated to 16 B (proved via KECCAK opcode/GKR);
  Merkle = Keccak-256; transcript = duplex sponge on the **raw Keccak-f permutation**; field = 192-bit
  binary tower. One verification at N=1,024 does 5,524 Keccak-256 calls, 937 raw transcript
  permutations, **~107k GF(2^192) multiplications** (+ ~72k smaller/table mults). No Poseidon anywhere.
  EVM-side cost of the field work is estimated (not measured) at >100M gas even at 1,000 gas/mult —
  over the 30M cap; the EVM has no carry-less multiply.
- **Decision: K5 PASS** (326 B/sig ≤ 400 at 1,024; 2.29 s ≤ 3 s, narrow, on a modest machine).
  **K6 FAIL for a direct EVM verifier of the current leanVM proof; PASS only via the K3/K4 route**
  (KoalaBear + Keccak-256-only terminal, 12.84M gas measured on Monad), whose prover is not public.
  On-chain bytes would then be the constant ~106,628 B terminal (≈104 B/sig at 1,024, unmeasured for
  our statement); the wrap step's prove time is unmeasured. Risk remains prover availability.

## Terminal prover search (K10-terminal, 4 Nov 2026)

- **Test:** find the prover that wraps a leanVM proof into the Keccak terminal format the sol-spartan-whir
  verifier accepts. Searched alxkzmn's repos and forks, leanEthereum/leanVM branches (incl. `koalabear`),
  `gh search code/commits`, the sol-spartan-whir scripts. Details and commands: `experiments/k10-terminal/README.md`.
- **Found:** `Client-Side-Proving/leanVM` branch `recursive-verifier` @ `fb0909d` (Alex Kuzmin, 15 Oct
  2026), **Apache-2.0** (LICENSE file). `script/run_terminal_fixture.py` -> `leanvm-recursion-profile`
  writes `native/root-fixture.json`, the input the Solidity generator expects. Chain: guest proof ->
  lift -> binary-node root proved with the Keccak240 profile; statement = Poseidon1 application root of
  two children's 8-element digests. Lift/terminal APIs take any child bytecode; the branch also has the
  KoalaBear XMSS aggregation program.
- **Measured:** builds (1 min 05 s, pinned nightly-2026-03-04). Control chain (guest -> lift -> node,
  Poseidon, not Keccak) verifies: 0.62 / 0.74 / 1.51 s, node proof 275,562 B, 1.46 GB RSS. Keccak240
  execution-proof test passes. Full terminal run not done: needs two distinct client fixtures (only one
  checked in; generating another needs `ethereum/spartan-whir`, no LICENSE).
- **Mismatch:** the deployed verifier (`0x4fa20bd7…c4be`, sol-spartan-whir `18eda72`) uses profile tag
  `0x57500001`; the prover now uses `0x57500002` after a WHIR continuation-claim correction, and
  upstream sol-whir-p3 dropped the C1 outputs. New proofs will not verify on the deployed contract; a
  matching verifier must be regenerated per fixture (it pins programs and profile anyway).
- **Decision:** critical path unblocked on availability and prover licence. Next: our own chain (small
  XMSS aggregates -> lift -> Keccak terminal -> regenerated C1/grouped verifier on anvil, then Monad).
  Open, unmeasured: aggregation uses `default_whir_config` vs the lift's explicit profile; root needs
  exactly two children; on-chain binding of a Poseidon1 root to our batch; 16 GB RAM vs the authors'
  17.8 GB peak. Estimate (not measured): 1-2 weeks. Verifier repos still lack LICENSE files; draft
  request dropped: we build the chain ourselves (no outreach).

## K9 fix — compact entry (`SigpressEntry`) on Monad testnet (4 Nov 2026)

- **Test:** run a whole optimistic batch in **one tx** through our own entry contract with a packed calldata format,
  instead of ERC-4337 `handleAggregatedOps`, and measure bytes per op on chain. Pass line (from K9): ≤ 1.5x a normal
  Monad tx, i.e. ≤ 600 B/op against the ~400 B MIP-12 figure.
- **Design** (`contracts/src/SigpressEntry.sol`, `contracts/src/SigpressAccount.sol`, MIT, written by us):
  - One bundle = one batch. The entry rebuilds each op's leaf from the bundle and the account's own storage, then
    **recomputes the batch's Merkle root from all `count` leaves**. It requires the root to match a **finalized,
    unslashed** batch in an `OptimisticAggregator`, using the existing `batches(id)` getter, so the aggregator is
    unchanged. A per-batch `executed` flag and a transient-storage reentrancy lock are added. Ops run first and the
    root is checked last. A mismatch reverts the whole tx.
  - The binding is the same as `PQAccount`: `leaf = keccak256(pkHash ‖ m ‖ sigHash)`,
    `m = keccak256(abi.encode(chainId, entry, pkHash, nextPkHash, payloadHash))` and
    `payloadHash = keccak256(abi.encode(account, nonce, target, value, keccak256(data)))`. `pkHash` and `nonce` come
    from account storage, so they are implicit and cost no bytes.
  - Accounts are EIP-1167 clones that the entry deploys with CREATE2 at `salt = index`. The 4-byte account index is
    turned into an address by hashing, with no registry read. A failing target call does not revert the bundle: the
    key still rotates and `success = false` is logged. `executeDirect` is a single-op fallback that verifies the WOTS
    signature on chain.
  - Calldata = `executeBundle()` selector (4 B) ‖ batchId uint32 ‖ per op: index uint32, target 20 B,
    valueLen uint8 + value bytes, dataLen uint16 + data, nextPkHash 32 B, sigHash 32 B. A plain transfer of
    1e14 or 3e12 wei is **97 B per op**.
  - **What we did not drop, and why.** `nextPkHash` (32 B) stays. Deriving it from an XMSS-style key commitment
    would save ~32 B/op (to ~65 B). But the challenge path would then have to verify a one-time key's auth path
    under the account root, which needs a new aggregator challenge type, and we did not build or test that here.
    `sigHash` (32 B) stays at full length because truncating it would weaken PQ collision resistance.
- **Tests:** `forge test --match-path test/SigpressEntry.t.sol` gives 14/14. They cover:
  - happy paths for 4 ops, 64 ops from 64 accounts, and 64 ops from 16 accounts with keys chained inside the bundle;
  - 7 kinds of tampered op (value, target, data, nextPkHash, sigHash, swapped order, wrong account) that all revert
    `RootMismatch`, after which the untampered bundle still runs;
  - replay: the same bundle reverts `AlreadyExecuted`, and the same ops in a fresh batch revert `RootMismatch`
    because the keys have rotated;
  - an unfinalized batch and a slashed batch (bad signature challenged) both revert `BatchNotAccepted`;
  - trailing or truncated bytes, an unknown account index, a wrong signing domain, a failing target, blocked
    reentrancy, account access control, and `executeDirect`.

  The full `forge test` gives 68/68, including the forked 4337 suite. The TS packer is `aggregator/src/compact.ts`
  (unit test `test/compact.test.ts`). It was cross-checked end to end against the Solidity on anvil (8 ops) before
  the testnet run.
- **Testnet run:** `KEY_VAR=PRIVATE_KEY_K9 pnpm compact` from EOA `0x245D46C4D130bD239f9783caf37b7E174a78CEa3`.
  - Deployed with `script/DeployCompact.s.sol` (WINDOW 120, bond 0.001 MON):
    - `OptimisticAggregator` `0xFb23333a49A0421720dDc1e923b2c1698bD25037` (tx `0xaad3fd6034e380290df17d0b6284a7dfe2a22cf07f3208ee8303ac5ae83cff09`)
    - `SigpressEntry` `0xf4824778dd80470793bB748CBd506b8B5D1fAe77` (tx `0x4408f683e267a5abb809accb30ce28e4402b7343d46dec0b2eeb3283c0585a74`)
    - `SigpressAccount` implementation `0x4B06951d269908cb56B78FEeF1f3a6D71c7C40d9`
  - Every bundle below had all N `Executed(success = true)` events, and the recipient balance went up by N × amount.

| N ops (accounts) | executeBundle tx | calldata | raw signed tx | **raw B/op** | calldata B/op | gas estimate | gas charged (= limit) | charged gas/op |
|---|---|---|---|---|---|---|---|---|
| 4 (4) | `0xc92563057773e68eaa97283d09291f31ae4747edc93b4abd694e310e89073e8b` | 396 | 512 | **128.0** | 99.0 | 320,230 | 368,264 (×1.15) | 92,066 |
| 32 (8, 4 ops each) | `0x86c5f0ef13325fb55560f08f56400896429bce74a4abd590c65a99ff61b07569` | 3,112 | 3,228 | **100.9** | 97.3 | 870,348 | 913,865 (×1.05) | 28,558 |
| 128 (32, 4 ops each) | `0xf37a32806cda56f3493d2880bf181df2abf0c084e2894e87dca7edd7df1defbd` | 12,424 | 12,540 | **98.0** | 97.1 | 3,313,895 | 3,479,589 (×1.05) | 27,184 |

- **How the bytes were measured:** we re-serialised the raw tx from the RPC fields and checked that
  `keccak256(raw) == tx hash` for every tx. Monad's RPC has no `eth_getRawTransactionByHash`. 6-7% of the calldata is
  zero bytes, against 77% for the 4337 path.
- **Per-batch overhead, which the K9 4337 figure also left out:** `submitBatch` is 383 B raw with 111-133k gas, and
  `finalize` is 149 B with ~78k gas. Including them, the bytes per op are 261 (N = 4), 117.5 (N = 32) and
  **102.1 (N = 128)**. The charged gas per op is 144,942, 34,475 and **28,663**.
- **Gas caveats:**
  - For N = 32 and 128, each account signed 4 ops, so repeat ops hit warm storage. Ops from distinct, cold accounts
    cost more; at N = 4 that was ~80k estimated per op including the fixed overhead.
  - Creating an account is a one-off cost of ~89-102k gas charged per account (4 accounts: 407,509; 24: 1,889,749).
  - A first top-up attempt with a 21k-style 30,000 limit reverted (tx `0xda84377542a510be7c2e181651e9e9f3c315f599a08ae298df2b10322c55f4db`),
    because the clone's `receive()` delegatecalls. The script now estimates the gas.
- **Comparison, per op:**

| Path | B/op on chain | vs normal tx (400 B) |
|---|---|---|
| Naive on-chain WOTS (measured) | 2,276 | 5.7x |
| ERC-4337 `handleAggregatedOps`, 4 ops (measured, K9) | 990 | 2.5x |
| **SigpressEntry, 4 ops (measured)** | **128** | **0.32x** |
| **SigpressEntry, 128 ops (measured)** | **98.0** (102.1 incl. submit + finalize) | **0.25x** (0.26x) |
| Normal Monad tx, MIP-12 arithmetic (K1, not measured here) | ~400 | 1x |
| Measured Monad mainnet average tx (K1) | 1,728 | 4.3x |

  Against the 4337 path the compact entry is **7.7x smaller at 4 ops and 10.1x smaller at 128 ops**. Against naive
  on-chain PQ it is **23x smaller**. A PQ op now costs fewer bytes on chain than a plain ECDSA transfer: an ECDSA tx
  carries ~110 B of envelope and signature, and here that cost is paid once per bundle.
- **Honest limits:**
  - This is still **optimistic**. The 2,144-B WOTS signatures are not on chain; data availability is the
    aggregator's job (`out/compact-batch-*.json`), and safety relies on someone challenging within the 120 s window.
  - One bundle must carry the whole batch, so a batch can execute only once every op's data is available.
  - A target that burns all forwarded gas can still make the bundle run out of gas, because there is no per-op gas
    cap yet.
  - Not an ERC-4337 path, so no bundler or paymaster ecosystem.
  - Accounts at 0-3 were topped up once by 0.00005 MON on top of their first 0.0005 MON.
- **Decision: K9 PASS via the compact entry.** At 98-128 B per op it is 0.25-0.32x a normal tx, far under the 1.5x
  line, and the result holds at every N measured. Keep ERC-4337 only as a compatibility lane (K8). The main
  bytes-per-op claim in the pitch should use the compact entry: ~98 B/op on chain at N = 128, measured. The
  remaining 97 B/op is mostly `nextPkHash` + `sigHash` (64 B).
