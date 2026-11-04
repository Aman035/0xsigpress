# K10 binding v2: cheap on-chain binding of the proof to (signers, per-signer messages)

Research, throwaway. Date: 4 Nov 2026. Machine: Apple M4, 16 GB (shared; every prover run and heavy build
wrapped in `/private/tmp/claude-501/sigpress-prover.lock`, `tools/locked.sh`).

## Result

K10 binding v1 recomputed the proof's statement in Solidity with ~3 Poseidon1 permutations **per signer**
(~160k gas per signer, measured): at most ~105 signers per 30M-gas tx. v2 keeps the same trust model (no
registrar; the contract checks the proof against the raw pubkeys and messages in calldata) but needs only
**11 Poseidon permutations per tx, whatever the batch size**. The per-signer work is one keccak over the
calldata plus a few dozen multiplications.

| | v1 (`../binding`) | **v2 (this folder)** |
|---|---|---|
| binding gas per signer (forge, gate execution only, warm) | ~160,000 | **~3,200** (2 x 256: 2,250,948 total, 2 x 1 : 638,233) |
| marginal gas per signer on Monad (`eth_estimateGas`, incl. 64 B calldata) | — | **~4,000** ((22,084,417 - 15,918,285) / 1,536) |
| fixed binding cost per tx | ~0.6M | ~0.64M (11 permutations) + 0.94M once per batch size (`prepareShape`) |
| real Monad `submit` | 2 x 4: est. 15,038,841 | **2 x 256: est. 15,918,285 (charged 16,714,199); 2 x 1024: est. 22,084,417 (charged 23,188,637)** |
| signers per 30M tx | ~105 (arithmetic) | ~3,600-3,900 by gas (arithmetic from the two Monad estimates; not a measured tx). 2,048 measured |

The goal (2 x 256 with per-signer messages in one tx, <= ~25M) is met with room to spare: 512 signers cost
an estimated 15.9M in one Monad tx (charged 16.7M), and 2,048 signers an estimated 22.1M.

| Monad testnet (chain 10143), wallet `0x082C…1668`, gas price 102 gwei | Value | Tx |
|---|---|---|
| `Poseidon1Hasher` (reused from v1, runtime code checked equal to ours) | `0xb42CFc7fC5cdA85242dd3423F55DEc8b25Ce8dB2` | (v1) |
| Verifier `LeanVmTwoCommitmentTerminal_SigpressBindV2C1N256` | `0xa43f61c3936dc4d22b471594f99a33eadc7c4abb`; est. 13,572,655, charged 14,251,287 | `0x87cfb2cad7c54c1ecf3209083d29bfff7e48234a4e54e2fe6b4b957929bc4bf1` |
| `SigpressBindV2Gate` (2 x 256 verifier) | `0x38eeb174d437c038dd16ca91e682f24cdc71c697`; est. 2,176,548, charged 2,285,375 | `0x9a682e1182a9f55d7f955126a7a6d6a074e8c258bc881a47ac101a2b183065de` |
| **`submit`, 2 x 256 test-key signers, 512 distinct messages, first use of n = 256** | **status 1; est. 15,918,285, charged 16,714,199; calldata 140,036 B** | **`0xb585a8981311a12ce107858cdddda19c441a6161037ecdaf50fa558773e97628`** |
| after submit, eth_call: batches swapped / one message changed / one pubkey bit / slot + 1 | revert `RootMismatch()` (`0x5ade0455`) each | RPC (`results/monad-n256.jsonl`) |
| after submit, eth_call: same submit again; changed commitment D (same statement) | revert `AlreadyAccepted()` (`0x1aa8064c`) | RPC |
| eth_call: proof byte 60,000 flipped | revert `MERKLE_ROOT` | RPC |
| `accepted(0x956440c0…f4dd)` | `true` | RPC |
| Verifier `…SigpressBindV2C1N1024` | `0xc6304db43e642c0bc43b55f13a3ebe21f336794f`; est. 13,572,655 | `0x4335d5ed9166b5e1610ca5349e0a2a74816fa419c2af003938aa8bfdbd067034` |
| `SigpressBindV2Gate` (2 x 1024 verifier) | `0x5648caea56baa011b6685ce091089b561621a661`; est. 2,176,548 | `0x0eaa8caf4d8a9ed9500e7c6a17e60a9742610766c18f31cde0feb171fe8c8cf9` |
| before submit, eth_call: swapped / message / pubkey / slot / commitment D changed | revert `RootMismatch()` each | RPC (`results/monad-n1024.jsonl`) |
| **`submit`, 2 x 1024 (2,048 signers, 2,048 messages)** | **status 1; est. 22,084,417, charged 23,188,637; calldata 237,956 B; replay -> `AlreadyAccepted`; `accepted(0x9dc40202…4978)` = true** | **`0x97e2a519475fbe284637707e0682f5e8e882bf2dfb2f96f4099766e7472a2ec1`** |

