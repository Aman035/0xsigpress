# K10-terminal: our leanXMSS batches -> leanVM -> lift -> Keccak terminal -> Solidity, on Monad

Research, throwaway. Date: 4 Nov 2026. Machine: Apple M4 (base, 10 cores), 16 GB. Vendored clones in
`vendor/` (git-ignored); our changes to them are in `patches/`; raw outputs in `runs/` and `results/`.

## Result

**End to end works, including on Monad testnet**, for 2 batches x 4 leanXMSS signatures (8 sigs):

our two signature batches -> two leanVM aggregation proofs -> two lifts -> one Keccak240 terminal root
proof -> Solidity verifier generated for exactly this chain -> verified on anvil and on Monad testnet,
through a small gate contract that binds the proof's application root to our two 32-byte batch roots.

| Monad testnet (chain 10143) | Value | Tx |
|---|---|---|
| Verifier `LeanVmTwoCommitmentTerminal_SigpressXmssC1N4` deployed | `0x92a964b177f2d6726121829df3218b9e667f4e9b`; estimate 13,572,655, charged 14,251,287 (limit) | `0xbc69dcabdd3a10f786aa1f4dce3abd4b395addcac8a532412bb3c7fa6ccbd62d` |
| `eth_call verifyC1V1(proof)` | `true` | RPC |
| Same proof, 1 bit flipped at byte 60,000 | reverts `MERKLE_ROOT` | RPC |
| Gate `SigpressTerminalGate` deployed | `0x457f78edcdef6de1af2ce16ed62af567d0e5fef9` | `0xc038e32853b9493dbcb559e55ea8cf944c915ba5fa34ebba7ddd52925bcaa3ab` |
| `register(left, right, applicationRoot)` | ok | `0xcf5754f60cd9e01ef365213ccf5f04567f56a35db48a71fc176e4fa438609d3c` |
| `submit` with left/right batch roots swapped (`eth_call`) | reverts `ROOT_MISMATCH` | RPC |
| **`submit(proof, left, right)`: verify terminal proof + check root, one tx** | **status 1; estimate 12,188,298 gas, charged 12,797,712 (limit)**; calldata 106,404 B | `0x55212a0000c95dd33fcdc9510a32434afe1143dd73b1391bcde0098d79904f92` |
| `accepted(pairKey(left, right))` | `true` | RPC |

Batch roots (the 32-byte message each batch signs): left
`0xeaad7898beffecdf1307b1d0dcbe59bdac732f75722231629e5886e56ca33a76` (= sha256("sigpress-left-batch")),
right `0x0ab8a68e4d9be29dbd9ba0c8612285b203a9fb00315823b1e9fb99278a2acf6d` (= sha256("sigpress-right-batch")).
Override with `SIGPRESS_LEFT_ROOT` / `SIGPRESS_RIGHT_ROOT`. Gas price on the day: 102 gwei. We skipped the
standalone `verifyC1V1` tx on Monad to save faucet MON (`SKIP_VERIFY_TX=1`); `submit` includes it.
Anvil (Prague, 128 KB code limit) numbers for the same proof: standalone verify tx **12,093,782 gas**,
submit 12,168,193, verifier deploy 13,476,927. Runtime 62,243 B (fits Monad's 128 KB, not Ethereum's 24 KB).

The `submit_swapped_roots_eth_call` lines in `results/*-n4.jsonl` originally printed
`"ROOT_MISMATCH\nunexpected"` (a `pipefail` bug in the script's fallback echo; the call did revert with
`ROOT_MISMATCH`). We fixed the script and cleaned those two lines by hand.

## Prover numbers (measured, this machine)

One process proves both direct proofs, both lifts and the root, then natively verifies all five and
runs the authors' negative checks (changed application root, changed program evaluation, wrong terminal
profile, wrong fixed-program commitment: all rejected). Times are single diagnostic runs (not averaged),
with other desktop apps open. RSS from `/usr/bin/time -l` (max RSS / macOS peak footprint, which
includes compressed memory).

