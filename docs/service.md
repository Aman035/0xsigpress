# Aggregator service and watchtower

The service has two modes. **`MODE=validity`** is the trustless STARK path (section "Validity mode" below):
every signature is proved, the proof is checked on chain, nothing needs a watchtower. **The default (`MODE`
unset or `optimistic`)** is the optimistic path described first: a bonded root plus challenges. The optimistic
path stays as the fallback (it needs no prover and confirms in seconds plus the window).

The long-running half of the optimistic design. The **service** takes WOTS-signed ops for SigpressAccounts over HTTP, checks each one off chain, batches them, posts one Merkle root plus a bond to the OptimisticAggregator, waits out the challenge window, finalizes, then runs the whole batch in one `SigpressEntry.executeBundle()` tx. It also serves each batch's signatures (the data-availability, or DA, document) so anyone can check them. The **watchtower** is separate. It follows `BatchSubmitted` on any OptimisticAggregator, fetches each batch's signatures, verifies them all, and calls `challenge` on the first bad one while the window is open.

Code: `aggregator/src/service/` (`batcher.ts` is the state machine, `server.ts` the HTTP API, `watchtower.ts`, `da.ts` the DA format and check, `store.ts` atomic file writes, `chain.ts` the chain adapter). The encoding and signing code is reused from `compact.ts`, `account.ts`, `op.ts`, `wots.ts` and `merkle.ts`.

## Run it

Everything runs from `aggregator/`. Keys come from the root `.env`. `KEY_VAR` names the variable that holds the key.

```sh
# Monad testnet (uses deployments-service.json; falls back to deployments-compact.json)
KEY_VAR=PRIVATE_KEY_K13 pnpm service                                   # API on http://127.0.0.1:8547
KEY_VAR=PRIVATE_KEY_K13 DA_URL=http://127.0.0.1:8547 pnpm watchtower   # better: its own key, WATCH_KEY_VAR=...
KEY_VAR=PRIVATE_KEY_K13 OPS=4 BAD=1 pnpm service:demo                  # make accounts, sign, POST, wait
KEY_VAR=PRIVATE_KEY_K13 pnpm service:tamper                            # dishonest batch; a watchtower should slash it

# Local anvil
anvil --block-time 1 &
cd ../contracts && KEY_VAR=K0 K0=<anvil key> WINDOW=10 forge script script/DeployCompact.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
cd ../aggregator && RPC_URL=http://127.0.0.1:8545 SERVICE_DEPLOYMENTS=<json with entry, batches> KEY_VAR=K0 pnpm service
```

Deploy your own instance with `contracts/script/DeployCompact.s.sol` (env `KEY_VAR`, `WINDOW`, `BOND`). Neither contract restricts who submits, finalizes or executes, so one deployment can serve any number of aggregators.

Tests: `pnpm test` runs `test/service.test.ts` (an in-memory fake chain that rebuilds leaves and roots the way the contracts do) and `test/service-anvil.test.ts` (real anvil and real forge deploy, plus the service and watchtower running in-process).

### Service env

| Var | Default | Meaning |
|---|---|---|
| `KEY_VAR` | `PRIVATE_KEY` | env var holding the service key (pays the bond and gas) |
| `RPC_URL` | Monad testnet | |
| `SERVICE_DEPLOYMENTS` | `deployments-service.json`, else `deployments-compact.json` | `{entry, batches}`; `ENTRY` overrides the entry |
| `PORT` / `HOST` | `8547` / `127.0.0.1` | |
| `PUBLIC_URL` | bound URL | base written into each batch's `dataURI` (`<PUBLIC_URL>/da/<root>`); set it to a public address in production |
| `MAX_OPS` | `64` | cut a batch at this many ops |
| `MAX_WAIT_MS` | `5000` | or when the oldest queued op is this old |
| `FALLBACK_MS` | `60000` | an op still not batched after this long goes on chain alone via `executeDirect` (`0` turns this off) |
| `TICK_MS` | `500` | state-machine poll interval |
| `GAS_MULT` | `1.25` | gas limit = estimate × this. Monad charges the limit, so keep it tight |
| `REVEALER` | on | `0` turns off answering `requestReveal` on our batches. Leave it on: an unanswered request lets anyone slash our batch for half the bond |
| `REVEAL_KEY_VAR` | `KEY_VAR` | key that pays `reveal` gas (any key may answer; a separate one avoids nonce races with the batcher) |
| `SERVICE_DIR` | `out/service/<chainId>-<entry>/` | state and DA files |
| `RPC_RETRY_COUNT` / `RPC_RETRY_DELAY_MS` | `3` / `150` | viem retry backoff. The public testnet RPC returns HTTP 429; `7` / `400` worked |

