# K11: a leanXMSS signer the K10 STARK chain accepts

Research, throwaway. Date: 4 Nov 2026. Machine: Apple M4 (10 cores), 16 GB, shared with other jobs
(load average 7-21 during these runs), so every time below is a single noisy run.

## Problem

The K10 chain (leanVM `recursive-verifier` @ `fb0909d`, Apache-2.0, vendored at
`experiments/k10-terminal/vendor/leanVM`) aggregates **leanXMSS over KoalaBear/Poseidon1** signatures
(`crates/xmss`). Our SDK signs with our own Keccak WOTS/XMSS (`aggregator/src/sdk/xmss.ts`). A user key had
no way to produce a signature that chain accepts. K10 generated test keys inside the prover.

## Result

`signer/` is a Rust CLI (`sigpress-leanxmss`) that calls the vendored `xmss` crate directly (no
re-implementation), so its signatures are exactly what the aggregation program verifies. The TS wrapper is
`aggregator/src/sdk/leanxmss.ts`, using the existing crash-safe `KeyStore`.

Checked (commands below, outputs in `results/`):

| Check | Result |
|---|---|
| CLI round trip: keygen, sign, verify; wrong message / slot / key rejected | pass (`aggregator/test/sdk-leanxmss.test.ts`) |
| Slot reuse refused (TS KeyStore, CLI state file, CLI ledger, `--reserved` lock check) | pass (same test) |
| 4 CLI-signed signatures -> `export-batch` -> leanVM aggregation proof under K10's `direct` profile -> native verify | accepted (left and right batch); proof 137,268-137,491 B, prove 0.84-1.18 s, verify 23-49 ms, max RSS ~0.8 GB (`results/prove-batch-2x4.jsonl`) |
| Same batch, leanVM's own `aggregate_single_message_signatures` (default config) + `verify_single_message_aggregate` | accepted; 315,817-316,733 B without pubkeys, prove 0.10-0.15 s |
| Tampered signature (one bit), native pre-check off | leanVM program fails, no proof (`memory already set ...`) |
| Batch message changed, pre-check off | leanVM program fails, no proof (`not equal: 128 != 184`) |
| **Full K10 terminal chain from two CLI-exported batches (2 x 4)** | **proves and natively verifies all 5 proofs; authors' 4 negative checks rejected**; terminal proof 111,170 B; proving 31.2 s, wall 37.6 s, max RSS 6.1 GB (`results/terminal-2x4-report.json`) |

The terminal run used `sigpress-leanxmss-terminal`, a copy of the K10 runner whose only change is reading the
two batches from `SIGPRESS_BATCH_LEFT` / `SIGPRESS_BATCH_RIGHT` instead of generating keys in-process. It writes
the same `root-fixture.json` the sol-whir-p3 generator consumes. **Not done:** generating a Solidity verifier
for this run or calling one on chain (that tooling lives in `experiments/k10-terminal`). The child dimension (20)
matches K10's 2 x 4 run, but we have not checked on chain that K10's deployed 2 x 4 verifier accepts this proof.

**Update (on chain):** done in the product instead: `SOURCE=sdk pnpm validity` (in `aggregator/`) proves 2 x 16
SDK-signed batches padded to the 2 x 256 shape. The deployed 2 x 256 verifier accepted the proof in tx
`0x08957c47f9638ad29a3ebff6f2b6de1fd7e80562388cde8500a42919940f152d` (see `docs/decisions.md`, "K11 on chain").

## Scheme facts (from the vendored source, not measured)

- Field KoalaBear (p = 2^31 - 2^24 + 1), hash Poseidon1 16-wide compression, digests 4 field elements.
- WOTS: v = 42 chains, w = 3 bits (chain length 8), fixed target sum (110 hashes); encoding randomness ground
  deterministically from the seed, slot and message.
- Merkle tree always 2^32 leaves (`LOG_LIFETIME = 32`); a key is *active* for a slot range, here
  `[activationSlot, activationSlot + 2^logSlots)`. Keygen cost grows with the active range, not 2^32.
- Public key 32 B SSZ, signature 1,208 B SSZ. Messages are 32 bytes.
- Aggregation is single-message: every signer in a batch signs the **same message at the same slot**
  (`MAX_XMSS_AGGREGATED` = 2^15 caps the signer count per aggregate; K10 measured up to 256 per child).

## Measured CLI cost (single runs, busy machine)

| logSlots | keygen | key file | sign (CLI wall, incl. process start + 3 fsyncs) |
|---|---|---|---|
| 4 | 2-6 ms | 1.8 KB | ~54 ms |
| 10 | 65-73 ms | 3.8 KB | ~59 ms |
| 16 | 4.3-4.6 s | 21 KB | ~130 ms |
| 20 | 81.6 s | 81 KB | ~0.5 s |

Verify (CLI wall): ~8 ms. Keygen is multi-threaded (h = 20: 688 s CPU over 81.6 s wall). RSS < 8 MB for all CLI
commands except `prove-batch`.

## Commands

```sh
cd signer && cargo build --release -j 4      # nightly-2026-03-04; needs ../../k10-terminal/vendor/leanVM (with the K10 patch)
B=./target/release/sigpress-leanxmss
$B keygen --seed 0x<32B> --out key.json --state state.json --log-slots 10
$B sign --key key.json --state state.json --index 7 --msg 0x<32B> --out sig.json
$B verify --sig-file sig.json
$B export-batch --msg 0x<32B> --slot 7 --sig a.json --sig b.json --out batch.json
# provers: wrap in the shared lock
$B prove-batch --batch batch.json --profile ../../k10-terminal/profiles/sigpress_c1.json
SIGPRESS_BATCH_LEFT=l.json SIGPRESS_BATCH_RIGHT=r.json LEANVM_PROVING_TIMEOUT_SECONDS=0 LEANVM_TERMINAL_EXPORT=runs/n4/native \
  ./target/release/sigpress-leanxmss-terminal 4 runs/n4/report.json ../../k10-terminal/profiles/sigpress_c1.json
```

## Licences

Ours (`signer/src/lib.rs`, `main.rs`): MIT. `signer/src/bin/sigpress-leanxmss-terminal.rs` is a modified copy
of Apache-2.0 code (notice at the top). Dependencies by path: the vendored leanVM crates (Apache-2.0).
