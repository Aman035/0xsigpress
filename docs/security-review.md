# Security review: Solidity contracts

Date: 4 Nov 2026. Scope: `contracts/src/` (WOTS, NaiveLane, OptimisticAggregator, PQAccount,
PQAccountFactory, SigpressEntry, SigpressAccount, `xmss/*`, `aa/*`). Out of scope: `experiments/`
(generated third-party verifiers, K10 terminal gate). Intent taken from `docs/hackathon-plan.md` and
`docs/sdk.md`.

Method: read every contract against the spec, then for each finding wrote a Foundry test that fails on the
old code (`contracts/test/security/`), fixed the contract, and made the test pass. Design-level issues that
need an owner decision are not fixed. They are pinned by passing tests in `Residual.t.sol` instead.

Result: `forge test` 93/93 pass (69 old + 24 new, including the Monad-testnet fork suite).
`cd aggregator && pnpm test` 39/39 pass, and `pnpm typecheck` is clean.

**Nothing is redeployed.** The contracts on Monad testnet are still the pre-fix versions (see "Needs
redeploy / format change").

## Findings

Severity is judged for this system as built: optimistic batches, permissionless executors, and signatures
that are public once the DA document is out.

| ID | Sev | Description | Test (`contracts/test/security/`) | Fix | Status |
|---|---|---|---|---|---|
| SR-01 | Medium | **One account can brick a whole SigpressEntry batch.** The bundle rebuilds every leaf from the account's live `(pkHash, nonce)`. If any op's account moves before the bundle lands, the root can never match and every other op in the batch is stuck. The move can be the user running the same signed op through `executeDirect`, or anyone else doing it with the public signature. Users must then fall back to `executeDirect` one by one. | `EntryDeadOp.t.sol` | Added **dead-op records**: an op whose account has moved past it (nonce > signed nonce, or equal nonce with a different key) is sent as a 216 B record (index with top bit set, plus signed nonce, key, call fields and hashes). The record rebuilds the leaf and runs nothing. A live op can't be skipped (`OpNotDead`), so this can't be used to censor. Emits `OpSkipped`. | Fixed (format extension) |
| SR-02a | Medium | **A gas-burning op starves its bundle.** `SigpressAccount` forwarded all gas to each op's call. A target that burns all of it takes about 63/64 of the bundle's gas, and the rest runs out even at Monad's 30M cap (shown with 1 bomb and 64 transfers). A batch with such an op can never execute. The op can also be state-dependent, so it passes the aggregator's simulation and turns into a bomb later. | `EntryGas.t.sol::test_gasBombOpDoesNotBrickBundle` | Bundled calls get exactly `OP_GAS_LIMIT = 200_000` gas. | Fixed (behaviour change, see below) |
| SR-02b | Medium | **An executor can burn a bundled op by choosing its gas limit.** `executeBundle` is permissionless. With a hand-picked gas limit, a big op's call runs out of gas while the remaining 1/64 still finishes the bundle. The op is used up (key rotated, nonce bumped) without having run. | `EntryGas.t.sol::test_underfundedBundleCannotBurnOp` | Before the call, `sigpressExecute` checks that the full `OP_GAS_LIMIT` can be forwarded (EIP-150 63/64 rule plus call overhead). If not, the whole bundle reverts with `InsufficientGas`. | Fixed |
| SR-03 | Low | **Batch membership did not mean "one of the `count` leaves".** `isAccepted`/`challenge` accepted any tree node: an internal node with a shorter proof, a zero padding leaf (`index >= count`), and any index whose high bits are ignored. In-repo consumers rebuild leaves from 96-byte preimages, so they can't be fooled. But `isAccepted` is a public oracle, and any integrator passing a caller-supplied leaf could be. | `MerkleMembership.t.sol` | `_inBatch` requires `index < count` and `proof.length == depthOf(count)`. The hash format is unchanged. Proofs from `merkle.ts` already have that length. | Fixed |
| SR-04 | Medium | **`SigpressAccount.executeDirect` let anyone burn an op.** It is permissionless and the signature is public (DA document, mempool). With a hand-picked gas limit the inner call runs out of gas, the key still rotates, and the op is lost. | `EntryGas.t.sol::test_underfundedDirectCannotBurnOp` | If the call fails with at most 1/63 of the pre-call gas left (it looks like it ran out of gas), revert with `InsufficientGas` instead of using the op up. The caller can resubmit with more gas. The direct path is otherwise uncapped. | Fixed |
| SR-05 | Low | **The challenge window could silently truncate.** `deadline = uint64(block.timestamp + window)`, and `window` was unchecked. A window of 2^64 or more gives a deadline of about now (no challenge window) while `window()` reports a huge value. Only the deployer sets it. | `Params.t.sol::test_hugeWindow*` | Constructor reverts `BadWindow` if `window > type(uint64).max / 2`. | Fixed |
| SR-06 | Low | **ETH stuck in SigpressEntry.** `createAccounts([])` with `msg.value > 0` kept the ETH, and the entry has no way to send it out. | `Params.t.sol::test_createNoAccounts*` | Reverts `NoAccounts` when there are no keys but value is sent. A call with no value is still a no-op. | Fixed |
| SR-R1 | Critical (design, known) | **Data withholding forges ops.** The chain only sees `keccak256(sig)`. An aggregator can commit a leaf for an op nobody signed (any account, any call), with a sigHash that has no known preimage, and withhold the data. No one can challenge it, and after the window it runs. This applies to PQAccount, XMSSAccount, SigpressEntry and the 4337 aggregator alike. | `Residual.t.sol::test_residual_withheldDataForgesOp` | None. This is the optimistic design's DA assumption (`hackathon-plan.md`, honest limits). Options: a challenge-to-reveal game (the aggregator must post the signature on chain within the window or be slashed), on-chain DA (blobs or calldata), or the validity-proof path. | Not fixed: needs design |
| SR-R2 | Medium (design) | **Failed fraud is free.** Anyone may challenge, including the aggregator, and the challenger gets the full bond. An aggregator caught with a bad batch front-runs the honest challenger with its own challenge and gets its bond back. The bond only deters fraud that isn't noticed. Honest challengers can also be front-run by MEV bots copying their (public) challenge, but the batch is still slashed. | `Residual.t.sol::test_residual_selfChallengeRefundsBond` | None. Options: burn part of the bond on slash, or use commit-reveal challenges. This is a product and economics decision. | Not fixed: needs decision |
| SR-R3 | Medium (design) | **A failed PQAccount op stays live.** `PQAccount` (and `XMSSAccount`) revert the whole op when the call fails, so the one-time key isn't rotated and the signed op stays valid. Anyone who saw the signature can run it later, when the call would succeed. With a WOTS one-time key, the owner's only other way forward is to sign a different message with the same key (key reuse). XMSS is less exposed: the next op uses a new leaf, and it kills the old op once the nonce advances. `SigpressAccount` already avoids this (a failed call uses the op up, logged `success = false`). | `Residual.t.sol::test_residual_failedPQAccountOpStaysLive` | None. Recommended: give PQAccount SigpressAccount's semantics (do not revert on a failed call, plus the SR-04 gas guard). That changes behaviour and ABI, so it needs a decision. | Not fixed: needs decision |
| SR-I1 | Info | **4337 aggregated path.** An account that isn't deployed yet (initCode) can't use it: `validateSignatures` runs before deployment, and `pkHash()` on an empty address reverts. If the same sender appears in two `UserOpsPerAggregator` groups, the second group reads the stale stored key and the bundle reverts (liveness only). `validateUserOpSignature` can't check anything without the batch, so bundlers can't pre-validate. Bundler reputation rules expect a staked aggregator. | none | none | Noted |
| SR-I2 | Info | **SigpressEntry account index is first-come.** `createAccounts` assigns `index = accountCount` at execution, and the address depends only on the index. Never pre-fund a predicted `accountOf(i)`: a front-runner can take index `i`. The TS funds atomically through `msg.value`, so nothing is lost today. `scripts/compact.ts` assumes its indices are `accountCount..+k-1`; it should read the `AccountCreated` events instead. | none | none | Noted |
| SR-I3 | Info | Batch ids above 2^32 can't be executed through SigpressEntry (the bundle's `batchId` is a uint32). An aggregator whose `finalize` payout fails (a contract that rejects ETH) can never finalize its own batches. That only hurts itself and its users, who still have the direct path. | none | none | Noted |

