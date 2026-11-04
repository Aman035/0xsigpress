# K10 binding: proof <-> (signers, per-signer messages) checked on chain, no registrar

Research, throwaway. Date: 4 Nov 2026. Machine: Apple M4, 16 GB (shared; every prover run and prover
build wrapped in `/private/tmp/claude-501/sigpress-prover.lock`).

## Result

`SigpressValidityGate.submit(proof, slot, left, right)` in **one tx** recomputes the proof's application
root on chain (Poseidon1 over KoalaBear) from calldata it receives: the slot, each batch's signer public
keys and **each signer's own 32-byte message**; requires it to equal `proof.applicationRoot`; runs the
generated terminal verifier; refuses replays; records and emits `keccak256(abi.encode(slot, left.pubkeys,
left.messages, right.pubkeys, right.messages))`. There is no registrar and no off-chain mapping.

| Monad testnet (chain 10143), wallet `0x082C…1668` | Value | Tx |
|---|---|---|
| `Poseidon1Hasher` deployed | `0xb42CFc7fC5cdA85242dd3423F55DEc8b25Ce8dB2`; estimate 6,267,563; code 28,737 B (on chain, checked) | not captured (script parse error after send; ~0.68 MON by balance delta) |
| Verifier `LeanVmTwoCommitmentTerminal_SigpressBindC1N4` | `0x79ef057bf1a0aa01a5c8935804f955d68fe3c7e4`; estimate 13,572,655, charged 14,251,287 | `0x97d287a1edf07018095f4abd546c4de346c601e18ead35dc5be26ea2e4daf7a0` |
| `SigpressValidityGate` | `0xd4ce9f047db1a26e9a667ce052edde0c6d5aa299`; estimate 1,971,908 | `0xe4ae9ea016d6ef7a18d992dc2064664df16e8f541a7db0a8d2a5524921f9ecf8` |
| eth_call: batches swapped / one message changed / one pubkey bit flipped / slot + 1 | revert `RootMismatch()` (`0x5ade0455`) each | RPC |
| eth_call: proof byte 60,000 flipped | revert `MERKLE_ROOT` | RPC |
| **`submit`, test-key batches (2 x 4, 8 distinct messages), first use of n = 4** | **status 1; estimate 15,038,841, charged 15,790,783**; calldata 107,524 B | `0x8aff146771641e090e1d0505e7aafe36f531ec9e4bac7b9866ce78b9880d581f` |
| eth_call: same submit again | revert `AlreadyAccepted()` (`0x1aa8064c`) | RPC |
| `accepted(0xcf2b36d9…2771)` | `true` | RPC |
| **`submit`, K11 SDK-signed batches (CLI keys, 2 x 4), n = 4 cached** | **status 1; estimate 14,067,352, charged 14,770,719** | `0xc0365db309776efec97112ef0fda1d6bb29bed6cacea7ceb04ca88b5bc719495` |

Raw lines: `results/monad-n4.jsonl`, `results/anvil-n4.jsonl`. Gas price 102 gwei. Faucet: 3 agent-faucet
calls (+3 MON) on top of the 3.5 MON.

Anvil (Prague) for the same proof: verifier alone 12,103,751; `submit` 15,016,389 (cold n-cache) and
14,028,909 (warm, SDK proof). So **binding costs ~2.9M gas cold / ~1.9M warm at 2 x 4**, on top of the
~12.1M verifier.

### Binding gas vs batch size (forge, warm cache, synthetic signers, `test/BindingScaling.t.sol`)

| signers per batch (x 2 batches) | 1 | 4 | 16 | 64 | 128 |
|---|---|---|---|---|---|
| binding gas | 912,335 | 1,864,489 | 5,675,484 | 20,956,893 | 41,427,185 |

**~160k gas per signer** (3 Poseidon1 permutations each: pubkey sponge, `hash_message`, message sponge,
at ~50k gas per permutation including the call) + ~0.6M fixed. With the ~12.2M verifier and Monad's 30M
tx cap that is **at most ~105 signers per tx (~52 per batch)** (arithmetic from these runs, not a measured
tx). One-off per batch size n: `prepareShape(n)` 940,538 gas (17 permutations + 2 SSTORE), done lazily by
the first `submit`. The verifier share stays flat (~12.1M for 8 or 512 sigs, K10), so at scale the binding,
not the proof, dominates: this path does not scale past ~100 signers per tx. See "What remains".

## Prover (this machine, single runs)

| run | direct L / R | lift L / R | root | all proving | wall | max RSS / footprint |
|---|---|---|---|---|---|---|
| test keys, 8 distinct messages (`runs/n4`) | 0.77 / 0.58 s | 27.7 / 18.5 s | 68.6 s | 116.1 s | 1,422 s* | 5.56 GB / 15.9 GB |
| K11 SDK batches (`runs/sdk-n4`) | 0.40 / 0.50 s | 10.0 / 9.2 s | 43.7 s | 63.7 s | 71.4 s | 5.39 GB / 14.3 GB |

\* the machine was swapping (another prover had just finished, browsers open); the SDK run is the fairer
number. Both: all five proofs natively verified, the authors' four negative checks rejected. Terminal
proof 111,063 B. The two runs produce the **same** fixed programs (generated verifiers identical), so one
deployed verifier accepted both.

## What changed (patch: `patches/leanVM-binding-on-k10.patch`, on top of K10's leanVM patch)

