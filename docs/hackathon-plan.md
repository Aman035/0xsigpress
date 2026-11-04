# Hackathon plan (Monad Blitz, 1.5 h build)

**Owners:** Sumith (core: contracts, signatures, aggregator, testnet deploy). Aman (docs, website, demo page, pitch).
**Start → submit:** T+0 to T+90 min. Check boxes as you go and commit.

## What we build today (and why this scope)

The full design (one hash-based STARK over N signatures) needs kill tests K3-K6 (`plan.md`), which are
not done. A STARK verifier cannot be built in 90 minutes. So today we ship the **fallback already
described in `demo.md`**, which is still post-quantum end to end and still lives on Monad testnet:

1. **Real post-quantum signatures verified on Monad.** WOTS one-time signatures over Keccak
   (hash-based, quantum-safe). Each account rotates to a fresh one-time key per signature.
2. **Optimistic aggregation.** The aggregator puts only a 32-byte Merkle root (+ a bond) on chain for a
   whole batch. The signatures stay off chain (served by the aggregator). Anyone can challenge one
   signature: the contract checks that single WOTS signature on chain and, if it is bad, **slashes the
   bond and rejects the batch**.
3. **Naive lane for comparison.** The same signature verified directly on chain (all 2,144 bytes in
   calldata), so we can show measured gas and bytes for "naive PQ" vs "Sigpress".

