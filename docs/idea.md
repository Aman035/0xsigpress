# Sigpress: post-quantum signatures without losing Monad's throughput

Working name. One proof replaces thousands of post-quantum signatures, so Monad can go quantum-safe and stay fast.

## The problem

- Monad's speed comes from packing transactions into a block capped at **1,500,000 bytes (~1.5 MB)** every 300 ms: up to 3,750 transactions, about **400 bytes each** ([MIP-12](https://mips.monad.xyz/MIPs/MIP-12), Final).
- Today's signatures are 65 bytes. Post-quantum ones are 0.7-8 KB. ML-DSA-44, named in Monad's own [account-authentication draft](https://forum.monad.xyz/t/flexible-and-upgradeable-account-authentication/526), needs about 2.4 KB of signature plus a 1.3 KB public key (~3.7 KB total; [FIPS 204](https://csrc.nist.gov/pubs/fips/204/final)).
- If wallets switch, the block fills with signatures. Measured against MIP-12's byte cap, **block capacity falls from 3,750 transactions to ~370-540** with ML-DSA-44 (an 85-90% cut). As a theoretical max-TPS figure that is ~12,500 falling to ~1,230-1,815 — but note ~12,500 is the *block-capacity ceiling* (3,750 ÷ 0.3 s), not measured live throughput, and Monad's "~10k TPS" is a design target. [K1 PASS, see decisions.md.]
- Monad's PQ roadmap (28 Sep 2026) does not mention signature size, bandwidth or throughput. Its consensus research (Quantum Cadence, Oct 2026) drops quorum certificates because "no PQ aggregate signature matches BLS". The size problem is unsolved at both layers.

## The idea

Users keep signing every transaction with a post-quantum key. An **aggregator** collects many signed operations, proves "all N signatures are valid" in **one hash-based STARK**, and posts the operations with that single proof. A contract on Monad checks the proof once.

- The EF's [leanMultisig](https://github.com/leanEthereum/leanMultisig) prototype aggregates 1,400 leanXMSS (hash-based) signatures into a 359.5 KiB proof, about **263 bytes per signature**, in 1.15 s on an Apple M4 Max (self-reported; "not yet production ready"; 192-bit binary tower field with WHIR).
- The proof is itself hash-based, so the whole path is post-quantum. No Groth16 or pairing anywhere.

## How it fits Monad today, with no protocol change

- **ERC-4337 signature aggregators.** [EntryPoint v0.9](https://eips.ethereum.org/EIPS/eip-7766) still defines `IAggregator` and `handleAggregatedOps`. Monad has the standard EntryPoints v0.6-v0.8 deployed (v0.9 appears deployed but is unverified on the explorer — to confirm). Users get post-quantum smart accounts; our aggregator contract is the verifier.
- **Monad makes the verifier affordable.** 30M gas per transaction, 150M per block, 128 KB contracts ([MIP-2](https://mips.monad.xyz/MIPs/MIP-2)), linear memory and cheap Keccak (max tx size ~384 KiB is in the txpool code but still to verify). Verification that would cost tens of dollars on Ethereum costs cents here.
- **It plugs into Monad's roadmap.** It is the missing piece behind P0 (PQ accounts) and P4 (STARK proofs), and it can later become a protocol feature, as EIP-8288 proposes for Ethereum.

## What is new

- [EIP-8288](https://eips.ethereum.org/EIPS/eip-8288) "In-mempool signature and proof aggregation" (Vitalik Buterin and Thomas Coratger, Draft, 3 Jun 2026) proposes folding all of a block's PQ signatures (leanSPHINCS) and STARKs into one recursive STARK — but as an Ethereum consensus-breaking protocol change (it requires frame transactions, EIP-8141). Nobody has built a working version on any chain.
- ERC-7766 (aggregatable signatures for 4337) was withdrawn: "no production adoption of aggregateable signature schemes". This would be the first.
- No on-chain verifier exists for the EF's aggregation proofs; their verifier is Python only.
- No Monad analysis of PQ signature size exists.

## Who uses it

- **Wallets on Monad** that want post-quantum accounts without making their users pay in block space.
- **High-frequency apps** (games, trading, payments) that need many signed actions per second, which is exactly where naive PQ hurts most.
- **Monad itself**, as evidence and a reference implementation for making aggregation native.

## Honest limits

- **Latency.** Proving takes about a second, longer than a block, so batches span several blocks. A single operation can always be verified alone, at full size, as a fallback.
- **Stateful keys.** Hash-based keys can sign a bounded number of messages and must never reuse a one-time key. Wallets must track key state (the same lesson as RLN slots).
- **Bytes saved are signature bytes only.** ERC-4337 operations carry other fields too. The goal is "a post-quantum operation costs about what a classical transaction costs today", not less.
- **The outer transaction is still ECDSA.** The bundler signs it classically until Monad's native PQ accounts land. A broken bundler key cannot move user funds, because users authorise with PQ signatures, but it could censor or stall.
- **Research-grade parts.** leanMultisig is "not production ready" and its numbers are self-reported.
