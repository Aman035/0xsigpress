# K1 TODO: Monad mainnet block utilisation sample

Research / throwaway code (kill-test K1 follow-up). Read-only: no keys, no transactions sent.

## Question

K1 computed block *capacity* assuming a 400 B baseline tx (= 1,500,000 B byte cap ÷ 3,750 tx cap).
What do real mainnet blocks look like: tx size, tx/block, bytes vs the cap, gas vs the limit?

## Method

- **RPC:** `https://rpc.monad.xyz` (QuickNode public endpoint, listed on
  https://docs.monad.xyz/developer-essentials/network-information, 25 req/s).
  `cast chain-id --rpc-url https://rpc.monad.xyz` → `143` (mainnet). `rpc1`, `rpc2`, `rpc3` and
  `rpc-mainnet.monadinfra.com` also answered `143`.
- **Sample:** 250 blocks, sampled 4 Nov 2026 08:41 UTC (latest = 119,281,723).
  - *Spread:* 200 blocks, every 1,426th block, covering 118,997,899 → 119,281,673
    (2026-11-03 08:47:54 → 2026-11-04 08:40:58 UTC, ~24 h).
  - *Contiguous:* 50 blocks 119,281,674 → 119,281,723 (08:40:58 → 08:41:13 UTC).
- **Tx size:** `eth_getRawTransactionByHash` is not exposed (`-32601 Method not found`), so the script
  calls `debug_getRawBlock`, RLP-decodes the block body, and takes the exact length of each tx's
  canonical encoding (legacy: the RLP list; typed: `type || rlp(payload)`). Cross-checked on block
  119,281,700: per-tx sizes from the block RLP sum to 33,865 B, equal to the sum of
  `cast tx <hash> --raw` lengths for its 6 txs (145 + 2,838 + 438 + 4,641 + 25,562 + 241).
- **Gas / types / selectors:** from `eth_getBlockByNumber(n, true)`. 4337 detection = calldata selector
  `handleOps` (`0x1fad948c` v0.6, `0x765e827f` v0.7+) and `handleAggregatedOps`
  (`0x4b1d7cf5`, `0xdbed18e0`).
- **Block time:** measured 0.303 s/block (timestamps over the last 100,000 blocks).

Run: `node sample.mjs [rpc] [spreadCount=200] [contiguousCount=50] [windowBlocks=auto 24h]`
(Node 23, no dependencies). Output: `results/summary.json`, `results/blocks.json` (per block).

## Results

| Metric | All 250 | Spread 200 (24 h) | Contiguous 50 |
|---|---|---|---|
| Txs sampled | 5,518 | 4,524 | 994 |
| Empty blocks | 0 | 0 | 0 |
| Tx size avg / p50 / p95 / max (B) | **1,728** / 1,180 / 4,657 / 25,562 | 1,712 / 1,274 / 4,564 / 21,082 | 1,799 / 1,178 / 5,179 / 25,562 |
| Tx/block avg / p50 / p95 / max | **22.1** / 19 / 45 / 98 | 22.6 / 19 / 46 / 98 | 19.9 / 19 / 45 / 46 |
| Tx bytes/block avg / p95 / max | **38,132** / 84,994 / 154,701 | 38,725 / 94,698 / 154,701 | 35,761 / 79,655 / 86,695 |
| % of 1,500,000 B byte cap, avg / max | **2.5%** / 10.3% | 2.6% / 10.3% | 2.4% / 5.8% |
| % of 3,750 tx cap, avg / max | **0.59%** / 2.6% | 0.60% / 2.6% | 0.53% / 1.2% |
| Gas "used" / 150M limit, avg / max | **11.9%** / 59.5% | 12.3% / 59.5% | 10.4% / 31.8% |

- **Live throughput:** ~22 tx/block ÷ 0.303 s ≈ **~73 tx/s** average (contiguous run: 994 tx in ~15 s ≈ 66 tx/s).
- **Tx types (all 250):** type 2 (EIP-1559) 5,119 (92.8%), type 0 (legacy) 387 (7.0%), type 1 11,
  type 4 (EIP-7702) **1**. 4337 `handleOps`: **2** (0.04%); `handleAggregatedOps`: 0.
- **Why txs are big:** many txs carry large calldata and EIP-2930 access lists (e.g. in block
  119,281,700 a 1,156 B-calldata tx with 7 addresses / 42 storage keys encodes to 2,838 B), and a single
  4337 `handleOps` bundle was 25,562 B.

## Caveats

- One RPC, one 24 h window, 250 blocks: a snapshot, not a trend.
- **Gas figure is gas charged, not executed.** Monad charges the gas *limit* (receipt `gasUsed` =
  tx limit, see `docs/decisions.md`), so block `gasUsed` is the sum of tx gas limits and overstates
  real execution.
- Byte figures are the tx encodings only; full block RLP (with header) averaged 38,850 B.
- Every Nth block sampling can miss short bursts; the max seen was 154,701 B (10.3% of the cap).

## What it means

1. **Mainnet today is far from the byte cap** (~2.5% average, 10% peak). The PQ squeeze is a
   *capacity-ceiling* argument about the future, not a congestion problem today. Pitch must say so.
2. **Real txs average ~1,728 B (median 1,180 B), not 400 B.** The 400 B baseline is the cap ratio, not a
   real tx. Recomputed capacity at the byte cap (block time 0.3 s as in K1):

   | Scheme | Bytes/tx (mean mix) | Tx/block | Cut vs real ECDSA mix | Bytes/tx (median) | Tx/block | Cut |
   |---|---|---|---|---|---|---|
   | ECDSA (as measured) | 1,728 | 868 | — | 1,180 | 1,271 | — |
   | ML-DSA-44 sig only | 4,083 | 367 | 58% | 3,535 | 424 | 67% |
   | ML-DSA-44 sig + pk | 5,395 | 278 | 68% | 4,847 | 309 | 76% |
   | Falcon-512 | 2,329 | 644 | 26% | 1,781 | 842 | 34% |
   | SLH-DSA-128s | 9,519 | 157 | 82% | 8,971 | 167 | 87% |

   With today's tx mix the byte cap already binds before the 3,750 tx cap (868 tx/block ≈ 2,900 TPS
   ceiling), and the *relative* ML-DSA cut is 58-76%, not 85-90%. Against the K1 ≥70% pass line it
   passes at the median for sig+pk and fails for sig-only / mean mix. The absolute cost is unchanged:
   each ML-DSA signature adds ~2.4-3.7 KB, i.e. 59-69% of every PQ tx's bytes.