### Fix side effects to know about

- **`OP_GAS_LIMIT = 200_000` per bundled op.** An op that needs more gas fails inside a bundle (`success =
  false`, op used up) and should go through `executeDirect` instead. The aggregator should only accept
  ops that fit, and should keep `count × (OP_GAS_LIMIT + ~35k)` under the 30M tx cap: at worst every op
  in a batch is a gas bomb, and that is about 128 ops. A bundle tx needs a gas limit of about actual use +
  200k, because the last op must be able to get its full budget. Monad charges the gas limit, so this
  adds about 200k gas per bundle, not per op. Happy-path cost is 38,530 → 38,603 gas/op (local, 64-op
  bundle). The better long-term fix is a signed per-op gas limit (a signing-format change). Not done.
- **Membership is exact (SR-03).** A batch whose tree is padded beyond the next power of two of `count` is
  no longer accepted. One test helper (`test/aa/Aggregated4337.t.sol::_tree`) built a 4-leaf tree for 2
  ops; it now builds the spec tree. All TS builders (`MerkleTree`) already match the spec.

## Needs redeploy / format change

None of these are deployed. The live testnet contracts keep the old behaviour until they are redeployed.

| Contract | Change | ABI / format impact |
|---|---|---|
| `OptimisticAggregator` | SR-03 exact membership, SR-05 window bound | New `depthOf(uint256)`, new error `BadWindow()`. Same hash format. Contracts bound to the old address (PQAccount, XMSSAccount, PQAccount4337/factory, SigpressAggregator4337, SigpressEntry) must be redeployed against the new one to get the fix. |
| `SigpressEntry` | SR-01 dead-op records, SR-06 | **Bundle format extension**, backward compatible: an accountIndex with the top bit set (`0x80000000`) now means a dead-op record. Old bundles never set it, since that bit would need 2^31 accounts. New errors `OpNotDead(uint256)` and `NoAccounts()`, new event `OpSkipped(uint256,uint256)`. The signing format is unchanged. |
| `SigpressAccount` (impl, deployed by the entry) | SR-02, SR-04 | New `OP_GAS_LIMIT()` constant, new error `InsufficientGas()`. The bundled-op gas budget changes behaviour (see above). |
| TS `aggregator/src/compact.ts` | Updated | `encodeDeadOp`, `DeadBundleOp` (`dead: true, nonce, pkHash`) accepted by `encodeBundle`/`bundleCalldata`, `decodeBundle` returns `dead`/`dataHash`/`nonce`/`pkHash`. Account index capped at 2^31 − 1. New errors and the event are in the ABIs. Tests are in `aggregator/test/compact.test.ts`. The service batcher (`aggregator/src/service/*`, another agent's work, commit 9baf0be) already sends moved ops as dead-op records. |

## Invariants and fuzzing added

- `OptimisticAggregator.invariant.t.sol` (256 runs × 500 calls of random submit, challenge, finalize and
  time steps; about half the batches carry bad signatures):
  - **Bond conservation:** contract balance == bond × (batches neither slashed nor finalized).
  - A batch is never both slashed and finalized. A successful challenge always blocks finalize.
  - Slashed and finalized are terminal (never cleared), and a batch of valid signatures is never slashed.
- `SigpressEntry.invariant.t.sol` (128 runs × 40 calls of new batch over a random account subset,
  front-running direct runs of batched ops, execute with dead-op records, and replays of executed
  bundles):
  - **No op runs twice** (per-op call counter ≤ 1), and replaying an executed bundle never succeeds.
  - **Nonces only increase**, by one per op run, and each account's nonce equals the number of ops it has
    run.
  - **Liveness:** every finalized batch can be executed. This fails without the SR-01 fix.

## Reviewed and found fine

- **WOTS encoding:** 64 nibbles, high nibble of byte 0 first. The checksum Σ(15 − d) (max 960) is
  encoded as 3 nibbles `(c>>8, c>>4, c)`, which covers 12 bits. Chains complete the remaining 15 − d
  steps. Length is checked to be exactly 2,144 B. Assembly only uses scratch memory past the free pointer.
- **Message binding.** PQAccount's `m` binds chainId, the aggregator address, key, next key and
  `payloadHash(account, nonce, target, value, dataHash)`. SigpressAccount's `m` binds the entry address
  instead, XMSSAccount's binds the account, root and leafIndex, and 4337's binds chainId, the batches
  address and `userOpHash`, which includes the EntryPoint, sender and nonce. Checked for replay:
  - across accounts: payloadHash/userOpHash binds the account;
  - across chains: chainId;
  - across entries and aggregators: address in `m`;
  - across batches: the nonce and key rotation make a copied batch fail (`test_replayReverts`);
  - between the batch and direct paths: same `m`, shared nonce, so an op runs once either way;
  - XMSS leaf moves: `m` binds leafIndex, plus the used-leaf bitmap.
- **XMSS:** `authPath.length == height` and `leafIndex < 2^height` are enforced on both paths, so no
  internal node can be passed as a leaf key. Bitmap indexing is correct for height ≤ 32.
- **Challenge window edges:** challenge is allowed while `t < deadline` and finalize from `t >= deadline`,
  so there is no overlap and no gap. Double finalize, double slash, slash after finalize and finalize
  after slash all revert. State is written before the ETH payout, and re-entering payouts hits
  `AlreadySlashed`/`AlreadyFinalized`. There is no `receive`, so only bonds can be held.
- **executeBundle:** transient re-entrancy lock. Calldata slices are bounds-checked and trailing bytes are
  rejected. `executed[id]` is set before ops run and the whole tx reverts on a root mismatch. Op order is
  fixed by the leaf order. Return data is not copied (no return bomb). Only the entry can call
  `sigpressExecute` and `init`.
- **Factories (CREATE2):** the address is fixed by (pkHash, salt) and the constructor args, so a
  front-run deploy makes the same account. Pre-funding a counterfactual PQAccount or PQAccount4337 is
  safe.
- **4337:** the account names the aggregator in `validationData`, so plain `handleOps` fails with AA24.
  It rotates the key only inside validation, after `validateSignatures` has run on pre-rotation keys.
  Same-sender chains inside one group are handled. `missingAccountFunds` is ignored on purpose (the
  EntryPoint checks the deposit).
- Unchecked call returns: only the `missingAccountFunds` prefund, which is the ERC-4337 convention.

## Residual risks (not fixed)

1. **Optimistic data availability (SR-R1).** This is the big one. Safety of every batch path depends on at
   least one honest party holding every signature of every batch during the window and challenging.
   Today the aggregator serves the DA document, and nothing on chain forces it to.
2. **Bond economics (SR-R2).** The bond is tiny compared with what a batch can move, it is refunded on
   self-challenge, and challenges can be front-run. Liveness also depends on an honest challenger being
   online for each window.
3. **Key-to-account binding on the validity path** (`experiments/`, not reviewed here). The K10
   `SigpressTerminalGate` trusts a registrar wallet to say which signers and messages a proof covers. A
   compromised registrar can attribute signatures to accounts. The later K10 binding experiment
   (`SigpressValidityGate`, `docs/decisions.md`) recomputes the signer/message root on chain and drops
   that registrar, but by its own notes the **account ↔ pubkey** link is still unbound (it needs a
   registry or an account-side check). Until that is closed, the validity path is not end-to-end
   trustless.
4. **The outer transaction is ECDSA.** Executors and relayers send normal secp256k1 transactions. That
   isn't an authorisation risk, but it is a censorship and gas-theft risk (`docs/sdk.md`).
5. **Signer state.** WOTS keys are one-time and XMSS is stateful. The contracts are a backstop (nonce,
   bitmap), not the protection: two signatures from one key, even if neither lands, let a third party
   forge. PQAccount makes this easier to get wrong (SR-R3).
6. **WOTS parameters:** plain WOTS (w = 16, Keccak-256, no per-chain tweaks or bitmasks as in WOTS+).
   This is fine at n = 256 for one-time use, but multi-target security and tightness have not had a
   formal review.
7. **`OP_GAS_LIMIT` is a fixed constant**, not signed per op. A signed per-op gas limit would be cleaner
   and would let heavy ops use the bundle path.
