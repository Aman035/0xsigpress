# K5 (proof size and prove time per signature) and K6 (hash on both sides)

Research, throwaway. Date: 4 Nov 2026. Machine: **Apple M4 (base, 10 cores), 16 GB RAM**, macOS,
Rust nightly, other desktop apps running (about 8 GB of swap already in use system-wide).
Prover: [leanEthereum/leanMultisig](https://github.com/leanEthereum/leanMultisig) (now titled leanVM)
@ `4b67ca0`, same commit K3 used. Licence checked from files: `LICENSE-MIT` + `LICENSE-APACHE` (dual).
Clone lives in `vendor/` (git-ignored). Raw output in `results/`.

## Commands

```sh
git clone https://github.com/leanEthereum/leanMultisig.git vendor/leanMultisig
cd vendor/leanMultisig
cargo +nightly build --release -p leanvm-cli          # 36 s
for n in 256 1024; do
  /usr/bin/time -l ./target/release/leanvm aggregate --xmss $n --log-inv-rate 1 --repeat 3
done
/usr/bin/time -l ./target/release/leanvm aggregate --xmss 2048 --log-inv-rate 1 --repeat 1
/usr/bin/time -l ./target/release/leanvm aggregate --xmss 4096 --log-inv-rate 1 --repeat 1
/usr/bin/time -l ./target/release/leanvm recursion --n 4 --xmss-per-leaf 1024 --log-inv-rate 1
/usr/bin/time -l ./target/release/leanvm recursion --n 4 --xmss-per-leaf 1024 --log-inv-rate 2
```

Each `aggregate` run does one discarded warm-up pass, then the measured passes, then verifies. The
benchmark signs one shared 32-byte message with N distinct cached keys.

For exact byte counts and K6 work counts, `results/k6-count.patch` adds counters (sigpress-only, not
upstream) to `primitives` and to the portable `verifier` crate, built into a separate
`target-count/` and run with `K6_COUNT=1`. Timings are **not** taken from the instrumented build.

## Results (K5)

| Config | Proof (B, exact) | B/sig | Prove time | Peak mem (`time -l` max RSS / footprint) | Verify (Rust) |
|---|---|---|---|---|---|
| 256 sigs, 1 leaf, rate 1/2 | 306,992 | 1,199 | **0.554 s** (0.535 / 0.562 / 0.563) | 1.81 GB / 1.81 GB | 8.1 ms |
| **1,024 sigs, 1 leaf, rate 1/2** | **334,104** | **326** | **2.289 s ± 15%** (2.442 / 2.127 / 2.297) | 6.26 GB / 6.31 GB | 9.5 ms |
| 2,048 sigs, 1 leaf, rate 1/2 | 357,408 | 175 | 28.4 s (1 pass, **memory-bound**: footprint 12.8 GB on a 16 GB box) | 5.92 GB / 12.80 GB | 45.9 ms |
| 4,096 sigs, 1 leaf | — | — | **fails**: `WitnessOutOfRange { log_committed: 29 }` (one leaf caps out between 2,048 and 4,096) | 5.03 GB / 8.50 GB | — |
| 4,096 sigs = 4 leaves × 1,024 + 4→1 recursion, rate 1/2 | ≈350,800 (342.6 KiB) | ≈86 | recursion step 0.942 s; whole run incl. building 4 leaves 14.5 s wall | 6.22 GB / 3.87 GB | 10.8 ms |
| 4,096 sigs = 4 × 1,024 + 4→1 recursion, rate 1/4 | ≈251,400 (245.5 KiB) | ≈61 | recursion step 0.778 s; whole run 21.9 s wall | — / 3.04 GB | 10.5 ms |

"Proof" is the VM proof alone (`EthereumProof::proof_size`). On the wire the aggregate also carries the
signer set: `to_bytes_without_pubkeys` adds 561 B; `to_bytes` with the (pubkey 32 B, message 32 B)
claims is 400,217 B at N = 1,024 (390.8 B/sig). If pubkeys are known on chain and messages are the
userOp hashes the contract computes anyway, only the proof is extra calldata.

Raw excerpt, N = 1,024:
```
aggregation, 1,024 leanXMSS signatures
  cycles (VM steps)           : 1,146,158 = 2^20.128
  proof size                  : 326.3 KiB
  proving time                : 2.289 s ± 15.3%      peak memory 5.826 GiB
  per signature               : 447.448 signatures/s
  verifying                   : 9.461 ms
       38.46 real       245.83 user         5.63 sys
          6255968256  maximum resident set size
```

**Vs self-reported** (README, M4 Max 12P+4E cores, 48 GB): 1,400 sigs, 359.5 KiB (263 B/sig), 1.15 s,
8.6 GiB, 1,217 sigs/s. Ours: 447 sigs/s at N = 1,024, about **2.7× slower per signature** on a base M4
with 16 GB. Proof sizes match the curve (326.3 KiB at 1,024, 349.0 KiB at 2,048 bracket their 359.5 KiB
at 1,400). K3's earlier single-pass run at 1,024 measured 3.3 s; ours is the mean of 3 warm passes.

**What scales:** proof size grows slowly (≈ +27 KiB per doubling), so B/sig roughly halves per
doubling. Prove time is linear in N until RAM runs out; above ~1,024-2,048 per leaf on 16 GB you need
recursion over leaves (which also parallelises across machines).

## K6: which hash where

| Place | Hash / field (current leanVM, binary-field) | Source |
|---|---|---|
| Signature scheme inside the proof (leanXMSS, W=2, 2 layers × 16, 32-B pubkeys, 2,404-B sigs) | Tweakable hash `Th = Truncate_16(Keccak-256(P‖A‖M))`; proved via the VM `KECCAK` opcode + Keccak GKR (KECCAK is 16.7 % of cycles at N=1,024) | `crates/signatures/src/tweak.rs`, `lean_xmss/mod.rs` |
| Merkle trees of the PCS (WHIR) | Keccak-256 (Ethereum padding `0x01…0x80`), leaves = Keccak-256 of row bytes, nodes = Keccak-256(left‖right) | `crates/pcs/src/merkle.rs`, `crates/verifier/src/merkle.rs` |
| Fiat-Shamir transcript | **Duplex sponge over the raw Keccak-f[1600] permutation** (overwrite mode, capacity carried) — not Keccak-256 | `crates/fiat_shamir/src/lib.rs`, `crates/verifier/src/transcript.rs` |
| Field | 192-bit binary tower: GF(2^64) and a degree-3 extension; multiplication is carry-less | `crates/verifier/src/field.rs` |

No Poseidon anywhere in the current version (Poseidon + KoalaBear is the old `koalabear` branch).

Measured verifier work, one verification (portable single-threaded `verifier` crate, counters):

| Config | Keccak-f total | of which raw duplex (transcript) | Keccak-256 calls (bytes) | GF(2^192)×GF(2^192) | GF(2^192)×GF(2^64) | GF(2^64)×GF(2^64) | table mults |
|---|---|---|---|---|---|---|---|
| 256, leaf | 6,570 | 862 | 4,778 (447,104 B) | 105,275 | 19,996 | 12,210 | 37,888 |
| 1,024, leaf | 7,396 | 937 | 5,524 (495,616 B) | 107,402 | 20,790 | 13,875 | 37,888 |
| 2,048, leaf | 7,995 | 972 | 6,060 (534,400 B) | 108,717 | 21,172 | 14,776 | 37,888 |
| 4→1 recursion, rate 1/4 | 4,777 | 851 | 3,368 (300,928 B) | 102,518 | 10,474 | 7,502 | 37,888 |

What an EVM verifier for this proof would have to compute:
- The Merkle part is EVM-native: ~3-6k `KECCAK256` calls over ~0.3-0.5 MB. Rough (not measured)
  cost: well under 1M gas.
- The transcript is **not**: the EVM exposes only padded Keccak-256, not the raw permutation, so ~850-970
  Keccak-f[1600] permutations would have to be implemented in Solidity (cost not measured here), or the
  prover's transcript changed to a Keccak-256 hash chain like the one K3's Solidity verifier uses
  (`src/transcript/KeccakChallenger.sol`, built on `keccak256`).
- The field is the real blocker: **~100k GF(2^192) multiplications** (each 6 carry-less 64×64 products
  in Karatsuba), with no carry-less multiply opcode or precompile in the EVM. Even at an optimistic
  1,000 gas each (estimate, not measured) that is >100M gas, over Monad's 30M tx cap.

So a direct Solidity verifier for today's binary-field leanVM proof is not viable. The EVM-friendly
configuration is K3/K4's: a KoalaBear (31-bit field) + Keccak-256-only terminal proof verified by
sol-spartan-whir (measured on Monad testnet in K4: 12.84M gas estimate, 106,628 B calldata). That
terminal exists only for the KoalaBear-era leanVM, and its prover is not public (see K3).

## Pass / fail

| Test | Bar (plan.md) | Measured | Result |
|---|---|---|---|
| K5 bytes/sig at N ≥ 1,024 | ≤ 400 | 326 B/sig at 1,024 (proof only); 391 with signer set; 175 at 2,048; ≈61-86 at 4,096 via recursion | **PASS** |
| K5 prove time, 1,024 sigs, one strong machine | ≤ 3 s | 2.29 s mean on a base M4 16 GB (passes 2.13-2.44 s) | **PASS (narrow)** |
| K6 EVM verifier only needs Keccak/precompile | Keccak or precompile only | Hash side yes (Keccak everywhere, no Poseidon), but the transcript uses raw Keccak-f and the field needs ~100k binary-field ext mults: **not** EVM-verifiable directly | **FAIL for the direct path; PASS only via the KoalaBear+Keccak terminal wrap (K3/K4), whose prover is not available** |

**Caveat that matters most:** the K5 numbers are for the leanVM proof, which the EVM cannot verify.
What lands on chain would be the terminal proof (K4: 106,628 B, constant in N), i.e. ≈104 B/sig at
1,024 and ≈26 B/sig at 4,096, *plus* the extra prove time of the wrap step — neither the wrap nor its
time is measured. K5's bar is met by either proof, so the size story holds; the open risk stays prover
availability for the terminal, as K3/K4 concluded.
