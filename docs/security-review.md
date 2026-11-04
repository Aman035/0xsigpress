# Security review: Solidity contracts

Date: 4 Nov 2026. Scope: `contracts/src/` (WOTS, NaiveLane, OptimisticAggregator, PQAccount,
PQAccountFactory, SigpressEntry, SigpressAccount, `xmss/*`, `aa/*`). Out of scope: `experiments/`
(generated third-party verifiers, K10 terminal gate). Intent taken from `docs/hackathon-plan.md` and
`docs/sdk.md`.

Method: read every contract against the spec, then for each finding wrote a Foundry test that fails on the
old code (`contracts/test/security/`), fixed the contract, and made the test pass. Design-level issues that
needed an owner decision (SR-R1..R3) were first pinned by passing tests in `Residual.t.sol`; after the
decisions they were fixed the same way (each Residual test flipped to assert the fix, plus new tests).

Result: `forge test` 112/112 pass (including the Monad-testnet fork suite; it can fail on public-RPC 429s,
rerun it alone). `cd aggregator && pnpm test` 43/43 pass, and `pnpm typecheck` is clean.

**Nothing is redeployed.** The contracts on Monad testnet are still the pre-fix versions (see "Needs
redeploy / format change" and the redeploy checklist).

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
| SR-R1 | Critical (design) | **Data withholding forges ops.** The chain only sees `keccak256(sig)`. An aggregator could commit a leaf for an op nobody signed (any account, any call), with a sigHash that has no known preimage, and withhold the data. No one could challenge it, and after the window it ran. This applied to PQAccount, XMSSAccount, SigpressEntry and the 4337 aggregator alike. | `Residual.t.sol::test_fixed_withheldDataIsSlashed`, `RevealGame.t.sol` (9 tests), invariants in `OptimisticAggregator.invariant.t.sol` | **Data-availability challenge.** During the window anyone pays `revealDeposit` to `requestReveal(id, index)`. The signature must be posted with `reveal(id, index, pkHash, m, sig, proof)` within `revealWindow` (anyone holding it may answer; the contract checks the leaf is in the batch, which pins `keccak(sig)`, then runs WOTS). Valid: deposit refunded, `Revealed` logs the signature on chain. Invalid: slashed at once. Unanswered by the deadline: anyone calls `slashUnrevealed`. The requester gets half the bond plus the deposit. `finalize` reverts `RevealPending` while any request is open and not before `finalizeAt(id)` = max(window end, last reveal deadline). Deposits left open on a batch slashed some other way come back via `reclaimDeposit`. Payouts to an address that rejects ETH are credited (`credits`, `withdraw`) so a hostile requester cannot block an honest reveal. The watchtower now demands every leaf of a batch whose DA is missing and slashes unanswered ones; the service answers requests on its own batches (`aggregator/src/service/revealer.ts`). | Fixed (ABI + constructor change; see limits below) |
| SR-R2 | Medium (design) | **Failed fraud was free.** Anyone may challenge, including the aggregator, and the challenger got the full bond. An aggregator caught with a bad batch could front-run the honest challenger with its own challenge and get its bond back. Honest challengers can also be front-run by MEV bots copying their (public) challenge, but the batch is still slashed. | `Residual.t.sol::test_fixed_selfChallengeLosesHalfBond`, `OptimisticAggregator.t.sol::test_challengeBadSigSlashes`, `invariant_slashBurnsHalf` | Every slash (challenge, invalid reveal, unanswered reveal) pays `bond / 2` to the challenger/requester and sends the rest to `0x…dEaD`. Self-challenge now costs half the bond. Front-running of honest challengers by copycats is unchanged (they still get only half, and the batch is still slashed). | Fixed |
| SR-R3 | Medium (design) | **A failed PQAccount op stayed live.** `PQAccount` (and `XMSSAccount`) reverted the whole op when the call failed, so the one-time key wasn't rotated and the signed op stayed valid. Anyone who saw the signature could run it later, when the call would succeed. | `Residual.t.sol::test_fixed_failedPQAccountOpIsUsedUp`, `FailedOp.t.sol` (5 tests), `PQAccount.t.sol::test_executeDirect_targetRevertUsesOpUp` | A failed call no longer reverts: the key rotates (PQAccount) / the leaf is marked used (XMSSAccount), the nonce moves, `Executed` is logged and then `ExecutionFailed(nonce, pkHash or leafIndex, target, reason)` with the revert data. SR-04 guard kept on both paths of both accounts: if the call fails with at most 1/63 of the pre-call gas left it reverts `InsufficientGas` (resubmit with more gas). `PQAccount4337` does not have the pattern: the EntryPoint consumes its nonce and the key rotates in validation, so a reverting `execute` cannot be replayed. `SigpressAccount` already had these semantics. | Fixed (behaviour + ABI change) |
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

- **Gas-limit overhead of `OP_GAS_LIMIT`, measured** (`EntryGas.t.sol::EntryGasOverheadTest`, local forge,
  inner call only, plain 1-wei transfers): min gas limit − gas used = **236,775 / 221,625 / 203,902** at
  **4 / 32 / 64 ops** (used 205,189 / 1,262,484 / 2,473,275; 51.3k / 39.5k / 38.6k per op). So the cap adds a
  one-time ~200-240k to the gas limit per bundle, not per op. The service's testnet figure (4 ops: 699,456
  charged now vs 368,264 before the cap, reported by the service run, not re-measured here) fits this: the
  service sets limit = estimate × 1.25 (`GAS_MULT`), so the ~237k overhead is charged as ~300k, and Monad
  charges the limit. Setting the bundle limit to the estimate plus a small fixed margin, instead of × 1.25,
  would save ~25% of the overhead and of the margin on large bundles.