Honest limits we say out loud: optimistic, not validity-proof (challenge window, data availability
is the aggregator's job today). STARK version is the 4-month product.

## Architecture

```
 user keys (TS)             aggregator (TS, viem)                Monad testnet (Solidity)
 ───────────────            ─────────────────────                ────────────────────────
 WOTS keygen/sign  ──ops──▶ collect N signed ops                 NaiveLane.submit(pk,msg,sig)   ← naive lane
                            build Merkle tree ── root+bond ────▶ OptimisticAggregator.submitBatch
                            serve sigs (out/batch-*.json)        OptimisticAggregator.challenge ← tamper beat
 challenger (TS)  ── leaf+proof+sig ───────────────────────────▶   verifies 1 WOTS sig, slashes
                                                                  OptimisticAggregator.finalize
 web/ demo page  ◀── reads deployments.json + batch results
```

Repo layout:

| Path | Owner | What |
|---|---|---|
| `contracts/` | Sumith | Foundry project: `WOTS.sol`, `NaiveLane.sol`, `OptimisticAggregator.sol`, tests, deploy script |
| `aggregator/` | Sumith | Node/TS + viem: `wots.ts`, `merkle.ts`, scripts `demo.ts`, `tamper.ts`, `naive.ts` |
| `web/` | Aman | Static demo page (two lanes + scoreboard + explorer links) |
| `README.md`, `docs/pitch.md`, slides | Aman | Submission text |

## Shared spec (both sides must match exactly)

**WOTS (w = 16, n = 32 bytes, Keccak-256)**
- `len1 = 64` message digits, `len2 = 3` checksum digits, `len = 67` chains.
- `chain(x, steps)`: repeat `steps` times `x = keccak256(x)` (x is 32 bytes).
- Secret key `sk_i` (TS only): `keccak256(abi.encodePacked(seed, uint32 keyIndex, uint8 i))`.
- Public chain end `pk_i = chain(sk_i, 15)`. **Public key hash** `pkHash = keccak256(pk_0 ‖ … ‖ pk_66)`.
- Digits of a 32-byte message `m`: the 64 nibbles of `m`, high nibble of byte 0 first. Checksum
  `c = Σ (15 − d_i)` over the 64 digits (max 960); digits 64..66 are `(c >> 8) & 0xf`, `(c >> 4) & 0xf`, `c & 0xf`.
- Signature: `sig_i = chain(sk_i, d_i)`; encoded as `sig_0 ‖ … ‖ sig_66` = **2,144 bytes**.
- Verify: `pk_i' = chain(sig_i, 15 − d_i)`; valid iff `keccak256(pk_0' ‖ … ‖ pk_66') == pkHash`.

**Operation and leaf**
- Signed message `m = keccak256(abi.encode(uint256 chainId, address aggregator, bytes32 pkHash, bytes32 nextPkHash, bytes32 payloadHash))`.
  (`nextPkHash` = the account's next one-time key, so key rotation is signed.)
- Leaf `= keccak256(abi.encodePacked(pkHash, m, keccak256(sig)))`.
- Merkle tree: leaves padded with `bytes32(0)` to a power of two; `parent = keccak256(abi.encodePacked(left, right))`.
  Proof = sibling list bottom-up + leaf `index` (bit i of index = 1 means the node is the right child at level i).

**Contracts (Solidity ^0.8.24)**
- `library WOTS { function verify(bytes32 pkHash, bytes32 m, bytes calldata sig) internal pure returns (bool); }`
- `NaiveLane.submit(bytes32 pkHash, bytes32 m, bytes calldata sig)`: reverts `InvalidSignature()` if bad; emits `Verified(pkHash, m)`.
- `OptimisticAggregator(uint256 bond, uint256 window)`:
  - `submitBatch(bytes32 root, uint32 count, string dataURI) payable returns (uint256 id)` (requires `msg.value == bond`), emits `BatchSubmitted`.
  - `challenge(uint256 id, bytes32 pkHash, bytes32 m, bytes sig, uint256 index, bytes32[] proof)`: leaf must be in root and window open; if the WOTS signature is **invalid**, mark batch slashed, pay the bond to the challenger, emit `BatchSlashed`; if **valid**, revert `SignatureValid()`.
  - `finalize(uint256 id)`: after the window, if not slashed, return the bond, mark accepted, emit `BatchFinalized`.
  - `isAccepted(uint256 id, bytes32 leaf, uint256 index, bytes32[] proof) view returns (bool)`.

**Files the web page reads** (written by the aggregator scripts, copied to `web/public/`):
- `deployments.json`: `{ chainId, naiveLane, aggregator, explorer }`
- `results.json`: `{ naive: { txHash, gasUsed, calldataBytes }, batch: { txHash, gasUsed, count, root, bytesPerOp }, tamper: { submitTx, challengeTx, slashed } }`
  Until real numbers exist, Aman uses a `results.sample.json` with the same shape, **labelled "sample"**.

## Timeline

| Time | Sumith | Aman |
|---|---|---|
| T+0-10 | This plan, push | Read this plan + `demo.md`; set up `web/` |
| T+10-45 | Contracts + tests, TS WOTS/Merkle (parallel subagents) | Demo page against `results.sample.json`; README draft |
| T+45-65 | Cross-check TS ↔ Solidity on anvil; deploy to Monad testnet; run demo/tamper scripts | Pitch slides/text; get testnet MON from faucet as backup |
| T+65-80 | Write `results.json`, hand to Aman; record numbers in `decisions.md` | Wire real `results.json` into page; deploy page (Vercel) |
| T+80-90 | Rehearse demo, fix | Submit: repo link, page link, video/screens |

## Checklist: Sumith (core)

- [x] Plan doc committed and pushed
- [x] `contracts/` Foundry project, `WOTS.sol` per spec
- [x] `NaiveLane.sol` + tests (valid sig passes, flipped bit reverts)
- [x] `OptimisticAggregator.sol` + tests (submit, challenge bad sig → slash, challenge good sig → revert, finalize after window)
- [x] Gas report: naive verify gas, `submitBatch` gas
- [x] `aggregator/` TS: `wots.ts`, `merkle.ts` per spec, unit tests
- [x] Cross-check: TS-made signature verifies in the Solidity contract (anvil)
- [x] Deploy script; deploy both contracts to Monad testnet (chain 10143); write `deployments.json`
- [x] `naive.ts`: one naive tx on testnet → gas + bytes
- [x] `demo.ts`: batch of N (e.g. 256) ops → one `submitBatch` tx
- [x] `tamper.ts`: batch with one bad sig → `challenge` → slashed on chain
- [x] `results.json` to `web/public/`; numbers into `decisions.md` (measured, with tx hashes)
- [x] Deployer key in `.env` (`PRIVATE_KEY`, never committed), funded from faucet

## Checklist: Aman (docs, site, pitch)

- [x] Read `docs/idea.md`, `docs/demo.md`, this file
- [x] `README.md`: one-paragraph pitch, how it works (diagram above), how to run, honest limits, licence (MIT)
- [x] `web/`: single static page (plain HTML/JS or Vite), two lanes:
  - Left "Naive post-quantum": block gauge using K1 numbers (~370-540 tx/block for ML-DSA; 2,144 B/sig for our WOTS)
  - Right "Sigpress": 32-byte root per batch, bytes/op from `results.json`
  - Both gauges **labelled "capacity model"** (see `demo.md`: never fake live TPS)
  - Monad testnet panel: tx links to the explorer (`https://testnet.monadexplorer.com/tx/<hash>`) from `results.json`
  - Scoreboard: bytes/signature, tx/block, gas/batch, gas/op, challenge result
- [x] `results.sample.json` (marked sample) so the page works before real numbers land
- [ ] Deploy page (Vercel or GitHub Pages); put the link in README — workflow added at `.github/workflows/pages.yml`; **needs one manual step: repo Settings → Pages → Source = GitHub Actions**
- [x] Pitch: update `docs/pitch.md` to say "optimistic aggregation today, STARK next"; 5-slide deck or 90-second script following the four beats in `demo.md` (90-second script added)
- [ ] Submission form: repo URL, page URL, contract addresses (from `deployments.json`) — manual

## Rules

- Conventional Commits, one line, small commits. Pull before you push.
- Never commit `.env` or keys.
- Every number on the page or in the pitch is either measured (with a tx hash) or labelled as a model/sample.
- Only MIT/Apache-2.0 code. The WOTS and contracts are written by us today.

## Phase 2 (in progress, Sumith)

- [x] Core contracts + TS, tests green (forge 20/20, TS 11/11), TS ↔ Solidity vector match
- [x] One-shot testnet run: `./scripts/testnet.sh` (needs funded `PRIVATE_KEY` in `.env`)
- [x] Fund deployer `0x445a0c4780a8107158df60B18Ee5372497dc1D12` from the faucet, run testnet script
- [x] `PQAccount` + factory: accounts execute ops only from finalized batches (key rotates each op); `executeDirect` single-op fallback; `pnpm execute` script
- [ ] K3: proof-system survey in `experiments/k3/`, local K4 data point (Solidity STARK/WHIR verifier gas on anvil)
- [x] Testnet numbers into `docs/decisions.md` and `web/public/results.json` (Aman wires them into the page)