| Batches | child dim | direct L / R | direct proof B | lift L / R | root (Keccak) | **terminal proof B** | all proving | wall | max RSS / footprint |
|---|---|---|---|---|---|---|---|---|---|
| 2 x 4 | 20 | 0.35 / 1.13 s | 137,530 | 8.8 / 8.5 s | 22.2 s | 110,531 | 40.9 s | 47.9 s | 5.87 GB / 15.2 GB |
| 2 x 64 | 22 | 0.78 / 1.02 s | 179,071 | 7.2 / 9.2 s | 33.3 s | 110,984 | 51.6 s | 59.1 s | 5.39 GB / 15.1 GB |
| 2 x 256 | 24 | 1.93 / 1.80 s | 207,719 | 9.5 / 11.4 s | 33.1 s | 110,952 | 57.7 s | 66.8 s | 5.99 GB / 14.7 GB |
| 2 x 4, padded to the 2 x 256 shape | 24 | 1.64 / 1.10 s | — | 7.9 / 8.8 s | 25.7 s | — | — | 51.9 s* | 6.17 GB / 14.1 GB |

\* ran concurrently with a `forge test`, so its timing is pessimistic.

Plus, outside proving: aggregation-bytecode compile + key generation ~1.6 s, lift compile ~0.9 s, root
compile ~1.1 s, fixed-program commitment (once per verifier) ~2.3-2.6 s.

On-chain side, anvil (Prague), each with its own generated verifier:

| Batches | calldata B | verify tx gas | gate `submit` gas | generated tests |
|---|---|---|---|---|
| 2 x 4 | 106,340 | 12,093,782 | 12,168,193 | 16/16 |
| 2 x 64 | 106,692 | 12,105,473 | 12,180,094 | 16/16 |
| 2 x 256 | 106,628 | 12,100,827 | 12,175,409 | 16/16 |

What this shows:
- **On-chain cost is flat in N**: ~106.5 KB and ~12.1M gas for 8 or 512 signatures (= ~23.6k gas/sig
  and ~208 B/sig at 512, from these runs). The prover time is dominated by lift + root (~40-55 s here),
  which barely moves with N because the lift and root programs have fixed size (dim 23).
- **One verifier per shape, not per N.** Each child dimension gets a different lift/root program and
  so a different verifier (the 2 x 64 proof is rejected by the 2 x 4 verifier: `FIXED_PROGRAM_ROOT`).
  But padding the child tables with `SIGPRESS_MIN_LOG_ROWS=18,13,16` makes a 2 x 4 proof use the exact
  same fixed programs as 2 x 256 (bytecode MLE hashes equal, generated contract config identical), and
  the **already-deployed 2 x 256 verifier accepts it** (`results/anvil-n4pad256-on-n256-verifier.json`).
  So a product deploys one verifier for a maximum shape and pads smaller batches.
- **16 GB was enough** for all runs (max RSS ≤ 6.2 GB, though macOS reported ~14-15 GB peak footprint).

## One fixed-shape (2 x 256) verifier on Monad testnet

Addresses, ABIs and calldata formats for integration: `deployed-2x256.json`. Log:
`results/monad-2x256.jsonl` (some `full_2x256` read-only lines appear twice: the check script was run
once without and once with the submit tx). Gas price 102 gwei; gas limit = estimate + 5% (Monad charges
the limit).

