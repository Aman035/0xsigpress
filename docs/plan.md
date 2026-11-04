# Plan

Rule: nothing gets built until the blockers below are answered. Each kill test is time-boxed, has a pass line, and says what to do if it fails. Run them in order: the cheapest checks that could sink the idea come first, and the biggest unknown starts on day one.

## Part 1: Kill tests

**Status (4 Nov 2026):** Tier 0 is done — **K1 and K2 both PASS** (fact-check pass, recorded in
`decisions.md`). The critical path now starts at **K3 → K4 (the go/no-go)**. The next concrete action
is K3: pick a proof system with a path to a Solidity verifier, then verify a real proof on Monad
testnet (K4).

### Tier 0: is the problem real? (half a day) — DONE

If the problem is smaller than claimed, the pitch dies before any code.

**K1. Re-derive the throughput numbers from primary sources.** Time box: 2 h. **— DONE, PASS.**
- Read [MIP-12](https://mips.monad.xyz/MIPs/MIP-12) (block byte cap 1,500,000 B, tx cap 3,750). Note:
  there is no "MIP-15 calldata price" — MIP-15 is *access-list* cost (EIP-7981, in Review); Monad's
  **calldata floor is 40 gas/B** (pre-existing, cited by MIP-15). The 384 KiB max-tx size in monad-bft
  is **unverified** (no such constant found) — still to confirm.
- Computed block capacity at the byte cap for ECDSA, ML-DSA-44 (with/without pk), Falcon-512,
  SLH-DSA-128s. Result: ML-DSA cuts capacity from 3,750 to ~370-540 tx/block (85-90%). See the table in
  `decisions.md`.
- **Pass line:** naive ML-DSA cuts block capacity by ≥70%. **Met (85-90%).**
- **Remaining TODO:** query a live mainnet block for real average tx size / utilisation, so the pitch
  can state utilisation honestly alongside the capacity ceiling (framed as capacity, not live TPS).
- **Fail (not triggered):** if the byte cap were not binding (compute binds first), reframe around cost
  per transaction or bandwidth, or drop the idea.

**K2. Check nobody has shipped it on Monad.** Time box: 1 h. **— DONE, PASS.**
- Searched the Monad forum, Category Labs, the EIP-8288 thread, and PQ-verifier repos. Nothing working
  exists: ERC-7766 withdrawn, EIP-8288 is a Draft Ethereum protocol design with no implementation,
  leanMultisig has no EVM verifier, Quantum Cadence has no PQ aggregation answer. See `decisions.md`.
- **Pass:** nothing working exists. **Met.**
- **Fail (not triggered):** if Category Labs had a native plan in progress, become its app-layer
  prototype and benchmark source, and say so in the pitch. (Monad *has* a PQ roadmap but no aggregation
  plan — so we are the first, and the pitch frames the native path as "where it goes".)

### Tier 1: can it be verified on chain? (the project lives or dies here; 2-4 days)

**K3. Choose a proof system with a path to a Solidity verifier.** Time box: 1 day, reading and running examples.

The proof must be hash-based (post-quantum), small, and cheap to check in the EVM. Candidates, best first:

| Candidate | Why it might work | Main risk |
|---|---|---|
| Spartan + WHIR (privacy-ethereum `sol-whir`) | A Solidity WHIR verifier exists; a KoalaBear WHIR EVM verifier is discussed at ~1-2M gas at lower security (specific "5.65M gas, 54 KB" figures are unverified) | Is the full Spartan verifier there, or only the commitment? R1CS for hash-signature checks may be large |
| leanMultisig (EF) | Built for exactly this (leanXMSS aggregation), 1,400 sigs in 359.5 KiB | Verifier is a research prototype (Python exists, no EVM verifier); 192-bit binary tower field and its hashes are expensive in the EVM; "not yet production ready" |
| Plonky3 / Stwo STARK with a Keccak transcript | Mature provers; Keccak is cheap in the EVM | No Solidity verifier found; we would write one |
| Starkware Stone verifier (Solidity, on Ethereum for years) | Battle-tested EVM STARK verifier | Splits verification across many txs; Cairo toolchain; licence |

- **Pass:** one candidate has (a) a Solidity verifier we can adapt in about two weeks, or (b) a verifier small enough to write in under four weeks, with a known gas estimate.
- **Fail:** if no candidate clears either bar, fall back to K7, the optimistic design.

**K4. Get a real proof verified on Monad testnet.** Time box: 2 days. **This is the go/no-go.**
- Take the chosen system's example proof (any statement, about 2^20 constraints or more) and verify it with its Solidity verifier on Monad testnet.
- Record: gas used, proof bytes, tx size, and whether it fits one transaction.
- **Pass:** verifies in ≤ 25M gas (headroom under the 30M cap, confirmed) and small enough to fit one transaction (target ≤ 300 KiB — but first confirm the real max-tx size, since the 384 KiB figure is unverified), in one transaction or at most three chained ones.
- **Fail:** over budget even split across transactions → no-go for full validity proofs. Go to K7.

**K5. Will the proof be small enough per signature?** Time box: 1 day, in parallel with K4.
- Prove N hash-based signature verifications (N = 256, 1,024, 4,096) with the chosen system. Use leanXMSS-style verification (as in leanMultisig) with the cheapest hash for that system.
- Record proof size, prove time, peak memory.
- **Pass:** bytes per signature ≤ 400 at N ≥ 1,024 (beats today's average tx), and prove time for 1,024 signatures ≤ 3 s on one strong machine.
- **Fail:** bytes per signature ≥ 1 KB → the throughput story weakens to "Falcon-size". Try a bigger N, or recursion to compress. If still bad, stop.

**K6. Is the hash cheap on both sides?** Time box: half a day, answered within K3 to K5.
- The signature hash (inside the proof) and the proof's own Merkle/transcript hash (inside the EVM verifier) pull in opposite directions: Poseidon2 is cheap to prove but expensive in Solidity; Keccak is the reverse.
- **Pass:** a configuration where the EVM verifier only computes Keccak (or a precompile), and proving stays within K5.
- **Fail:** if verifying needs Poseidon2 in Solidity, re-measure K4 with it. If that blows the budget, change the configuration or go to K7.

**K7. Fallback design: optimistic aggregation.** Run only if K4 or K6 fails. Time box: 1 day, design only.
- The aggregator posts operations with signatures off chain, stored with a data-availability commitment, plus a bond. Anyone can challenge a single signature within a window; the contract verifies that one signature on chain (hash-based ~73k-150k gas) and slashes the bond.
- Still post-quantum (fraud proofs check real PQ signatures), and bytes per operation drop to near zero.
- Costs: a challenge window delays finality, and data availability must be solved.
- **Decide:** if data availability has a credible answer on Monad, continue with this design and reword the pitch to "optimistic". Otherwise stop.

### Tier 2: does it plug into Monad's account abstraction? (1-2 days)

**K8. Run `handleAggregatedOps` on Monad testnet.** Time box: 1 day.
- Deploy a trivial aggregator (accepts any signature) and a test account that names it. Send a bundle through `handleAggregatedOps` on **EntryPoint v0.8** (v0.9 appears deployed on Monad but is unverified on the explorer — confirm before relying on it; note v0.9 restricts the caller to a top-level EOA).
- Run our own bundler with the aggregator compiled in: **Rundler** (Alchemy) is the one confirmed to support the aggregator code path (it ships BLS and PBH aggregators). Alto/Voltaire/Skandha aggregator support is unverified — check each repo before assuming. Also check whether hosted bundlers on Monad accept aggregated ops.
- **Pass:** an aggregated bundle executes on Monad testnet.
- **Fail:** if EntryPoint aggregation is broken or blocked on Monad, submit through our own entry contract. That works, but we lose the "standard 4337" pitch line.

**K9. Measure the real bytes per operation.** Time box: half a day.
- An aggregated UserOperation still carries sender, nonce, callData, gas fields and paymaster data. Measure bytes per operation in a real `handleAggregatedOps` call against a normal Monad transaction.
- **Pass:** a PQ-aggregated operation is within 1.5x of a normal Monad transaction's bytes.
- **Fail:** if 4337 overhead dominates, design a compact bundle format (fields deduplicated or compressed, our own entry contract). That adds about two weeks but is not fatal.

**K10. Check licences.** Time box: 1 h.
- Every reused component (prover, verifier, hash libraries, signature code) must be MIT or Apache-2.0. **Confirmed usable:** ZKNOX ETHFALCON (MIT). **No licence — do not copy:** Kohaku pq-account, NiceTry (Solvency-Labs), `nconsigny/SPHINCS-`. leanMultisig's licence must be checked before reuse.
- **Fail:** if the only workable verifier is GPL or unlicensed, rewrite it or ask the authors.

### Go/no-go after about 5-7 days

| Outcome | Decision |
|---|---|
| K1, K4, K5 pass | **Go**: full validity-proof version |
| K1 passes, K4 or K5 fails, K7 credible | **Go**: optimistic version, adjusted pitch |
| K1 fails | Stop; the hook is gone |
| K4 and K7 both fail | Stop; not buildable today on Monad |

Write the answers into a `decisions.md` as each test finishes, with the measured numbers.

## Part 2: The build, if go (about 4 months)

**Weeks 2-5: the verifier.**
- Production Solidity verifier for the chosen proof system; differential tests against the reference verifier.
- Fuzzing of proof parsing; gas profile per component; fits Monad limits with headroom.

**Weeks 4-8: the prover and aggregator service.**
- Circuit or program that verifies N hash-based signatures and binds each to its UserOperation hash and account public key (public inputs).
- Aggregator service: collects ops, batches by size and time, proves, submits; fallback to single-op verification on timeout.
- Benchmarks across N and hardware.

**Weeks 6-10: the account and wallet.**
- PQ smart account (ERC-4337) with hash-based keys; key state tracking that is crash-safe; key rotation before a key runs out.
- SDK: create account, sign, submit, with a viem integration. Local dev mode.

**Weeks 9-12: product surfaces.**
- Live throughput demo (naive vs aggregated gauges), batch explorer, wallet onboarding.
- Docs: protocol spec, "what is and isn't quantum-safe", operator guide for running an aggregator.

**Weeks 12-16: hardening.**
- Security review of the verifier and the binding of signatures to operations; a soundness argument written down.
- Load test at Monad block rates; a mainnet beta with capped value.
- Write-up for Category Labs: measured numbers, a proposal for native aggregation shaped like EIP-8288.

## Part 3: The Blitz day

Blitz rules: code starts on the day, public repo, deployed on Monad testnet, peer vote on novelty. Only research and the kill-test measurements happen before. Rebuild on the day:
1. A PQ test account and the aggregator contract with the verifier (the hard part; this is why K4 must already have passed).
2. Prove a batch of real hash-based signatures off chain; verify on Monad testnet.
3. The two-gauge demo page.
4. Tamper with one signature and show the batch rejected.

Can the verifier be rebuilt from scratch in one day? Decide after K4. If not, the Blitz entry is the size-problem measurement plus a working optimistic or single-signature version, and the full verifier is the 4-month product.

## Part 4: Risk register

| Risk | Signal | Response |
|---|---|---|
| No affordable EVM verifier | K4 over budget | Optimistic design (K7), or wait for a precompile |
| Proving too slow for 300 ms blocks | K5 prove time | Multi-block batches; parallel provers; GPU |
| Hash-based key reuse | Wallet crash between sign and persist | Persist key index before signing (RLN lesson) |
| Category Labs builds it natively first | Forum / roadmap | Be the reference implementation and benchmark source |
| Aggregator censorship | Ops not included | Anyone can run an aggregator; single-op fallback |
| leanMultisig changes fast | Breaking upstream changes | Pin versions; own the circuit |