### Watchtower env

| Var | Default | Meaning |
|---|---|---|
| `AGGREGATOR` | `batches` from the deployments file | any OptimisticAggregator |
| `DA_URL` | none | comma-separated base URLs, tried as `<base>/da/<root>` after the event's own `dataURI` (if it is http(s)) |
| `WATCH_KEY_VAR` | `KEY_VAR` | key that pays for `challenge` and receives the bond |
| `FROM_BLOCK` | latest − 1000 | first block to scan; after that it resumes from its state file |
| `POLL_MS` / `LOG_CHUNK` | `2000` / `100` | `eth_getLogs` is chunked for RPC range limits |
| `WATCH_STATE` | `out/service/watchtower-<aggregator>.json` | |
| `REVEAL` | `1` | on missing DA, `requestReveal` every leaf, then `slashUnrevealed` past each deadline. `0` = only log |
| `REVEAL_MAX` | batch size | leaves demanded per batch (each locks `revealDeposit` until answered) |

## API

All bodies are JSON. bigints go as decimal strings.

**`POST /ops`**: one signed op for a SigpressAccount.

```json
{ "index": 3, "account": "0x…", "target": "0x…", "value": "100000000000000", "data": "0x",
  "nextPkHash": "0x…32 bytes", "sig": "0x…2144 bytes" }
```

`index` is the account's SigpressEntry index. `account` is optional when `index` is given. Without `index` the service tries the `AccountCreated` logs, which fails on RPCs with log-range limits, so pass `index`. The signed message is the SigpressAccount one: `m = keccak256(abi.encode(chainId, entry, pkHash, nextPkHash, payloadHash))` with `payloadHash = keccak256(abi.encode(account, nonce, target, value, keccak256(data)))`. `signCompactOp` in `compact.ts` produces it.

Before an op is accepted, the service checks the shape (sig exactly 2,144 B, data ≤ 65,535 B, non-zero `nextPkHash`), that `accountOf(index) == account`, and the WOTS signature against the **expected** key and nonce. Those come from the chain, or from the account's last op still queued in the service, so one account can queue chained ops. Responses: `202` with the op view, `200` if it is a duplicate, `400` with `{error}` if it is rejected, `503` if the queue is full (10,000 pending).