| Step | Estimate | Charged | Calldata | Tx / result |
|---|---|---|---|---|
| Deploy verifier `LeanVmTwoCommitmentTerminal_SigpressXmssC1N256` -> `0xf563bb0b43d6090c89d45a7a780c8ab0175d92d2` | 13,572,474 | 14,251,097 | — | `0x294ec3d37e775926ada1d2d403e60c16950e128e0084e6064da8adacc566cca1` |
| Deploy gate -> `0xdf9bfc6a96fb36cef902eb9e95a65da4b5a94c8e` | 494,804 | 519,544 | — | `0x337cfa307344125125117cfb0508ceda370c0b2c6035eabb83b8f5e7020c333f` |
| (a) full 2 x 256: `verifyC1V1` `eth_call` | 12,034,849 | — | 106,628 B | `true` |
| (a) register pair | 56,938 | 59,784 | — | `0xea05ec5d6086d004ee956a15e22e85940e65610e5264d8d924db4a09f7b866a2` |
| **(a) full 2 x 256: `submit` tx (verify + root check)** | **12,195,486** | **12,805,260** | **106,692 B** | **`0x02d582dede07fd5646f64fbba959678401d792d7422dc38ba79cde5219189021`, status 1, `accepted` = true** |
| (b) padded 2 x 4 (to the 2 x 256 shape), new batch roots: `verifyC1V1` `eth_call` | 12,018,281 | — | 106,276 B | `true` |
| (b) register pair | 56,938 | 59,784 | — | `0x34baf6c8178525535cf14d99d55c1f05602587c67b6db5cae1729e68041ae15c` |
| (b) `submit` `eth_call` | 12,178,749 | — (not sent) | 106,340 B | succeeds (no revert) |
| (c) tampered 2 x 256 proof (bit flip at byte 60,000), `eth_call` | — | — | 106,628 B | reverts `MERKLE_ROOT` |

**At 512 signatures (full batch):** 12,805,260 gas charged / 512 = **~25.0k gas per signature**
(23.8k on the estimate), and 106,692 B / 512 = **~208 B of calldata per signature**, in one Monad
transaction that both verifies the terminal proof and checks the batch-root pair.

**Not done:** the padded batch's `submit` as a real tx. The wallet started at 3.354 MON and has 0.290 left;
one more submit costs ~1.31 MON. The same proof and calldata pass `eth_call` on the deployed contracts,
and the padded batch's pair is registered on chain.

The padded batch was re-proved with distinct batch roots (sha256 of `sigpress-left-batch-small` /
`sigpress-right-batch-small`), so the gate can hold both pairs: `runs/n4pad256b` (46.3 s wall, 5.53 GB
max RSS, run under the shared prover lock). Its generated verifier config is identical to the 2 x 256 one.
Earlier per-N verifiers on Monad: the 2 x 4 verifier `0x92a9…4e9b` (section "Result").

## What we built (and why)

Base: `Client-Side-Proving/leanVM` branch `recursive-verifier` @ `fb0909d` (Apache-2.0). Patch:
`patches/leanVM-recursive-verifier-fb0909d.patch`.

1. **`rec_aggregation::prepare_raw_single_message_execution`** (new, ~85 lines). The leanXMSS
   aggregation (`aggregate_single_message_signatures`) proves with `default_whir_config`, but the lift
   verifies children under an explicit `WhirExecutionProfile`. The new function does everything the
   aggregation does for a raw batch (sort/dedupe signers, tweak table, public-input preimage, hints)
   except the final proof, and returns `(public_input, witness, signers, preimage)`. We then prove the
   same aggregation bytecode with `prove_execution_with_profile(&profiles.direct)`. That was the whole
   "profile mismatch" gap: plumbing, no protocol change.
2. **`sigpress-xmss-terminal`** binary (modified copy of `leanvm-recursion-profile.rs`, Apache-2.0,
   modification notice at the top). The two Spartan-WHIR client fixtures (which would need the
   unlicensed `ethereum/spartan-whir`) are replaced by two leanXMSS batches generated in-process:
   deterministic keys (`xmss_key_gen_from_seed`, active for slot 7 only), each batch signs its own
   32-byte batch root, each signature checked with `xmss_verify` before proving. Everything after the
   direct proofs (lift, terminal C1 root with Keccak240, fixed-program commitment, `root-fixture.json`
   export, negative checks) is the authors' code, unchanged.
