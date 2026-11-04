# Post-quantum ideas for Monad Blitz (4 Nov 2026)

Rubric as before: creativity 20, judge recognition 20, production 15, ambition 15, event fit 10, one-day slice 10, risk 10 (10 = lowest). Total = Σ(score × weight) / 10.

## Facts the ranking rests on

**Monad Blitz**
- One-day, in-person events; mostly peer-voted on novelty, mechanics that use Monad, problem solving and experimentation (Ankara pack). Build from scratch on the day, public repo, deployed on Monad testnet, teams of up to 3. Next confirmed: Oregon, 15 Nov (judged); Mumbai Devcon edition is 4 Nov. https://blitz.devnads.com/api/events, https://monad-foundation.notion.site/Monad-Blitz-Ankara-Info-Pack-2726367594f280199841cab7df002fef
- 1,841 Blitz projects, none with PQ signatures. The only quantum-themed winner was a quantum randomness oracle. https://blitz.devnads.com/api/showcase

**Monad**
- 30M gas per tx, 150M per block, charged on gas limit. About $0.002 per 1M gas at 102 gwei and MON $0.0187. Contracts up to 128 KB. P-256 precompile; BLS12-381 precompiles; EntryPoints v0.6–v0.9; EIP-7702 with a 10 MON reserve for delegated EOAs. No PQ precompile proposed. https://docs.monad.xyz/developer-essentials/summary
- Category Labs' draft "Flexible and Upgradeable Account Authentication" (Aug 2026): address commits to an auth config, rotatable authenticators (secp256k1, P-256, Ed25519, ML-DSA), 3-block delay, recovery. Called "the first step in Monad's post-quantum roadmap". Design only, no number. https://forum.monad.xyz/t/flexible-and-upgradeable-account-authentication/526

**PQ on the EVM**
- Lattice verifiers (self-reported, unaudited): ZKNOX ETHFALCON (MIT) Falcon-512 **1.5M gas EVM-friendly / 3.9M NIST-compliant** (447k is an experimental branch, not main); ML-DSA-44 ~1.23M (Fireblocks, unaudited) but ETHDILITHIUM NIST baseline **8.09M**; "+~4M once per key" UNVERIFIED. Hash-based (testnet, self-reported): FORS+C ~35k, WOTS+C ~73k; SPHINCS- SLH-DSA-Keccak-128 94k / SHA2-128 142k. Licences: ZKNOX ETHFALCON MIT; `nconsigny/SPHINCS-`, Kohaku pq-account and NiceTry (Solvency-Labs) have **no licence** — do not copy.
- Ethereum: EIP-8051/8052/8355 precompiles in Draft; EIP-8141 headlines Hegotá; PQ L1 target Dec 2029.
- No PQ account or verifier deployed on Monad. No EVM implementation of seed-knowledge EOA migration (Bitcoin prototype only: bip32-pq-zkp, Apr 2026, 1.7 MB proof).

**Canary prior art** (so the tripwire is integration, not invention): Drake 2018 cryptographic canaries; ERC-7826 Quantum Supremacy Bounty (factoring, 4337 wallets switch); BloQBench (2026); BitMEX canary fund and QCAP (Bitcoin); "Brace for impact" arXiv 2508.14011 (secp256k1-shaped curve ladder, off-chain); Project Eleven Q-Day Prize (15-bit key, Apr 2026, off-chain).

## Ranking

| # | Idea | Creat. | Recog. | Prod. | Ambit. | Fit | Day | Risk | Total |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Quantum lifeboat + tripwire | 8 | 9 | 7 | 10 | 8 | 6 | 5 | 78.5 |
| 2 | Lifeboat alone | 8 | 9 | 7 | 10 | 7 | 4 | 5 | 75.5 |
| 3 | Tripwire alone | 6 | 8 | 7 | 8 | 9 | 8 | 7 | 74.5 |
| 4 | PQ account per Monad's draft MIP | 5 | 9 | 7 | 7 | 8 | 7 | 7 | 71.0 |
| 5 | PQ stealth payments (ML-KEM, ERC-5564) | 8 | 7 | 6 | 8 | 7 | 6 | 6 | 70.0 |
| – | Rotating hash-based keys for fast apps | 5 | 6 | 7 | 6 | 8 | 8 | 7 | 64.5 |
| – | HNDL-safe encrypted memos | 6 | 6 | 6 | 5 | 5 | 8 | 8 | 61.5 |

## 1. Quantum lifeboat + tripwire

Prepare, detect, switch:
- **Prepare (lifeboat).** A user proves, with a STARK, that they know the seed behind their address (BIP-32 path to the address) and binds a new PQ key (ML-DSA) to it, without revealing the seed. Registered on Monad now, honoured by accounts, vaults and tokens that opt in, and shaped to become the migration path into Monad's account-authentication MIP. Anchor: Vitalik's quantum-emergency post (seed-knowledge STARKs), which nobody has built on any EVM.
- **Detect (tripwire).** An on-chain ladder of ECDLP bounties on small curves derived from public seeds (following "Brace for impact"), verified trustlessly in Solidity; claiming rung N proves capability at that size.
- **Switch.** Accounts and vaults set a policy ("at rung N, refuse ECDSA and passkeys; accept only the registered PQ key").

Why Monad: STARK and lattice verification that is uneconomic on Ethereum costs cents here, inside the 30M cap and 128 KB code limit; and Monad has publicly committed to a PQ account roadmap with ML-DSA in it.