Faucet: 7 agent-faucet calls (+7 MON) on top of the 0.945 MON left by earlier work; 0.363 MON left. The first flow attempt
hit the public RPC's HTTP 429 rate limit before sending anything; `tools/flow.sh` now retries estimates
and spaces calls (`STEP_SLEEP`). Monad's RPC returns revert data only in the raw JSON-RPC error, so
`tools/raw_calls.sh` captures the selectors.

Anvil (Prague) for the same proofs (`results/anvil-*.jsonl`): `submit` gas used 13,830,725 (2 x 4),
15,890,567 (2 x 256), 22,213,641 (2 x 1024), all with a cold per-n cache; verifier deploy 13,476,927; the
same negative checks.

### Binding gas vs batch size (forge, `test/BindingScaling.t.sol`, calldata pre-encoded, warm per-n cache)

| signers per batch (x 2) | 1 | 4 | 16 | 64 | 128 | 256 | 512 | 1024 |
|---|---|---|---|---|---|---|---|---|
| v2 binding gas | 638,233 | 656,495 | 729,669 | 1,024,385 | 1,425,191 | 2,250,948 | 3,998,742 | 7,878,902 |
| v1 binding gas (`../binding`) | 912,335 | 1,864,489 | 5,675,484 | 20,956,893 | 41,427,185 | — | — | — |

Plus the replay commitment (`keccak256(abi.encode(slot, pubkeys, messages))`, same as v1): 21,815 gas at
2 x 256. v1's numbers include the test's own ABI encoding (its method); v2's do not, so compare the slopes
(~160k vs ~3.2k per signer), not the small-N intercepts.

## Prover (this machine, single runs, test keys, each signer its own message)

| run | direct L / R | lift L / R | root | all proving | wall | max RSS / footprint | child exec rows (K10 single-message) |
|---|---|---|---|---|---|---|---|
| 2 x 4 (`runs/n4`) | 0.89 / 0.88 s | 9.4 / 9.4 s | 30.4 s | 51.0 s | 58.0 s | 5.54 / 13.7 GB | 7,126 (v1: 6,744) |
| 2 x 64 (`runs/n64`) | 0.94 / 0.78 s | 9.9 / 9.0 s | 21.1 s | 41.7 s | 50.0 s | 5.57 / 13.9 GB | 50,119 (41,891) |
| 2 x 256 (`runs/n256`) | 2.54 / 1.77 s | 16.6 / 11.6 s | 21.5 s | 53.9 s | 63.7 s | 7.52 / 14.4 GB | 188,018 (164,842) |
| 2 x 1024 (`runs/n1024`) | 4.92 / 4.73 s | 9.2 / 8.5 s | 44.3 s | 71.6 s | 89.8 s | 5.72 / 14.2 GB | 739,306 (—) |

All five proofs natively verified and the authors' four negative checks rejected in every run; terminal
proof 110.7-111.6 KB. The guest change costs ~+14% child rows at 2 x 256 (in-guest `hash_message`, one extra
compression, the F_p^5 Horner); lift and root are unchanged in size, so total time is about the same as K10.
2 x 1024 is the largest run here and fit in memory; larger was not tried.

## How it works

The idea: don't make the contract recompute the prover's Poseidon hash. Instead, the prover commits to the
signer data with Poseidon (cheap inside leanVM), the contract derives a random challenge from keccak (cheap
on the EVM) over the raw calldata and that commitment, and both sides evaluate one polynomial at that
point. Equal values mean equal data, except with probability ~2^-141.

Per batch of n signers (pk_i 8 KoalaBear limbs, m_i 32 bytes):