**`GET /ops/:id`** (`id` is the op's batch leaf, returned by POST):
`{ id, status, account, accountIndex, nonce, via, txHash, callSuccess, error, batch: {key, id, status, root, deadline} }`

| status | meaning |
|---|---|
| `pending` | queued, not in a batch yet |
| `batched` | in a batch whose root is posted; challenge window running |
| `finalized` | window passed, batch finalized, bundle not run yet |
| `executed` | ran on chain (`via: bundle` or `direct`). `callSuccess: false` means the op was used up but its call reverted (SigpressAccount does not revert the bundle for one bad call) |
| `failed` | see `error`: stale (the account moved on chain before batching), skipped as a dead op, or `executeDirect` reverted |

**`GET /batches/:id`**: by on-chain batch id, local key (`b0`) or root. Returns `{ key, id, status (built|submitted|finalized|executed|slashed|failed), root, count, deadline, submitTx, finalizeTx, executeTx, ops, da }`.

**`GET /da/:root`**: the DA document. This is what challengers need.

```json
{ "version": 1, "root": "0x…", "count": 4, "chainId": 10143, "aggregator": "0x…", "entry": "0x…",
  "leaves": [ { "index": 0, "pkHash": "0x…", "m": "0x…", "sig": "0x…",
                "accountIndex": 3, "account": "0x…", "nonce": "0", "target": "0x…", "value": "…", "data": "0x", "nextPkHash": "0x…" } ] }
```

`pkHash`, `m` and `sig` are enough to challenge. The op fields let anyone rebuild the `executeBundle` calldata, so a finalized batch can still be executed if the service dies. `checkDA` in `da.ts` is the check: the leaves must rebuild exactly the posted root and count, and then every signature must verify.

**`GET /health`**: chain, entry, aggregator, sender, and op counts by status.

## How a batch moves

1. **Cut.** The service takes queued ops in arrival order, up to `MAX_OPS`, once there are `MAX_OPS` of them or the oldest is `MAX_WAIT_MS` old. Each account's ops are re-checked against its on-chain key and nonce first; ops the chain has moved past are marked `failed` (stale). An account never has ops in two in-flight batches: its later ops wait until the earlier batch has executed, because the entry rebuilds each leaf from the account's on-chain state at execution time. Chained ops of one account inside a single batch are fine.
2. **DA first.** The DA document is written to `SERVICE_DIR/da/<root>.json` before the submit tx is sent, so it can be served as soon as the event exists.
3. **Submit** `submitBatch(root, count, "<PUBLIC_URL>/da/<root>")` with the bond.
4. **Wait** until the block timestamp passes the deadline. If the batch was slashed meanwhile, its ops go back in the queue.
5. **Finalize** (permissionless; if someone else already finalized it, that is fine).
6. **Execute.** The service re-reads every account. An op whose account has moved past it (for example, its owner ran a different op through `executeDirect`) is sent as a SigpressEntry **dead-op record**: the record rebuilds the op's leaf and runs nothing, so one moved account cannot brick the batch. The bundle is simulated first. If it still would not run, the batch is marked `failed` and the remaining ops go back in the queue for a new batch.
7. **Fallback.** If batches cannot be submitted (for example, there is not enough balance for the bond), the service retries every 5 s. Any op still unbatched after `FALLBACK_MS` is sent through `SigpressAccount.executeDirect`, which checks its signature on chain. This only happens when the op is first in its account's queue and the account has nothing in flight. (SigpressAccount has `executeDirect`; PQAccount has one too, but the service only serves SigpressAccounts.)

**Persistence.** `SERVICE_DIR/state.json` holds every op and batch. Each write goes to a temp file, is fsynced, then renamed over the old one, so a crash leaves either the old file or the new one, never a torn file. Every tx is signed first, its `{hash, raw}` is saved, and only then is it broadcast. After a restart the service looks for each saved tx's receipt and re-broadcasts it if none is found. It never signs a second submit for the same batch. If a saved tx is rejected on re-broadcast (for example, its nonce was used), the service re-signs it. Tested: `test/service.test.ts` kills the process between signing and broadcasting, restarts it twice, and the batch is submitted exactly once and executes.

## Trust model

- **The service cannot change or forge an op it relays.** The signature binds target, value, data, nonce and next key. The entry rebuilds every leaf from the account's on-chain key and nonce and checks the root, and any mismatch reverts the whole bundle.
- **An aggregator (any submitter) can post a root containing a leaf for an op the account never signed.** The leaf only contains `keccak256(sig)`. What stops this is the challenge: a challenger who has the claimed signature shows on chain that it is invalid, the batch is slashed, and a slashed batch can never execute. **Safety therefore needs at least one honest, funded watchtower that can get the batch's signatures within the window.** With a 60 s window, a watchtower that is down for a minute can miss a batch.
- **Censorship.** The service can refuse or sit on ops. The user's way out is `executeDirect` through any relayer, or another aggregator, since the contracts are permissionless. The service's own fallback covers only its own outage.
- **Liveness after finalize.** `executeBundle` is permissionless and the DA document carries the full ops, so anyone can run a finalized batch.
- **The bond is too small to pay for challenges.** On testnet the bond is 0.001 MON. One `challenge` tx was charged 204,987 gas at 102 gwei, about 0.021 MON, roughly 20 times the bond. So a watchtower loses money on every challenge. The bond deters nothing and does not pay challengers. It must be sized above challenge gas (more, if it is meant to deter) before this is more than a demo.
- **Self-challenge.** The bond goes to whoever challenges, so an aggregator can challenge its own bad batch and get the bond back. Slashing then costs it only gas. The batch is still blocked, which is what protects users.

## The DA caveat (was the known hole; now a reveal game, SR-R1)

**Update (SR-R1 fix, contracts not yet redeployed):** the new `OptimisticAggregator` lets anyone force a leaf's signature on chain with `requestReveal(id, index)` (pays `revealDeposit`). If nobody answers with `reveal(...)` within `revealWindow`, anyone calls `slashUnrevealed`; `finalize` waits for every open request. The watchtower now does this automatically for batches whose DA is missing, and the service's revealer answers requests on its own batches from its DA store. Self-challenge now also loses half the bond (SR-R2). See `docs/security-review.md` for the limits (an honest watcher must still be online and funded; refunded requests can grief the aggregator). The text below describes the deployed (pre-fix) contracts.

The service serves the signatures itself, and the same operator posts the batch. A dishonest aggregator would simply not publish them. If nobody can fetch a batch's signatures, nobody can challenge it, it finalizes, and a forged op inside it executes. That is theft, not just delay. The watchtower cannot fix this. It can only shout:

```
!!!!! DA MISSING for batch 2 from 0x90F7… (6s of window left): DA unavailable: … -> HTTP 404 !!!!!
!!!!! DA RISK: batch 2 … passed its window WITHOUT its signatures ever being available (…). It can finalize unchecked. !!!!!
```

It logs this on every poll (at most once per 15 s per batch) until the window closes. It does the same when the document exists but does not rebuild the posted root, because that is the same as missing. `DA_URL` lets a watchtower try mirrors. The real fixes are outside this service: put the signatures where withholding is impossible (calldata or blobs, which costs the very block space Sigpress exists to save), use a DA committee, or replace the optimistic path with a validity proof (the leanVM track in `docs/plan.md`). Until then, treat the optimistic path as **safe only for operators you trust to publish their data**.

## Operating it

- **Keys and funds.** The service key pays the bond (returned at finalize) and the gas for submit, finalize and execute. The watchtower key pays challenge gas and should be a different key. If they share a key, a challenge and a service tx can race for the same nonce. (On testnet they shared K13; nothing collided because the service was idle during the tamper run.)
- **Gas.** Monad charges the gas limit, so the limit is the estimate × `GAS_MULT` (1.25). With the current SigpressAccount, every bundled op's call gets exactly `OP_GAS_LIMIT = 200,000` gas, and the bundle reverts if it cannot give an op that much. The executor therefore needs headroom at each op, and the charged gas is well above the earlier compact runs: 699,456 charged for 4 ops on testnet, against 368,264 for 4 ops on the older contracts in `deployments-compact.json`. How the charge grows with N on the current contracts is **not measured**. Do not raise `MAX_OPS` above 64 without measuring it against the 30M per-tx limit.
- **Restart.** Just restart the process; it resumes from `state.json`. Do not delete `SERVICE_DIR` while batches are in flight: the DA files are what challengers and executors need.
- **Watch for** `failed` batches in `/health`, the `!!!!!` lines in the watchtower log, and the service balance (a failed submit backs off and then falls back to `executeDirect`, which pays for a full on-chain WOTS verification per op; this path's gas on the current SigpressAccount has not been measured).
- **Rate limits.** The public testnet RPC returned HTTP 429 during the run. Set `RPC_RETRY_COUNT=7 RPC_RETRY_DELAY_MS=400` or use a private RPC. A watchtower poll that fails is simply retried on the next poll.
- **Not done yet:** authentication or rate limiting on `POST /ops`, metrics, splitting one account's long op chain across batches, a public DA mirror, and a bond sized for real use.

## Measured on Monad testnet (4 Nov 2026)

Own instance, deployed for this service from the contracts at `cf5e08c` (dead-op records and the per-op gas budget; the `deployments-compact.json` instance predates both). Addresses and runs are in `aggregator/deployments-service.json`. Window 60 s, bond 0.001 MON, key K13 `0xB746CD15085312d3D3Ca7eD2c6558Ae64533255D`.

- OptimisticAggregator `0xe00977ac934bfa7db45f01125756ae01e34bd449` ([deploy](https://testnet.monadexplorer.com/tx/0xd9854984cca7b65f41afe00c4174e838965c708f4587708aaec10210d65ac83c)); SigpressEntry `0x61fd5c4a628fba5920d23cc31c09b4e828095083` ([deploy](https://testnet.monadexplorer.com/tx/0x083399f962ec198a16647a063bb133bab6d8a2597117da34efc3ed310ddeb3fe)).
- **4 good ops through the service** (`pnpm service:demo`, OPS=4, 0.0001 MON transfers): [createAccounts](https://testnet.monadexplorer.com/tx/0x2dfb519b3b1f7af95dd0ad94a95c2bef2fcb8bf4163455d6912203ee88f9ab95). A tampered op POSTed first was rejected with HTTP 400. The 4 ops were batched within 4 s, then: [submitBatch](https://testnet.monadexplorer.com/tx/0x1bbe8b0a80f73074efd6dea6255dbbbd42ab64d8fe0a117efa3b174364846c16) (127,627 gas charged) → [finalize](https://testnet.monadexplorer.com/tx/0x91554011574afb1ab58475060d3a1317a04797448cc555b7fb05b4ec71f4c11c) (75,185) → [executeBundle](https://testnet.monadexplorer.com/tx/0x458ce3686615c77e33b9b06a451430832cae5b2be089438050a0ec99c46e7868) (699,456, all 4 ops in one tx). It took 74 s from POST to executed, nearly all of it the 60 s window. The watchtower fetched the DA and logged "all 4 signatures valid".
- **Dishonest batch** (`pnpm service:tamper`: 4 leaves, signature 2 tampered, DA served by the "attacker"): [submitBatch](https://testnet.monadexplorer.com/tx/0x3132b5e266c013f81d26e256429c9cd916b2af28483ad413104b53a89451d7c1). The watchtower found signature 2 invalid, and its first challenge attempt hit an RPC 429. It retried on the next poll, about 10 s after the submit: [challenge → slashed](https://testnet.monadexplorer.com/tx/0x6465442f746b218bc14395100b4481b09f2bc6cccfaf99cf4c57e035af1b94a3) (204,987 gas charged).
- The whole session (deploy plus both runs) cost about 0.45 MON at 102-203 gwei.
- On local anvil only (`test/service-anvil.test.ts`): 10 ops → one batch → one `executeBundle`; a moved account's op sent as a dead op (`OpSkipped`) while the rest of the batch executed; a tampered batch slashed by the in-process watchtower; and a batch with withheld DA flagged as `DA MISSING`, then `closed-unchecked`.

## Validity mode (`MODE=validity`)

Added 4 Nov 2026. Code: `aggregator/src/service/validity-service.ts` (state machine + HTTP), `src/validity.ts`
(prover driver, gate calldata), `contracts/src/ValidityEntry.sol` (execution).

**Flow.** A user owns a `ValidityAccount`, created by `ValidityEntry.createAccount(pubkey, salt)`. Its constructor
registers its leanXMSS public key with the entry (`keyOf[account]`, set once, by the account itself). To act, the user
signs **its own op**: `message = ValidityEntry.opHash(account, nonce, target, value, data)` (= `keccak256(abi.encode(
"sigpress-validity-op-v1" tag, chainId, entry, account, nonce, target, value, keccak256(data)))`), at the service's
open slot. The service:

1. **Accepts** the op if the registry holds this key for the account, the nonce is the account's next one, the
   leanXMSS signature over the op hash verifies at the open slot, and the account has no other op at that slot.
2. **Cuts** a batch when 2 × N ops are queued for the slot (N = the verifier's batch size: 256 or 1024) or the
   oldest is `MAX_WAIT_MS` old. The slot closes at the cut; later ops must sign the next slot (`409` otherwise),
   because every signer of one proof signs the same slot.
3. **Pads** to exactly 2 × N with its own filler keys (pool of 2 × N keys, logSlots 10, created once under
   `SERVICE_DIR/fillers/`) over throwaway messages, and writes the two per-signer batch files.
4. **Proves** (binding-v2 prover, under the shared prover lock `/private/tmp/claude-501/sigpress-prover.lock`,
   child process so the API stays up), recomputes the statement off chain, generates the verifier calldata.
5. **Submits** to `SigpressBindV2Gate` (eth_call first; gas = estimate + 5%).
6. **Executes** the batch's ops with one `ValidityEntry.execute(slot, left, right, ops)`: the entry recomputes the
   batch commitment, requires `gate.accepted(commitment)`, and for each op checks the registered key is at
   (side, index), the message there is the op hash with the account's next nonce, then calls the account (fixed
   300k gas per op; a reverting call uses the nonce and does not revert the batch).

```sh
cd aggregator
# Monad testnet, 2 x 256 (the gate and verifier are already deployed; this deploys the ValidityEntry once)
SHAPE=2x256 KEY_VAR=PRIVATE_KEY_K14 pnpm validity:deploy
MODE=validity SHAPE=2x256 KEY_VAR=PRIVATE_KEY_K14 pnpm service             # API on http://127.0.0.1:8548
KEY_VAR=<another key> OPS=3 BAD=1 pnpm validity:demo                         # create accounts, sign, POST, wait

# Local anvil: the whole stack (Poseidon1Hasher, generated verifier, gate, entry) from the research artifacts
anvil --port 8555 --code-size-limit 131072 --hardfork prague --gas-limit 300000000 --block-time 1 &
RPC_URL=http://127.0.0.1:8555 VALIDITY_DEPLOYMENTS=/tmp/v.json SHAPE=2x256 KEY_VAR=K0 pnpm validity:deploy
RPC_URL=http://127.0.0.1:8555 VALIDITY_DEPLOYMENTS=/tmp/v.json MODE=validity SHAPE=2x256 KEY_VAR=K0 pnpm service
```

| Var | Default | Meaning |
|---|---|---|
| `MODE` | `optimistic` | `validity` = this mode |
| `SHAPE` | `2x256` | `2x256` or `2x1024`: which deployed verifier/gate (batch capacity 512 or 2,048) |
| `ENTRY` | from `deployments-validity-v2.json` | the ValidityEntry (must point at the shape's gate) |
| `VALIDITY_DEPLOYMENTS` | `aggregator/deployments-validity-v2.json` | `{"<chainId>:<shape>": {verifier, gate, entry}}`; Monad's verifier/gate are built in |
| `MAX_WAIT_MS` | `20000` | cut a non-full batch when its oldest op is this old |
| `START_SLOT` | `1` | first slot of a fresh state (user keys must cover it: SDK keys sign slots `activationSlot .. + 2^logSlots`) |
| `CONCURRENCY` | `8` | parallel CLI signs for fillers |
| `PORT` / `HOST` / `TICK_MS` / `SERVICE_DIR` | `8548` / `127.0.0.1` / `1000` / `out/service/validity-<chainId>-<entry>/` | |

**API.** `GET /validity` (also `/health`): `{entry, gate, shape, chainId, slot, capacity, queued, ops, batches}` —
clients read `slot` here. `POST /ops`: `{ account, target, value, data, nonce?, publicKey (32 B SSZ), slot, signature
(1,208 B) }` → `202` op view, `200` duplicate, `400` invalid (wrong key, nonce or signature), `409` stale slot or a
second op of the account at this slot, `503` slot full. `GET /ops/:id` (id = the op hash): `{status: pending |
batched | proving | accepted | executed | failed, side, index, callSuccess, error, batch}`. `GET /batches/:key`
(`v0`, `v1`, ...): `{slot, status, ops, fillers, commitment, submitTx, executeTx, gasCharged, proveSeconds}`.

**Crash safety.** `state.json` is written atomically at every step (cut → signed → proved → accepted → executed). On
restart: a batch that crashed while its fillers were signing fails (the filler keys refuse to re-sign that slot) and
its users re-sign at the next slot; a signed batch is re-proved from the saved
batch files (filler keys never re-sign a slot: the KeyStore refuses); a proved batch checks `gate.accepted` before
submitting again; execution skips ops whose on-chain nonce has moved past them. Unlike the optimistic batcher, txs
are not pre-signed and persisted, so a crash between broadcast and receipt can, at worst, re-send a submit that then
reverts `AlreadyAccepted` (not tested).

**Trust model.** No watchtower and no bond: the gate accepts a batch only with a valid proof bound to every (pubkey,
message) in calldata, and the entry runs an op only if its account's own key signed exactly that op. The service can
still censor or delay (users can submit elsewhere: `execute` is permissionless, and anyone can prove a batch).
Limits: the binding argument is ours and not externally reviewed; one key per account for life (no rotation; a
logSlots 10 key covers 1,024 slots); one op per account per batch.

**Measured on local anvil (4 Nov 2026, real prover and real generated verifier, 2 × 256):** 3 ValidityAccounts,
one tampered op rejected with HTTP 400, 3 ops + 509 filler signers cut 9 s after POST, proved in 55.7 s, `gate.submit`
15,882,913 gas, `ValidityEntry.execute` of the 3 ops 1,345,280 gas (mostly the 32 KB of pubkeys + messages it
re-reads), 103 s from POST to executed. Anvil reports gas used (Monad charges the limit).

**Measured on Monad testnet (4 Nov 2026, 2 × 256, wallet K14 `0x8bbF…47FB`):** ValidityEntry
[`0x75cb16d3…26f2`](https://testnet.monadexplorer.com/tx/0x19f419f474c3ddce494c28e2f95a1a02ce627974758e2de376ecf5c165e99b42)
(1,029,365 gas charged). `pnpm validity:demo` created 3 accounts
([#0](https://testnet.monadexplorer.com/tx/0x6aa7e18d577fd5bf94733eab3721d67301c33773142789ccff138a1bbf566b52),
[#1](https://testnet.monadexplorer.com/tx/0x310ad6b0c78da7dc488ea6f714747a79d5604d2c6710ae015963909fa5583894),
[#2](https://testnet.monadexplorer.com/tx/0x5b8093b29dc5c632491e8723352044c76cd5e1b38060c45b901b48544b884787)); a
tampered op got HTTP 400; 3 ops + 509 filler signers at slot 1, proved in 54.3 s.
[`gate.submit`](https://testnet.monadexplorer.com/tx/0x984ae62647244bde811e7e6e411e0581aa977d9d2a59f489c06ef4f346a53699)
charged 15,681,832 gas; [`ValidityEntry.execute`](https://testnet.monadexplorer.com/tx/0x7c7e2107316b97df668a73dfd638024f1b40aff6b241e6b5b2d472d776538845)
ran all 3 ops (`callSuccess` true) for 1,419,789 gas charged. **Caveat from this run:** the service's first submit
(`0x924dadb0…45db`) was never mined and never visible via `eth_getTransactionByHash`; re-sending the same raw tx was
refused ("Missing or invalid parameters"). The submit above is that same calldata sent by hand with the same nonce and
higher fees (`cast send`); `send()` in `src/validity.ts` now does this replacement itself after a 120 s receipt
timeout (not yet exercised on chain). The service then resumed from `state.json`, saw `accepted`, and executed.