Honest limits:
- An app cannot stop a quantum attacker from spending native MON from an EOA with a broken ECDSA key; EIP-7702 delegation is itself controlled by ECDSA. Only Monad's protocol change closes that. The product protects funds in smart accounts and opted-in contracts, and gives the protocol a ready migration path.
- A broken small curve does not prove secp256k1 falls on the same timeline; rungs are warnings, the top rung is the real trigger.
- STARK verification gas on Monad is unmeasured; it is the first unknown to settle.

Unknowns to kill first: STARK verifier gas and proof size on Monad (no Groth16 wrap, which is not PQ); BIP-32 proving time in a zkVM; ML-DSA verifier choice and licence; whether Category Labs wants an app-layer migration path aligned with the MIP.

---

# Round 2 (4 Nov 2026): the throughput problem

## New facts

**Monad**
- PQ roadmap, 28 Sep 2026 (Mohsen Ahmadvand): P0 accounts (auth draft), P1 consensus ("Quantum Cadence"), P2 staking, P3 PQ EVM precompiles, P4 proofs (STARKs), P5 encrypted mempool. It names no scheme and says nothing about signature size, bandwidth or gas. https://monad.xyz/blog/post-quantum-roadmap
- Quantum Cadence (arXiv 2610.32803, 23 Oct 2026) drops quorum certificates because "no PQ aggregate signature matches BLS". Category Labs has no PQ aggregation answer even for consensus.
- MIP-12 (Final): 300 ms blocks, caps of 3,750 tx, 150M gas and a **1,500,000-byte (~1.5 MB) `proposal_byte_limit`** per block. Max tx 384 KiB attributed to txpool code but **unverified** (no such per-tx constant found in monad-bft — to confirm). Monad's **existing calldata floor is 40 gas/B**; MIP-15 (Glamsterdam EIP Activation, **status Review**) adopts EIP-7981 for *access-list* cost (not calldata) and merely cites that 40 gas/B floor. [Correction: EIP-7981 is "Increase Access List Cost" at 64 gas/B, not a calldata price — see decisions.md.]
- Auth draft open questions: no gas figures per scheme; Falcon and SLH-DSA absent; no read path; no EIP-8141 coexistence plan.
- Scheduled Transactions draft (22 Oct 2026): system txs with no signature and no nonce. BTX encrypted mempool is classical; its PQ upgrade is P5.
- SP1 verifier gateways on chain 143 (Groth16/Plonk wraps, not PQ).

**The size problem (re-derived from MIP-12 + FIPS; K1 PASS, see decisions.md):** 1,500,000 B per block is ~400 B per tx at the 3,750-tx cap — a *block-capacity* ceiling of 12,500 tx/s (3,750 ÷ 0.3 s), **not** measured live TPS (Monad's ~10k TPS is a design target). ML-DSA-44 (sig + key ~3.7 KB) leaves ~369 tx per block; sig only (key stored) ~544; Falcon-512 ~1,498; SLH-DSA-128s ~183. All are block-capacity, not bandwidth (validators need ~300 Mbit/s). No Monad analysis of signature size exists — confirmed gap.

**Aggregation**
- EIP-8288 "In-mempool signature and proof aggregation" (Vitalik Buterin, Thomas Coratger; Draft, 3 Jun 2026; requires EIP-2718 + EIP-8141): one recursive STARK per block covers all PQ signatures (leanSPHINCS) and STARKs. Consensus-breaking Ethereum protocol change only. https://eips.ethereum.org/EIPS/eip-8288
- ERC-4337 EntryPoint v0.9 still supports `IAggregator` / `handleAggregatedOps`; Rundler, Alto, Voltaire and Skandha have the code path. ERC-7766 was withdrawn: "No production adoption of aggregateable signature schemes". No PQ aggregator has been built anywhere.
- leanMultisig (self-reported, Apple M4 Max): 1,400 leanXMSS sigs in 1.15 s, proof 359.5 KiB (**~263 B per signature**), verify 7.45 ms; "not yet production ready"; **192-bit binary tower field** (KoalaBear was the prior field) with WHIR; a Python verifier exists (not the only one). https://github.com/leanEthereum/leanMultisig
- WHIR-in-Solidity: repo `privacy-ethereum/sol-whir` exists; the specific "5.65M gas (PCS opening only), 54 KB proof" figures are **UNVERIFIED** (not sourced). A KoalaBear WHIR EVM verifier is discussed at ~1-2M gas at lower security (clientsideproving HackMD). Full STARK verifiers in Solidity: est. 5-20M gas (unverified).
- Falcon aggregation analysis (Sanso, Thiery, Wagner, 18 Mar 2026): execution-layer break-even at about 200 signatures per batch (~100 on the consensus layer), far below what a Monad block can hold. https://ethresear.ch/t/revisiting-falcon-signature-aggregation-for-pq-mempools/24431

## Ranking, round 2

| # | Idea | Creat. | Recog. | Prod. | Ambit. | Fit | Day | Risk | Total |
|---|---|---|---|---|---|---|---|---|---|
| 1 | PQ signature aggregation for Monad (4337 aggregator + on-chain STARK verifier) | 9 | 9 | 7 | 10 | 9 | 6 | 4 | 80.5 |
| 2 | Lifeboat + tripwire (round 1) | 8 | 9 | 7 | 10 | 8 | 6 | 5 | 78.5 |
| 3 | Reference PQ authenticators + benchmarks for Monad's auth draft | 5 | 9 | 7 | 6 | 8 | 8 | 8 | 71.5 |
| 4 | PQ encrypted order flow (ML-KEM, beyond classical BTX) | 8 | 7 | 6 | 9 | 7 | 5 | 4 | 68.5 |
| 5 | PQ intents over signature-free scheduled txs | 7 | 6 | 5 | 6 | 7 | 5 | 4 | 58.5 |