## Needs redeploy / format change

None of these are deployed. The live testnet contracts keep the old behaviour until they are redeployed.

| Contract | Change | ABI / format impact |
|---|---|---|
| `OptimisticAggregator` | SR-03 exact membership, SR-05 window bound, SR-R1 reveal game, SR-R2 half-burn | **Constructor is now `(bond, window, revealDeposit, revealWindow)`** (`revealWindow` must be 1..2^63). New functions `requestReveal` (payable), `reveal`, `slashUnrevealed`, `reclaimDeposit`, `withdraw`, `finalizeAt`, views `reveals(id,index)`, `openReveals`, `lastRevealDeadline`, `credits`, `totalCredits`, `revealDeposit`, `revealWindow`, `BURN`, `depthOf`. New events `RevealRequested`, `Revealed`, `RevealMissed`, `DepositReturned`, `PaymentDeferred`, `Withdrawn`; new errors `BadWindow`, `WrongDeposit`, `AlreadyRequested`, `NoRevealRequest`, `RevealExpired`, `RevealWindowOpen`, `RevealPending`, `NotSlashed`. The `batches(id)` getter and the leaf/hash format are unchanged. **`finalize` can now revert `RevealPending` or `WindowOpen` after the window**, so callers must retry (the batcher already does). Contracts bound to the old address (PQAccount, XMSSAccount, PQAccount4337/factory, SigpressAggregator4337, SigpressEntry) must be redeployed against the new one. |
| `PQAccount`, `XMSSAccount` | SR-R3 | Failed call no longer reverts; new event `ExecutionFailed(uint256,bytes32,address,bytes)` / `ExecutionFailed(uint256,uint256,address,bytes)`, new error `InsufficientGas()`. Callers that relied on a revert to detect a failed call must read the event instead. Signing format unchanged. |
| `SigpressEntry` | SR-01 dead-op records, SR-06 | **Bundle format extension**, backward compatible: an accountIndex with the top bit set (`0x80000000`) now means a dead-op record. Old bundles never set it, since that bit would need 2^31 accounts. New errors `OpNotDead(uint256)` and `NoAccounts()`, new event `OpSkipped(uint256,uint256)`. The signing format is unchanged. |
| `SigpressAccount` (impl, deployed by the entry) | SR-02, SR-04 | New `OP_GAS_LIMIT()` constant, new error `InsufficientGas()`. The bundled-op gas budget changes behaviour (see above). |
| TS `aggregator/src/compact.ts` | Updated | `encodeDeadOp`, `DeadBundleOp` (`dead: true, nonce, pkHash`) accepted by `encodeBundle`/`bundleCalldata`, `decodeBundle` returns `dead`/`dataHash`/`nonce`/`pkHash`. Account index capped at 2^31 − 1. New errors and the event are in the ABIs. Tests are in `aggregator/test/compact.test.ts`. The service batcher (`aggregator/src/service/*`, another agent's work, commit 9baf0be) already sends moved ops as dead-op records. |

## Invariants and fuzzing added

- `OptimisticAggregator.invariant.t.sol` (256 runs × 500 calls of random submit, challenge, requestReveal,
  reveal, slashUnrevealed, reclaimDeposit, finalize and time steps; about half the batches carry bad
  signatures):
  - **Bond conservation:** contract balance == bond × (batches neither slashed nor finalized) + revealDeposit
    × (open reveal requests) + totalCredits.
  - **Burn (SR-R2):** the burn address holds exactly (bond − bond/2) × slashed batches.
  - A batch with an open reveal request is never finalized.
  - A batch is never both slashed and finalized. A successful challenge always blocks finalize.
  - Slashed and finalized are terminal (never cleared), and a batch of valid signatures is never slashed by
    a challenge or a reveal (it can be slashed by `slashUnrevealed` if nobody answers in time, by design).
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

1. **What the SR-R1 fix does not cover.**
   - Safety still needs one honest, funded watcher online during each window: it must request a reveal of
     every leaf it cannot verify. For a withheld batch of n leaves that locks n × `revealDeposit` until the
     reveal deadlines (64 leaves × 0.05 MON = 3.2 MON with the new defaults). `REVEAL_MAX` caps it, and
     leaves past the cap finalize unchecked (logged loudly).
   - **Griefing the honest aggregator.** Requests are refunded when answered, so a griefer pays only gas
     (~96k for a request) to make the aggregator pay a reveal (~217k gas local plus ~2.1 KB calldata),
     and each late request delays finalize by up to `revealWindow`. A deposit that is kept (paid to the
     revealer) instead of refunded, or a per-batch cap on requests, would price this. Not done: the brief
     was to refund.
   - The aggregator must stay online for `window + revealWindow` and answer requests, or it is slashed with
     no fraud. The service now does this (`revealer.ts`), but only for batches whose DA it still has on disk.
   - The data is on chain only for requested leaves (the `Revealed` event). Users who need the full bundle
     data to run their op (SigpressEntry `executeBundle`) still rely on the DA document, or on requesting
     every leaf.
2. **Bond economics.** Half the bond is now burned on every slash (SR-R2), so self-challenge loses half.
   The bond must still be sized: the challenger's half must cover a challenge's gas with margin, and a
   challenge cost ~0.021 MON on Monad testnet (service run; not re-measured here) against the old
   0.001 MON bond. **Rule: bond/2 ≥ ~10× worst-case gas cost of `challenge` or `slashUnrevealed`.** The
   deploy-script defaults are now bond 0.5 MON, revealDeposit 0.05 MON, revealWindow 60 s. The bond is
   still small next to what a batch can move. Challenges can still be front-run by copycats.
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
   forge. Since SR-R3 a failed call uses the op up, so the owner never has to re-sign with the same key,
   but an op that reverts for an out-of-gas-looking reason (at most 1/63 gas left) still stays live.
6. **WOTS parameters:** plain WOTS (w = 16, Keccak-256, no per-chain tweaks or bitmasks as in WOTS+).
   This is fine at n = 256 for one-time use, but multi-target security and tightness have not had a
   formal review.
7. **`OP_GAS_LIMIT` is a fixed constant**, not signed per op. A signed per-op gas limit would be cleaner
   and would let heavy ops use the bundle path.

## Redeploy checklist (SR-R1..R3 and earlier fixes; not run)

Order matters: everything that stores an `OptimisticAggregator` address is bound at construction.

1. `forge build && forge test` in `contracts/` (all green), then `cd aggregator && pnpm test && pnpm typecheck`.
2. **OptimisticAggregator + SigpressEntry** (SigpressEntry deploys the SigpressAccount implementation in its
   constructor): `KEY_VAR=<key var> WINDOW=120 BOND=500000000000000000 REVEAL_DEPOSIT=50000000000000000
   REVEAL_WINDOW=60 forge script script/DeployCompact.s.sol --rpc-url monad_testnet --broadcast --slow`
   (leave `BATCHES` unset so a new aggregator is deployed). Record both addresses in
   `aggregator/deployments-service.json` / `deployments-compact.json`.
3. **PQAccountFactory** (and NaiveLane) against the new aggregator: `forge script script/Deploy.s.sol`
   deploys its own new aggregator. Either run it and use that aggregator only for PQAccount, or (preferred,
   one aggregator for everything) deploy `new PQAccountFactory(<aggregator from step 2>)` by hand
   (`forge create src/PQAccountFactory.sol:PQAccountFactory --constructor-args <agg>`). Existing PQAccounts
   cannot be upgraded: users create new accounts and move funds.
4. **SigpressAggregator4337 + PQAccount4337Factory**: `BATCHES=<aggregator from step 2> KEY_VAR=...
   forge script script/DeployAA.s.sol --rpc-url monad_testnet --broadcast --slow`. `BATCHES` must be set: the
   script's default is the old live aggregator.
5. **XMSSAccount**: deployed per user by the SDK (`SigpressClient`), bound to the aggregator passed in;
   point the SDK at the step-2 aggregator. Old XMSSAccounts keep the SR-R3 behaviour.
6. Restart the service with the new deployments (its revealer starts by default; set `REVEAL_KEY_VAR` to a
   separate funded key to avoid nonce races with the batcher) and the watchtower with `AGGREGATOR=<new>`
   (funded with at least `count × revealDeposit` per batch it may have to demand).