- **Prover commitment** `D = compress(hash_slice(pk_0..pk_n-1), hash_slice(hash_message(m_0)..))`, sent in
  calldata (`Batch.commitment`).
- **Challenge** `h = keccak256(keccak256("sigpress-bind-v2") | u256 slot | u256 n | D | pk_0..pk_n-1 | m_0..m_n-1)`,
  `r = (r_0..r_4)`, `r_k = ((h >> 48k) mod 2^48) mod p`, an element of F_p^5 = F_p[X]/(X^5 + X^2 - 1) (leanVM's
  extension field).
- **Evaluation** `v = Horner over i with rho = r^17 of s_i(r)`, `s_i(r) = sum_k pk_i[k] r^k + sum_k limb_k(m_i) r^(8+k)`,
  limb = base-p digits of m_i read little-endian (exactly `xmss::encode_message`).
- **Guest (patched aggregation program)**: receives the 9 message limbs per signer as a hint, computes
  `hash_message` itself (one Poseidon compression; v1 hinted it), verifies each signature against its own
  message, computes D, and evaluates v at the r in its public input using the extension-field precompiles
  (`dot_product_be`, `dot_product_ee`, `add_ee`). Public-input layout (same size as K10's):
  `[1, n, 0*6] | K | D | v,0,0,0 | merkle_chunks(slot) | r,0,0,0`.
- **Gate** (`src/SigpressBindV2Gate.sol`): computes r and v from calldata (the Horner loop is Yul, power
  table packed in 72-bit lanes), rebuilds the two child public inputs (4 permutations each, with a cached
  per-n midstate) and the root (3), requires root == `proof.applicationRoot`, calls the verifier, rejects
  replays. Pubkey limbs and D limbs must be < p.

Why it is sound (argument, not a proof; not reviewed by anyone else): the proof shows the prover verified
signatures for some data S' with `D = Poseidon(S')` and `v = P_{S'}(r)`. The gate computes `P_S(r)` for the
calldata data S with `r = keccak(S, D)`. D is fixed before r (it is a keccak input), and Poseidon is
collision resistant, so S' is fixed before r. If S != S', `P_S - P_S'` is a non-zero polynomial of degree
< 17n over F_p^5, so it vanishes at r with probability <= 17n / p^5 (~2^-141 at n = 2^14, r's limbs are
reduced 48-bit values, bias negligible); each new try costs a keccak and a new proof. Without D in the
keccak input the check would be broken (the prover could pick S' after seeing r and solve one linear
equation in its own message limbs), so D is essential.

`tools/statement.py` is an independent Python mirror (its own F_p^5 arithmetic and keccak): it matched the
prover's D, r, v, public-input preimage, child digests and the proof's application root for all four runs.

## Candidates measured before choosing

| candidate | what was measured | result | verdict |
|---|---|---|---|
| (a) Keccak inside the guest | leanVM execution cycles of one Keccak-f[1600], bit per field element (`keccak-bench/`, `results/keccak-f1600-cycles.txt`) | **664,235 cycles** per permutation (no input bit-decomposition, so a lower bound for a naive version). 64 B per signer = 0.47 permutations = ~312k cycles per signer vs ~730 per signer today | **not built**. Estimate (not measured): a 2 x 256 child would need ~80M rows (2^26+) vs 188k, beyond this 16 GB machine; 2 x 4 ~1.3M rows (like today's 2 x 1024 child), 2 x 64 ~20M rows. A lookup-based Keccak might be 4-10x cheaper (estimate), still ~100x today's child |
| (b) Poseidon-only, max-rate sponge over raw data (17 FE/signer, rate 8) | forge, `test/AlternativesGas.t.sol`, 2 x 256 | **62,143,191 gas = ~121k/signer** | too expensive (one permutation is 50,517 gas; >= 2.1 per signer) |
| (c) on-chain signer registry (pubkeys once; per batch 9 message limbs + packed index) | same test, 2 x 256 | **35,894,627 gas = ~70k/signer** (registration extra) | too expensive: the messages alone need >= 1.1 permutations each |
| **(d) keccak challenge + polynomial identity (this)** | forge + Monad | **~3.2k/signer (forge), ~4.0k/signer marginal on Monad** | **chosen**: small guest change, no new hash in the guest, measured end to end |

## What is bound, and what is not

Bound on chain from calldata, per tx (as v1): slot; every signer's pubkey; every signer's own 32-byte
message; order and count; left/right; the fixed aggregation program (pinned by the verifier).

Not bound / limits:
- **Account <-> pubkey** (as v1): the gate binds pubkeys, not Ethereum accounts.
- **New soundness argument.** The Schwartz-Zippel + Fiat-Shamir step above is ours, standard in shape but
  not reviewed. The guest's extension-field Horner is tested by honest runs and by the contract negatives
  (wrong pubkey / message / order / slot / commitment), not by an adversarial prover.
- **One verifier per shape.** Each batch size gets its own lift/root programs and verifier (2 x 256 and
  2 x 1024 here). K10 showed padding small batches to a fixed shape with `SIGPRESS_MIN_LOG_ROWS`; not
  re-done for v2 (the extension table is one size larger at 2 x 256: 2^14 vs 2^13).
- **Calldata**: 64 B per signer plus the 107 KB proof; 2 x 1024 was 237,956 B. Monad's max tx size
  (~384 KiB) is still unverified; it, not gas, may cap N first (~4,400 signers by size, arithmetic).
- One slot per terminal, raw signatures only, exactly two batches (as v1). K11's `export-batch` still
  writes one shared message (the runner reads per-signer `signers[i].message` if present; not re-run for v2).

## Files

- `patches/leanVM-bindv2-on-binding.patch`: on top of K10's leanVM patch and `../binding/patches/leanVM-binding-on-k10.patch`
  (guest `main.py`, `prepare_raw_per_signer_execution`, `sigpress_bind_v2_challenge/eval`, runner
  `sigpress-bindv2-terminal`, `xmss::encode_message` made public, `sha3` dep, the Keccak cycle-count test).
- `src/SigpressBindV2Gate.sol` (ours, MIT); `src/Poseidon1Hasher.sol` (copy of v1's generated hasher).
- `test/`: real-proof gate tests (18: accept, replay, tampered transcript / openings / root, wrong / dropped
  / swapped signer, wrong / swapped message, swapped batches, wrong slot, wrong commitment, non-canonical
  pubkey / commitment, length mismatch), scaling, alternatives.
- `tools/`: `prove.sh`, `locked.sh`, `statement.py`, `submit_calldata.py`, `flow.sh`, `raw_calls.sh`, `summary.py`.
- `runs/n*/` (reports, logs, statement.json), `results/` (generated-verifier calldata + manifests, chain logs).

## Commands

```sh
# prover tree: vendor/leanVM-binding-v2 = vendor/leanVM-binding (K10 patch + v1 patch) + this patch
cd ../vendor/leanVM-binding-v2 && git apply ../../binding-v2/patches/leanVM-bindv2-on-binding.patch
cd ../../binding-v2 && tools/prove.sh 256 n256          # builds + proves 2 x 256 under the lock
python3 -I tools/statement.py runs/n256 --export        # cross-check + gate inputs
# verifier (vendor/sol-whir-p3-binding-v2 = copy of K10's patched sol-whir-p3)
cd ../vendor/sol-whir-p3-binding-v2 && SIGPRESS_NO_PROVENANCE=1 PYTHONPATH=../../tools python3 \
  script/generate_leanvm_two_commitment_terminal_fixture.py ../../binding-v2/runs/n256/native/root-fixture.json SigpressBindV2C1N256
forge build --offline src/leanvm/generated/LeanVmTwoCommitmentTerminal_SigpressBindV2C1N256.sol
cp testdata/leanvm_terminal/SigpressBindV2C1N256/{calldata.bin,manifest.json} ../../binding-v2/results/SigpressBindV2C1N256/
# gate
cd ../../binding-v2 && forge test                         # default run: runs/n4
BIND_RUN=runs/n256 BIND_LABEL=SigpressBindV2C1N256 BIND_VERIFIER=SigpressBindV2C1N256 forge test --match-contract SigpressBindV2GateTest
RPC=… PK=… HASHER=0xb42C… STEP_SLEEP=4 tools/flow.sh runs/n256 SigpressBindV2C1N256 [VERIFIER]   # SKIP_SUBMIT=1, GATE=0x… supported
# candidate (a): SIGPRESS_ZKDSL=…/keccak-bench/keccak_f1600.py cargo test --release -p lean_compiler --test sigpress_keccak_cycles -- --nocapture
```
