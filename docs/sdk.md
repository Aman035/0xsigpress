# Sigpress SDK (XMSS accounts)

Status: local/anvil only. Nothing here has been deployed to Monad testnet yet. All numbers below were
measured locally (Foundry and anvil) on 4 Nov 2026.

## What it is

Today's `PQAccount` uses a new one-time WOTS key for every op, and each op signs the next key's hash
(`nextPkHash`). That works, but the account's key changes on every op, and the wallet has to track a chain
of keys.

The SDK adds an **XMSS-style multi-use key**. It is still hash-based and still stateful:

- One secret seed gives 2^h WOTS one-time keys (default h = 10, so 1,024 signatures).
- The public key is the Merkle root over the 2^h WOTS key hashes. It never changes.
- A signature is `(leafIndex, leafPk, wotsSig 2,144 B, authPath h x 32 B)`: 2,528 B at h = 10.
- Verify: check that `leafPk` sits at `leafIndex` under the root (h hashes), then run the normal WOTS check
  (`contracts/src/WOTS.sol`, unchanged) against `leafPk`.

`leafPk` travels inside the signature (32 B more than the bare `(leafIndex, wotsSig, authPath)`). This
lets the WOTS library be reused as it is, and it means an XMSS op's `(leafPk, m, wotsSig)` is a valid leaf for
the existing `OptimisticAggregator`: the challenge path needs no changes.

Pieces:

| File | What |
|---|---|
| `contracts/src/xmss/XMSS.sol` | Verifier library (`rootOf`, `verify`) |
| `contracts/src/xmss/XMSSAccount.sol` | Account with a fixed root, a used-leaf bitmap, `executeDirect` and `executeFromBatch` |
| `aggregator/src/sdk/xmss.ts` | Keygen (deterministic from a seed, h configurable), sign, verify |
| `aggregator/src/sdk/keystore.ts` | Crash-safe key state (`KeyStore`) |
| `aggregator/src/sdk/client.ts` | `SigpressClient` (viem): `createAccount`, `signOp`, `submitDirect`, `submitFromBatch`, `buildBatch` |

## Spec

- `wotsSeed = keccak256(abi.encodePacked("sigpress.xmss.v1", seed))`. Leaf i is the WOTS key
  `keygen(wotsSeed, i)` from the shared spec (`docs/hackathon-plan.md`). The domain tag keeps XMSS leaves apart
  from the rotating keys `keygen(seed, i)` that `PQAccount` uses, so one seed in both places doesn't reuse a key.
- Tree: full binary tree over the 2^h leaf `pkHash`es, `parent = keccak256(left || right)`. The auth path
  runs bottom-up, and bit l of `leafIndex` = 1 means the node is the right child at level l (same as `merkle.ts`).
- Op message (XMSSAccount):
  `m = keccak256(abi.encode(uint256 chainId, address account, bytes32 root, uint256 leafIndex, bytes32 payloadHash))`,
  `payloadHash = keccak256(abi.encode(address account, uint256 nonce, address target, uint256 value, bytes32 keccak256(data)))`.
  `m` commits to the leaf index, so a signature can't be moved to another leaf.
- Batch leaf: `keccak256(abi.encodePacked(leafPk, m, keccak256(wotsSig)))`, the same shape as the PQAccount batch leaf.

## Using it

```ts
import { createPublicClient, createWalletClient, http, parseEther } from "viem";
import { xmssKeygen } from "./src/sdk/xmss.ts";
import { KeyStore } from "./src/sdk/keystore.ts";
import { SigpressClient, buildBatch } from "./src/sdk/client.ts";

const key = xmssKeygen(seed, 10);                        // seed: 32-byte secret from your wallet's secret storage
const ks = KeyStore.create("./keys/main.json", key);     // first time; later: KeyStore.open(path)

const client = new SigpressClient({ publicClient, walletClient, aggregator });
const account = await client.createAccount(key, { fund: parseEther("0.01") });

// Single op, signature checked on chain:
const op = await client.signOp({ account, key, keystore: ks, call: { target, value, data: "0x" } });
await client.submitDirect(op);

// Batch path: an aggregator puts op.leaf into a batch; once the batch is finalized:
const { root, proofs } = buildBatch([op /*, other ops */]);
// ... aggregator.submitBatch(root, ...), window passes, aggregator.finalize(batchId) ...
await client.submitFromBatch(op, { batchId, index: 0, proof: proofs[0] });

ks.close();
```

