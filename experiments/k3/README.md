# K3: proof system choice (research, throwaway)

Date: 4 Nov 2026. Machine: Apple M4, 16 GB. Foundry/anvil local only. **Every gas number below is
from a local anvil node, not Monad.** Vendored repos live in `vendor/` (git-ignored); raw results in
`results/`.

## Candidate table

| Candidate | Licence (checked from files) | What exists | Field / hash in EVM | Ran? | Measured (anvil) | Claimed (self-reported) | Main blocker |
|---|---|---|---|---|---|---|---|
| **sol-spartan-whir LeanVM terminal** — [alxkzmn/sol-spartan-whir](https://github.com/alxkzmn/sol-spartan-whir) @ `18eda72`; upstream [ethereum/sol-whir-p3](https://github.com/ethereum/sol-whir-p3) @ `b82359e` | **No LICENSE file** in either repo (GitHub API: `license: null`). README says "License: MIT"; all 107 `src/` files carry `SPDX-License-Identifier: MIT`. | Full recursive verifier: one Solidity contract checks a LeanVM "terminal" proof (root AIR, LogUp/GKR, public memory, WHIR openings), whose guest execution runs a complete Spartan-WHIR verifier. Plus standalone WHIR PCS verifiers. Fixture proof checked in; **prover for the terminal profile is not in the repo** (scripts point at an external `../leanVM` workspace). | KoalaBear (31-bit) + quintic extension; Keccak ("keccak240", 30-byte digests) for Merkle and transcript. No Poseidon in the EVM. | **Yes** | Verify tx **12,896,156 gas**, status 1, `eth_call` returns true. Calldata **106,628 B** (4/16 gas: 1,598,840). Execution ≈ 11,276,316. Runtime **62,732 B** (> EIP-170 24 KB, < Monad 128 KB). Deploy tx 13,584,540 gas. Two tampered proofs revert (`MERKLE_ROOT`, `SUMCHECK_IDENTITY`). | Same 12,896,156 in README (ours matches exactly). Upstream grouped variant: 10,666,368 gas / 99,044 B, "security under review" (not run by us). 100-bit target. | Terminal prover and its public-input binding (what statement the proof is about) are not available here; the fixture's application statement is a test instance, not signatures. Tied to the KoalaBear-era leanVM, while leanVM `main` has moved to binary fields. Licence file missing. |
| **sol-spartan-whir standalone WHIR (PCS only)** — same repos | same as above | WHIR polynomial opening verifier only (not a full SNARK) | KoalaBear/BabyBear ext5/ext8; Keccak | Built, not tx-measured | — | KoalaBear quintic 2^22 @ 100-bit Johnson bound: 3,637,880 tx gas, 54,436 B (fork README); 2,972,399 gas (upstream README); ethresear.ch post: 5,646,080 (older revision) | PCS only; we'd still need the Spartan/AIR part. Superseded by the terminal for our purpose. |
| **sol-whir** — [privacy-ethereum/sol-whir](https://github.com/privacy-ethereum/sol-whir) @ `b719b97` (Dec 2024) | LICENSE-MIT. **But depends on `solidity-bn254` (EspressoSystems), which is GPL-3.0** — not reusable under our rule. | WHIR PCS opening verifier only. Example proof checked in; prover is a fork ([dmpierre/whir feat/evm-verifier](https://github.com/dmpierre/whir/tree/feat/evm-verifier), not run). | BN254 scalar field (no pairings); Keccak | **Yes** | Verify tx **1,135,052 gas**, calldata **28,740 B**; in-call verify 677,011 gas (forge snapshot). Params: 2^16 vars, fold 4, rate 1/64, 80-bit, `ConjectureList`. | ethresear.ch reports the same 1,135,052 for this fixture. | PCS only; 80-bit under the capacity-bound conjecture, which the alxkzmn post says has since been ruled out; GPL dependency; stale. Not a candidate. |
| **leanVM / leanMultisig** — [leanEthereum/leanMultisig](https://github.com/leanEthereum/leanMultisig) @ `4b67ca0` (now titled leanVM) | LICENSE-MIT + LICENSE-APACHE (dual) | Full prover (leanXMSS / leanSPHINCS aggregation, 2-to-1 recursion), Rust + Python verifier. **No EVM verifier for the current version.** | 192-bit binary tower field; Keccak-256 (README: "a placeholder: SHA2, BLAKE2s and BLAKE3 are actively considered") | **Yes** (prover only; needs Rust nightly, `isolate_lowest_one` is unstable on 1.95/1.96) | M4 16 GB, `--log-inv-rate 1`: 256 sigs **299.8 KiB, 0.615 s**, 1.6 GiB; 1,024 sigs **326.3 KiB (≈326 B/sig), 3.3 s**, 5.0 GiB, native verify 9.6 ms. `--log-inv-rate 3`: 1,024 sigs 207.3 KiB but 54.8 s (high system time, likely memory pressure). | 1,400 leanXMSS sigs: 1.15 s, 359.5 KiB, M4 Max; recursion 2→1: 216.9 KiB, 0.31 s | Binary-field arithmetic is expensive in the EVM (no carry-less multiply); a direct Solidity verifier would have to be written; proof ≥ 217 KiB. The Solidity terminal above targets the older KoalaBear leanVM, not this one. |
| **Plonky3** — [Plonky3/Plonky3](https://github.com/Plonky3/Plonky3) | MIT / Apache-2.0 (LICENSE-MIT checked) | Mature prover, Keccak config available. **No Solidity verifier found** (web search). | BabyBear/KoalaBear/M31/Goldilocks; Keccak possible | No | — | — | Would write a FRI+AIR verifier in Solidity ourselves (weeks). |
| **Stwo** — [starkware-libs/stwo](https://github.com/starkware-libs/stwo) | Apache-2.0 (LICENSE checked) | Circle-STARK prover; Rust verifier described as portable. **No Solidity verifier found.** | M31 | No | — | — | Same as Plonky3: we'd write the verifier. |
| **Stone / starkex-contracts** — [starkware-libs/starkex-contracts](https://github.com/starkware-libs/starkex-contracts) | Apache-2.0 (file header checked) | Battle-tested Solidity STARK verifier (`evm-verifier`) | 252-bit Stark field; Keccak | No | — | Verification split across many txs (unverified for this repo) | Cairo toolchain; multi-tx; older and gas-heavy by design (unmeasured here). |

## The K4 data point (local, anvil only)

`results/leanvm-terminal-c1-anvil.json`. One transaction verified a real hash-based recursive proof:

- gasUsed **12,896,156** (Ethereum calldata pricing, anvil, Cancun, `--code-size-limit 65536`).
- calldata **106,628 B** (~104 KiB), one transaction.
- Monad cost estimate (not measured): execution ≈ 11.28M + 21k + calldata at the 40 gas/B floor
  (4,265,120) = **~15.6M** if Monad adds the floor on top; ~12.9M if it behaves like EIP-7623
  (max of standard and floor). Either way under the 25M K4 bar and Monad's 30M cap.
- Contract 62,732 B: fits Monad's 128 KB limit in one contract (it would not deploy on Ethereum L1).

What this does **not** show: that we can produce such a proof for our own statement (N signature
checks). The statement in the fixture is the authors' test instance.

Repro (from `vendor/sol-spartan-whir`, after copying forge-std and solady into `lib/` and `forge build`, ~4 min):
```sh
anvil --port 8547 --hardfork cancun --code-size-limit 65536 --gas-limit 1000000000
N=LeanVmTwoCommitmentTerminal_KeccakPublicMemoryC1Pow28T6
A=$(cast send --rpc-url http://127.0.0.1:8547 --private-key $PK --gas-limit 25000000 \
    --create $(jq -r .bytecode.object out/$N.sol/$N.json) --json | jq -r .contractAddress)
cast send --rpc-url http://127.0.0.1:8547 --private-key $PK --gas-limit 30000000 $A \
    0x$(xxd -p testdata/leanvm_terminal/$N#*_/calldata.bin | tr -d '\n')
```
(The repo's own `script/measure_leanvm_terminal_tx.py` refuses to run at `18eda72` because a source
hash in the fixture manifest no longer matches; we used `cast` directly.)

sol-whir repro: `forge test --via-ir --optimize` and
`LOCAL=true LOCAL_PRIVATE_KEY=$PK forge script script/Verify.s.sol --via-ir --optimize --tc VerifyScript --rpc-url $RPC --broadcast`.

## Recommendation

**STARK path: leanVM recursion ending in a Keccak "terminal" proof, verified by the sol-spartan-whir /
sol-whir-p3 LeanVM terminal contract.** It is the only candidate with a complete (not PCS-only)
hash-based verifier in Solidity that we ran, and it already fits Monad's per-tx gas, size and
128 KB code limits.

What is missing to prove N signature verifications:
1. **The terminal prover.** Find the leanVM branch/workspace that emits `terminal-c1` fixtures (the
   scripts reference `../leanVM/benchmark-results/terminal-c1-b-threshold6-pow28`), or ask the
   authors (alxkzmn, ethereum/sol-whir-p3). Without it, nothing else moves.
2. **A statement binding.** The terminal's public memory must commit to our batch (root of
   (pubkey, message) pairs, or the 4337 userOpHashes). Needs a guest program change and a matching
   Solidity public-input check.
3. **Signature scheme alignment.** Aggregate leanXMSS (what leanVM already proves), and make the
   user-side / fraud-proof verifier in Solidity check the *same* scheme. Our `WOTS.sol` (Keccak,
   w=16, 67 chains) is not leanXMSS; either port leanXMSS verification to Solidity, or write a
   WOTS-Keccak guest program.
4. **Version drift.** The Solidity terminal targets KoalaBear-era leanVM; leanVM `main` is now
   binary-field. Either pin the KoalaBear branch or wait for a terminal for the new version.
5. **Licence.** Get a LICENSE file added to sol-spartan-whir / sol-whir-p3 (README + SPDX say MIT).

Effort (estimate, not measured): if the terminal prover is obtainable and runs, ~1-2 weeks to prove
N leanXMSS signatures end-to-end with a bound public input and verify on Monad testnet. If we must
build the terminal profile ourselves, 4+ weeks and real cryptographic risk. Writing our own FRI
verifier for Plonky3/Stwo is the plan-B at ~4+ weeks.

**K6 (hash tension).** This path largely dissolves it: the EVM verifier computes only Keccak (and
31-bit field arithmetic); no Poseidon2 in Solidity. Inside the proof, current leanVM proves Keccak
via GKR (self-reported 560K permutations/s). The remaining tension is only for the KoalaBear-era
leanVM, whose in-VM hash for leanXMSS was Poseidon; that costs prover time, not EVM gas.

**K5 data (measured, leanVM prover only, no EVM).** 1,024 leanXMSS signatures: 326.3 KiB (≈326 B/sig, under the 400 B bar) in 3.3 s on a base M4 (just over the 3 s bar; README reports 1.15 s for 1,400 on an M4 Max). This proof has no EVM verifier.

**K5 implication for the terminal path (unmeasured).** The terminal proof is constant-size (~104 KiB) regardless of N, so
bytes/sig ≈ 106,628 / N (≈ 104 B at N = 1,024) and gas/sig ≈ 12.9M / N — *if* the recursion
from an N-signature aggregation to the terminal works, which is unproven.
