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