3. **Profile** `profiles/sigpress_c1.json`: the authors' `terminal_c1.json` (100-bit WHIR components,
   direct/lift/root grinding 22/24/28) minus the two pinned child dimensions (29 / 23, sized for their
   Spartan guest); the runner fills in the actual ones.
4. **Solidity generation** with `ethereum/sol-whir-p3@b82359e`'s
   `script/generate_leanvm_two_commitment_terminal_fixture.py` (its C1 path already uses tag
   `0x57500002`, matching the prover). Two blockers, both worked around:
   - it imports an unpublished module `terminal_hashes` from the authors' research workspace. We wrote
     our own `tools/terminal_hashes.py` (pure-Python Keccak-256, checked against `cast keccak`, and the
     inverse of leanVM's `encode_keccak240`);
   - it requires provenance written by `run_terminal_fixture.py`. `patches/sol-whir-p3-b82359e.patch`
     adds `SIGPRESS_NO_PROVENANCE=1` to skip that check.
   The generated test suite passes (16/16: accept + 15 rejection cases).
   **Licence note:** sol-whir-p3 has no LICENSE file; we rely on its `SPDX-License-Identifier: MIT`
   headers for this research use. Nothing from it is copied into the product.
5. **`gate/src/SigpressTerminalGate.sol`** (ours, MIT): `register(left, right, applicationRoot)` by a
   registrar, `submit(proof, left, right)` checks `keccak(proof.applicationRoot)` equals the registered
   value and that the verifier accepts. `tools/app_root.py` recomputes the application root off chain
   from the two child public inputs (Poseidon1, via leanVM's Apache-2.0 Python reference) and checks it
   equals the proof's root: **match** for our run.

## What the proof binds, and what it does not yet

Bound by the proof (checked on chain by the verifier): the root program verified two lifts of two
executions of the **fixed leanXMSS aggregation bytecode**, and its public memory is
`applicationRoot = Poseidon1("NOD1", 2, leftDigest, rightDigest)`. Each digest is the aggregation's public
input: `poseidon_hash_slice(n_sigs, hash(pubkeys), hash_message(batch_root), slot, tweaks hash,
bytecode claim, domain sep)`. So the root commits to both signer sets, both batch roots and the slot.

Not bound on chain yet:
- **Batch root -> applicationRoot.** The gate trusts the registrar's mapping. An honest observer can
  recompute it (our `app_root.py` does the last step; the child digests come from the Rust prepare
  function), but the contract does not. Options: compute Poseidon1 over KoalaBear in Solidity
  (sol-whir-p3 has `LeanVmPoseidon1.sol`; gas unmeasured), or change the root program to expose a
  Keccak digest.
- **Signer set.** The contract never sees the pubkeys; they are inside the digest. Account <-> pubkey
  binding needs the same recomputation.
- **Statement shape.** Single-message aggregation: every signer in a batch signs the *same* 32-byte
  message. Per-user messages (userOps) need multi-message aggregation (`merge_single_message_aggregates`)
  or a different guest. Exactly two children per terminal.
- **Scheme.** This is the KoalaBear/Poseidon leanXMSS (`crates/xmss` on this branch), not the
  Keccak leanXMSS on leanVM `main` (K5) and not our Solidity `WOTS.sol`.
- **Security.** Profiles are the authors' 100-bit WHIR component targets; their README says a
  complete-chain security claim needs a composition analysis. Signing keys are deterministic test seeds.

## Commands

```sh
# prover (from vendor/, after cloning Client-Side-Proving/leanVM@fb0909d as leanVM and applying the patch)
cd vendor/leanVM && git apply ../../patches/leanVM-recursive-verifier-fb0909d.patch
cargo build --release -p spartan_whir_guest --bin sigpress-xmss-terminal     # pinned nightly-2026-03-04
LEANVM_PROVING_TIMEOUT_SECONDS=0 LEANVM_TERMINAL_EXPORT=../../runs/n4/native /usr/bin/time -l \
  ./target/release/sigpress-xmss-terminal 4 ../../runs/n4/report.json ../../profiles/sigpress_c1.json
# Solidity (vendor/sol-whir-p3 = ethereum/sol-whir-p3@b82359e + patch, lib/ = forge-std + solady)
cd ../sol-whir-p3 && git apply ../../patches/sol-whir-p3-b82359e.patch
SIGPRESS_NO_PROVENANCE=1 PYTHONPATH=../../tools python3 script/generate_leanvm_two_commitment_terminal_fixture.py \
  ../../runs/n4/native/root-fixture.json SigpressXmssC1N4
forge build --offline src/leanvm/generated/LeanVmTwoCommitmentTerminal_SigpressXmssC1N4.sol \
  test/LeanVmTwoCommitmentTerminal_SigpressXmssC1N4.t.sol
forge test --offline --isolate --threads 1 --match-contract LeanVmTwoCommitmentTerminal_SigpressXmssC1N4Test
# chain (gate: cd ../../gate && forge build)
python3 -I tools/app_root.py runs/n4
RPC=http://127.0.0.1:8551 PK=<anvil key> tools/gate_flow.sh runs/n4 SigpressXmssC1N4
# one verifier for many N: pad the child to the 2x256 shape, then eth_call the 2x256 verifier
# SIGPRESS_MIN_LOG_ROWS=18,13,16 ./target/release/sigpress-xmss-terminal 4 ...
RPC=https://testnet-rpc.monad.xyz PK=$PRIVATE_KEY_K4 SKIP_VERIFY_TX=1 tools/gate_flow.sh runs/n4 SigpressXmssC1N4
```

## Next steps

1. Done: one 2 x 256 verifier on Monad, a full batch submitted, a padded batch checked by `eth_call`
   (above). Binding work (items 2-3) moved to `binding/`, owned separately.
2. Bind batch root -> applicationRoot on chain (Poseidon1 in Solidity, or a Keccak digest exposed by the
   root program), then drop the registrar.
3. Per-user messages: multi-message aggregation as the child, or a guest that verifies (pubkey, userOpHash)
   pairs and outputs their Keccak root.
4. Find the per-leaf cap (K5 saw one binary-field leaf top out between 2,048 and 4,096 signatures; this
   KoalaBear branch is unmeasured beyond 256 per child).

## Earlier search (how we found the prover)

The prover is the `recursive-verifier` branch of
[Client-Side-Proving/leanVM](https://github.com/Client-Side-Proving/leanVM/tree/recursive-verifier)
(`fb0909d`, Alex Kuzmin, 15 Oct 2026, Apache-2.0). GitHub code search misses it (default branches only);
found via `gh search commits --author alxkzmn` -> `ethereum/spartan-whir` PR #5 -> the
`Client-Side-Proving` org. The verifier we deployed in K4 (sol-spartan-whir `18eda72`) uses profile tag
`0x57500001`; the prover now uses `0x57500002` (WHIR continuation-claim correction), so it cannot accept
new proofs: we generate a fresh verifier per chain instead, as above. Also run here: the authors'
`smoke-control` chain (`results/smoke-control.json`) and the Keccak240 profile test
(`results/terminal-hash-profiles.txt`).

## Licences

| Repo | Licence | Use here |
|---|---|---|
| Client-Side-Proving/leanVM `recursive-verifier` | Apache-2.0 (LICENSE file) | base of our patch; reusable |
| ethereum/sol-whir-p3 | no LICENSE file; sources `SPDX-License-Identifier: MIT` | generator + Solidity verifier, research only |
| ethereum/spartan-whir | no LICENSE file | not used |
| ours: `tools/`, `gate/` | MIT | |