`createAccount` deploys the Foundry artifact `contracts/out/XMSSAccount.sol/XMSSAccount.json` (run
`forge build` first), or the `bytecode` you pass in.

## Key-state rules (read this)

A WOTS leaf that signs two different messages leaks enough of its secret for someone to forge a third.
XMSS doesn't fix that. It just gives you 2^h leaves to use one at a time. So:

1. **Persist the index before signing.** `KeyStore.sign` writes `nextIndex = i + 1` to a temp file,
   fsyncs it, renames it over the state file and fsyncs the directory. Only after that does it compute the
   signature for leaf i. If the process crashes at any point, either nothing was signed or leaf i is
   burned. Leaf i is never handed out twice. Burned leaves are the cost of this; they are not a bug.
   (This is the RLN lesson from `docs/plan.md` Part 4.)
2. **One state file per key, one process at a time.** `KeyStore` takes a lock file (`<path>.lock`, holding the
   owner's pid). If that process has died (crash, SIGKILL), the next `open` takes the lock over. If the pid is
   alive, `open` refuses. Delete a lock by hand only when you're sure no other process holds the key.
3. **Never restore key state from a backup or copy it to a second device.** An older `nextIndex` means
   reused leaves. If the state file is lost, don't guess. Read the account's used leaves on chain
   (`isUsed`) and skip past the highest one, or better, move to a fresh key. Leaves that were signed but
   never landed on chain can't be seen there, which is why the state file matters.
4. **The state file holds no secrets** (`{version, root, height, nextIndex}`). The seed stays with the caller.
   The SDK doesn't store the seed.
5. **Don't call `xmssSignUnsafe` yourself.** It has no state tracking. It exists for tests and for `KeyStore`.
6. **Exhaustion:** `KeyStore` warns (the `onWarn` callback, or `console.warn` by default) once 10% or less of
   the leaves are left. It refuses ordinary signs when only the reserved leaf is left (`reserve`, default 1),
   and refuses everything once all leaves are used. Use the reserved leaf for the migration op:
   `signOp({ ..., final: true })`.

What the chain does: `XMSSAccount` keeps a used-leaf bitmap and rejects any leaf it has executed before
(`LeafUsed`). The nonce in `payloadHash` stops replays. This is a backstop, not the protection. If a wallet
signs two messages with one leaf and neither has landed yet, an attacker can forge with that leaf and get
there first. The real protection is rule 1.

## What is and isn't quantum-safe

- **Quantum-safe:** authorisation. The account acts only on a hash-based signature (WOTS over Keccak-256,
  plus a Keccak Merkle path). No elliptic curves are involved in deciding what the account does. Security
  rests on Keccak preimage and second-preimage resistance (about 128-bit against Grover at n = 32 bytes;
  WOTS w = 16 and Merkle security have not had a formal tightness review here).
- **Not quantum-safe:** the outer transaction. A relayer, bundler or aggregator still sends a normal Monad
  transaction signed with ECDSA (secp256k1). A quantum attacker who breaks that key can steal the
  relayer's gas money, or censor or reorder its txs. They can't make the account do anything the user
  didn't sign. Fixing the outer layer needs protocol support (native PQ tx types or account abstraction at
  the protocol level). That is outside this SDK.
- **Not covered:** the optimistic batch path's liveness and data availability (see `docs/hackathon-plan.md`,
  honest limits), and the seed's own storage on the user's device.

## Limits