1. **Aggregation guest (`zkdsl_implem/main.py`), raw-only per-signer mode.** `assert n_recursions == 0`,
   `assert n_dup == 0`; a hint `messages` (one 8-FE `hash_message(m_i)` per signer, aligned with the signer
   list) is hashed with `slice_hash_runtime` into the public input's message slot, and signature i is
   checked against `messages[i]` instead of one shared message. This is the "simplest honest version" of
   per-signer messages: one proof covers N independent (pk_i, m_i) statements. leanVM's own
   multi-message path (`MULTI_MESSAGE_FLAG`) merges up to `MAX_RECURSIONS` = 16 single-message
   aggregates, each needing its own proof; not used.
2. **Tweak table computed in-guest from the slot** (`sigpress_build_tweak_table`): slot bits come from the
   public Merkle chunks (4-bit decompositions, booleanity-checked), the 370 tweaks are built from them,
   and the public-input slot that held their hash is pinned to zeros. Without this the contract would hash
   a 1,480-element table per slot (185 permutations; estimate, not measured: ~9M gas at ~50k per permutation).
3. `rec_aggregation::prepare_raw_per_signer_execution` (Rust witness builder for the above).
4. Binary `sigpress-binding-terminal` (copy of K10's runner): each test signer signs
   `sha256("sigpress-op|side|i")`; or, with `SIGPRESS_BATCH_LEFT/RIGHT`, reads **K11 SDK batch files**
   (`sigpress-leanxmss-batch-v1`), with an optional per-signer `"message"` field in `signers[i]`
   (falls back to the batch `message`); every signature is re-verified natively. Exports per-signer
   pubkeys/messages and the public-input preimage in `report.json`.

On chain (ours, MIT): `src/Poseidon1Hasher.sol` is generated by `tools/gen_poseidon1.py` from sol-whir-p3's
`LeanVmPoseidonAirConstants.sol` (MIT SPDX header; same algorithm as its `LeanVmPoseidon1.sol`, which
measured 170,661 gas per permutation here; ours ~50-57k by packing the circulant MDS into 64-bit lanes
and the partial-round tail into 128-bit lanes, compiled without the optimizer). Checked against vectors
from leanVM's Apache-2.0 Python reference. `src/SigpressValidityGate.sol` does the binding.
`tools/statement.py` mirrors the contract's computation in Python and matched the prover's preimage,
public inputs and the proof's application root for both runs.

## What is bound now, and what is not

Bound on chain, from calldata, per tx: slot; every signer's public key (8 KoalaBear limbs, packed in a
`bytes32`, each < p); every signer's own 32-byte message; signer order and count; which batch is left /
right; and that the proof is for the fixed per-signer aggregation program (pinned by the verifier).
`K` (128 constant words: zero bytecode claim + Fiat-Shamir domain separator) is a deploy-time constant
like the verifier's pinned programs; a wrong K makes every proof fail, it cannot make a false statement pass.

Not bound / limits:
- **Account <-> pubkey.** The gate binds pubkeys, not Ethereum accounts. A registry (account -> pubkey)
  or 4337 account check is still needed.
- **Scale.** ~160k gas per signer of Poseidon in Solidity caps a tx at ~105 signers. Scaling needs the
  guest to expose a Keccak digest (no Keccak in the leanVM ISA; a zkDSL Keccak is a large job) or a
  cheaper commitment (e.g. per-signer data hashed once into a registry and referenced by index).
- **One slot per batch pair.** All signatures in both batches use the same XMSS slot (aggregation
  constraint); products need slot = epoch coordination.
- **No recursion/duplicates** in this mode (asserted). Exactly two batches per terminal.
- The K11 SDK's `export-batch` writes one shared message per batch; per-signer messages need it to
  write `signers[i].message` (format above). Not changed here (K11's folder).
- Security: the authors' 100-bit component targets; the in-guest tweak construction is ours and only
  tested by honest runs (a wrong table would make valid signatures fail; no adversarial test of the
  guest beyond the contract-level negatives).

## Commands

```sh
# prover tree (vendor/leanVM-binding = K10's patched leanVM + this patch)
cd vendor/leanVM-binding && git apply ../../binding/patches/leanVM-binding-on-k10.patch
cargo build --release -p spartan_whir_guest --bin sigpress-binding-terminal
LEANVM_PROVING_TIMEOUT_SECONDS=0 LEANVM_TERMINAL_EXPORT=../../binding/runs/n4/native \
  ./target/release/sigpress-binding-terminal 4 ../../binding/runs/n4/report.json ../../profiles/sigpress_c1.json
# SDK input: SIGPRESS_BATCH_LEFT=…/batch-left.json SIGPRESS_BATCH_RIGHT=…/batch-right.json (same command)
# verifier (vendor/sol-whir-p3-binding = copy of K10's patched sol-whir-p3)
SIGPRESS_NO_PROVENANCE=1 PYTHONPATH=../../tools python3 script/generate_leanvm_two_commitment_terminal_fixture.py \
  ../../binding/runs/n4/native/root-fixture.json SigpressBindC1N4 && forge build --offline src/leanvm/generated/…
# binding
cd binding && python3 -I tools/statement.py runs/n4 --export && forge test
RPC=… PK=… tools/flow.sh runs/n4 SigpressBindC1N4      # HASHER=0x… to reuse a deployed hasher
```