- **2^h signatures per key.** At h = 10 that's 1,024 ops, minus the reserved leaf and any burned ones.
  The contract allows h up to 32. The SDK caps keygen at h = 20, because keygen cost grows with 2^h.
- **Keygen time:** h = 4: ~0.1 s, h = 8: ~1.5 s, h = 10: ~5.9 s (TS, viem Keccak, Apple M4, single
  thread). Sign: ~8 ms, verify: ~3 ms. To skip a full keygen on restart, pass cached leaves
  (`xmssKeygen(seed, h, { leaves, expectedRoot })`; the first and last leaf are re-derived as a spot check).
  The leaves are public data.
- **Bigger signatures than plain WOTS:** 2,528 B at h = 10, against 2,144 B for bare WOTS (2,176 B with
  PQAccount's `nextPkHash`). The extra cost is the auth path plus `leafPk` (+352 B).
- **Fixed root:** an `XMSSAccount` can't change its key. See the rotation plan.

## Rotation plan

The root is fixed per account. When the key runs low:

1. When `onWarn` fires (10% left), generate a new seed and key and create a new `XMSSAccount`.
2. Use ordinary leaves to move assets and approvals across as needed.
3. Use the reserved last leaf (`final: true`) for one final sweep op from the old account to the new one.

A later version can rotate in place: a self-call `rotate(newRoot, newHeight)` signed by the current key, with
the bitmap keyed by key epoch. It isn't built yet, so for now "rotation" means migrating to a new account.

## Measured gas (local, not Monad testnet)

Foundry (`contracts/test/xmss/XMSS.t.sol`, `forge test --match-path 'test/xmss/*' -vv`), same message and
WOTS key for both verifiers:

| What | Gas |
|---|---|
| `WOTS.verify` (library call alone) | 52,791 |
| `XMSS.verify` at h = 10 (library call alone) | 54,705 (+1,914, i.e. +3.6%) |
| `XMSSAccount.executeDirect` h = 10, first op in a fresh bitmap word (call gas, cold) | 130,615 |
| `XMSSAccount.executeDirect` h = 10, later op in the same word (call gas, cold) | 82,015 |
| `PQAccount.executeDirect` op 1 / op 2 (call gas, cold) | 111,424 / 91,205 |

"Call gas" excludes the 21,000 base cost and the calldata cost of the outer tx. A new bitmap word costs a
zero-to-nonzero SSTORE once every 256 leaves. On op 1, both accounts also pay a zero-to-nonzero nonce write.

anvil (`aggregator/test/sdk-anvil.test.ts`), full tx `gasUsed`, h = 4: `executeDirect` op 1 196,205
(this includes a first transfer to an empty recipient address), op 2 143,641, and `executeFromBatch` 59,827.

Monad charges gas on the gas *limit*, not on gas used, so real cost depends on the limit the sender sets.
None of these are testnet numbers yet.

## leanXMSS (for validity proofs)

Added 4 Nov 2026 (K11, `experiments/k11-leanxmss/`). Research-grade, local only.

The K10 STARK chain (leanVM `recursive-verifier` @ `fb0909d`, Apache-2.0) only accepts **leanXMSS over
KoalaBear with Poseidon1**. That is a different scheme from the Keccak WOTS/XMSS above: different hash, field,
encoding and key format. A key from one scheme can't sign for the other. `aggregator/src/sdk/leanxmss.ts` wraps a
Rust CLI (`experiments/k11-leanxmss/signer`) that calls the vendored `xmss` crate directly, so its signatures
are exactly what the leanVM aggregation program verifies.

### Which scheme when

| | Keccak XMSS (`xmss.ts`) | leanXMSS (`leanxmss.ts`) |
|---|---|---|
| Verified by | Solidity (`XMSS.sol`, `XMSSAccount`), optimistic batch path | the leanVM aggregation program, and so the K10 terminal proof verified on chain |
| Use for | direct ops and the optimistic aggregator | validity-proof batches |
| Message model | each op signs its own message | each signer signs **its own 32-byte message** (its op hash); all signers of one proof sign at the **same slot** (binding v2). The older single-message mode (one shared batch root) still exists |
| Public key / signature | 32 B root / 2,528 B at h = 10 | 32 B / 1,208 B (any key size) |
| Runs in | pure TS | needs the Rust binary (`SIGPRESS_LEANXMSS_BIN`) |

Since binding v2 (4 Nov 2026, `experiments/k10-terminal/binding-v2/`) a batch carries one message per signer:
the SDK exports a per-signer batch (`leanxmssExportBatch(sigs, path, { perSigner: true })`, CLI `export-batch
--per-signer`) and the binding-v2 prover reads `signers[i].message`. For the validity service the message is
`ValidityEntry.opHash(account, nonce, target, value, data)` (`validityOpHash` in `src/validity.ts`).

### Using it

```ts
import { createLeanXmssKeyStore, leanxmssKeygen, leanxmssSign, leanxmssVerify, leanxmssExportBatch } from "./src/sdk/leanxmss.ts";

const key = leanxmssKeygen(seed, "./keys/lx.json", { logSlots: 10 });  // key file holds the seed (0600)
const ks = createLeanXmssKeyStore("./keys/lx.state.json", key);        // later: KeyStore.open(path)
const sig = leanxmssSign(key, ks, batchRoot, { slot: 7 });               // the aggregator picks the slot
leanxmssVerify(key.publicKey, sig.slot, batchRoot, sig.signature);       // true
leanxmssExportBatch([sig /*, other signers' sigs over the same (batchRoot, 7) */], "./batch.json");
ks.close();
```

Build the binary first: `cd experiments/k11-leanxmss/signer && cargo build --release -j 4`. It needs the K10
vendor checkout (`experiments/k10-terminal/vendor/leanVM` with the K10 patch) and the pinned nightly. The batch
file feeds `sigpress-leanxmss prove-batch` (one leanVM aggregation proof plus a native verify) or
`sigpress-leanxmss-terminal` (the full K10 chain).

Per-signer, for validity proofs (binding v2):

```ts
import { leanxmssGatePubkey, leanxmssSignAsync, leanxmssExportBatch } from "./src/sdk/leanxmss.ts";

const sig = await leanxmssSignAsync(key, ks, opHash, { slot });          // async CLI call (parallel signing)
leanxmssExportBatch([sig, ...othersAtThisSlot], "./batch-left.json", { perSigner: true });
leanxmssGatePubkey(key.publicKey);   // the gate / ValidityEntry encoding: each 32-bit limb big-endian
```

`leanxmssGatePubkey` matters: the SSZ public key stores its 8 KoalaBear limbs little-endian, the gate's calldata and
the `ValidityEntry` registry hold them big-endian. Register the gate form (`ValidityEntry.createAccount(gatePubkey,
salt)`).

On chain: `pnpm validity` (default `SOURCE=sdk`, `SHAPE=2x256`) makes 2 × 256 fresh SDK keys (logSlots 4), each
signs its own op hash at one slot, exports both per-signer batches, proves them and submits to the v2 gate. Run of
4 Nov 2026 on Monad testnet: 512 keys in 11.4 s, 512 signatures in 26.3 s (8 parallel CLI calls), proof 50.9 s,
[tx `0x58793519…f7b`](https://testnet.monadexplorer.com/tx/0x58793519fb294680ecd1b69dffe26580bc59e3ac5ddb4c28ceaec1396de99f7b)
15,717,137 gas charged, 512 distinct messages. 2 × 1024: 2,048 keys in 43.6 s, signatures in 107.2 s, proof 62.1 s.
(The earlier single-message run, `0x08957c47…f152d`, went through the registrar-trusted v1 gate.)

### Key state

- A slot is the leanXMSS one-time index. KeyStore index i = slot `activationSlot + i`. The state file is the
  normal KeyStore file, `{version, root = public key, height = logSlots, nextIndex}`. All the rules above apply.
- `leanxmssSign` calls `KeyStore.reserveIndex` (persisted before signing), then runs the CLI with `--reserved`.
  The CLI checks that our process holds the state lock and that the index is the one just reserved. Before
  signing, it also durably writes the last `(index, message)` to `<state>.leanxmss-signed` and refuses an older
  index, or the same index with a different message.
- Signing at a given `slot` burns every unused slot below it, one durable write each. A slot at or below a used one
  is refused. Slots only go forward, so a signer that misses a batch loses those slots.
- The CLI can also sign without TS (`sign` without `--reserved`). It takes the same lock file itself.

### Sizes and times (measured, Apple M4, shared busy machine, single runs)

| logSlots (signatures) | keygen | key file | sign (CLI call) |
|---|---|---|---|
| 4 (16) | 2-6 ms | 1.8 KB | ~54 ms |
| 10 (1,024) | 65-73 ms | 3.8 KB | ~59 ms |
| 16 (65,536) | 4.3-4.6 s | 21 KB | ~130 ms |
| 20 (1,048,576) | 81.6 s | 81 KB | ~0.5 s |

The sign column is wall time per CLI call, including process start, key-file load and three fsyncs. The
signature maths itself is a small part of that, but we haven't measured it separately. Verify is ~8 ms per CLI
call. Keygen uses all cores. The CLI caps `logSlots` at 24 (not measured above 20).

Prover side, 4 CLI-signed signatures (`experiments/k11-leanxmss/results/`):
- one leanVM aggregation proof under K10's `direct` profile: 137,268-137,491 B, 0.84-1.18 s, ~0.8 GB RSS;
  accepted by the native verifier;
- the full K10 terminal chain from two such batches (2 x 4): proves, all five proofs verify natively, and the
  authors' negative checks fail as they should. Terminal proof 111,170 B, 31.2 s proving, 6.1 GB max RSS;
- a one-bit-tampered signature, or a changed batch message, makes the leanVM program fail (no proof).

### Limits

- Per-signer messages and the signer set are now bound on chain by the v2 gate. The gate binds keys, not
  accounts: the `ValidityEntry` registry (account sets its key once, at creation) does that, and a key can't be
  rotated there.
- Keys can't be rotated in place, and slots are a plain counter. The CLI is a research binary (shell-out per
  call, no daemon). Security: leanVM's own README says the WHIR profiles are 100-bit component targets and that
  a composition analysis is still owed.

## Tests

- `forge test --match-path 'test/xmss/*'`: valid at several leaves, wrong path, index, leafPk, path length,
  height, tampered signature or message, leaf reuse rejected, replay rejected, out-of-order leaves,
  batch path, the shared TS root vector, and the gas numbers above.
- `pnpm test` in `aggregator/`:
  - `sdk-xmss`: determinism, the shared root vector, every leaf at h = 4, rejection cases, the leaf cache.
  - `sdk-keystore`: the index is on disk before each signature. A crash inside signing burns the leaf. A
    child process is SIGKILLed mid-loop 3 times, and after each restart no released index is reused and
    every released index is below the persisted `nextIndex`. Also covers exhaustion and the reserved leaf,
    warnings, the lock, a wrong key, and corrupt state.
  - `sdk-leanxmss` (skipped if the Rust binary isn't built): leanXMSS round trip; slot-reuse refusal in TS, the CLI
    state file, the ledger and the `--reserved` lock check; 4 signatures exported, proved with the leanVM aggregation
    program (under the shared prover lock) and accepted; a tampered batch fails to prove.
  - `sdk-anvil`: starts anvil and deploys with `forge create` (anvil's default key). Then: an h = 10 TS
    signature verifies through `cast call` on `XMSSAccount.verify`, the TS message matches `messageFor`, and
    the full `SigpressClient` flow runs (direct ops, replay and leaf-reuse rejected, batch submit, finalize and
    `executeFromBatch`). The test is skipped if anvil, forge or cast are missing.
