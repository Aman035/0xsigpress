// Unit tests for the aggregator service: atomic store, DA check, op parsing, and the Batcher state machine
// (size/time batching, chained ops, restart resume, stale ops, single-op fallback) against an in-memory
// fake of SigpressEntry + OptimisticAggregator that rebuilds leaves and roots like the contracts do.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesToHex, concat, hexToBytes, keccak256, numberToHex, toBytes, type Address, type Hex } from "viem";
import { signCompactOp } from "../src/compact.ts";
import { keygen, sign as signWots, verify } from "../src/wots.ts";
import { messageOf } from "../src/op.ts";
import { payloadHash } from "../src/account.ts";
import { MerkleTree } from "../src/merkle.ts";
import { Batcher, RejectError } from "../src/service/batcher.ts";
import type { BundleOp, ChainAdapter, TxOutcome } from "../src/service/chain.ts";
import { checkDA } from "../src/service/da.ts";
import { parseOpInput } from "../src/service/server.ts";
import { readJson, writeJsonAtomic } from "../src/service/store.ts";
import type { OpRecord, SignedTx } from "../src/service/types.ts";

const ENTRY = "0x00000000000000000000000000000000000000e1" as Address;
const BATCHES = "0x00000000000000000000000000000000000000b1" as Address;
const TARGET = "0x000000000000000000000000000000000000bEEF" as Address;
const CHAIN_ID = 31337;
const WINDOW = 10n;
const seedOf = (i: number) => keccak256(toBytes(`svc-test-${i}`));

class FakeChain implements ChainAdapter {
  readonly chainId = CHAIN_ID;
  readonly entry = ENTRY;
  readonly batches = BATCHES;
  readonly sender = "0x00000000000000000000000000000000000000a5" as Address;
  t = 1000n;
  accounts: { address: Address; pkHash: Hex; nonce: bigint }[] = [];
  onchain: { root: Hex; deadline: bigint; count: number; slashed: boolean; finalized: boolean; executed: boolean }[] = [];
  mined = new Map<Hex, TxOutcome>();
  queued = new Map<Hex, () => TxOutcome>();
  failSubmit = false;
  crashNextBroadcast = false;
  submits = 0;
  private n = 0;

  constructor(nAccounts: number) {
    for (let i = 0; i < nAccounts; i++) this.accounts.push({ address: numberToHex(0xa000 + i, { size: 20 }) as Address, pkHash: keygen(seedOf(i), 0).pkHash, nonce: 0n });
  }
  async accountCount() {
    return this.accounts.length;
  }
  async accountOf(i: number) {
    return this.accounts[i]!.address;
  }
  async accountState(a: Address) {
    const x = this.accounts.find((y) => y.address.toLowerCase() === a.toLowerCase())!;
    return { pkHash: x.pkHash, nonce: x.nonce };
  }
  async bond() {
    return 1n;
  }
  async timestamp() {
    return this.t;
  }
  async batchInfo(id: bigint) {
    return { ...this.onchain[Number(id)]! };
  }
  async bundleExecuted(id: bigint) {
    return this.onchain[Number(id)]!.executed;
  }
  private runBundle(id: bigint, ops: BundleOp[], dry: boolean): TxOutcome {
    const b = this.onchain[Number(id)];
    if (!b || !b.finalized || b.slashed) throw new Error("BatchNotAccepted");
    if (b.executed) throw new Error("AlreadyExecuted");
    const st = this.accounts.map((a) => ({ ...a }));
    const leaves: Hex[] = [];
    const executed = [];
    for (const o of ops) {
      const a = st[o.accountIndex]!;
      if (o.dead) {
        if (!(a.nonce > o.nonce || (a.nonce === o.nonce && a.pkHash !== o.pkHash))) throw new Error("OpNotDead");
        const dm = messageOf(CHAIN_ID, ENTRY, o.pkHash, o.nextPkHash, payloadHash(a.address, o.nonce, o));
        leaves.push(keccak256(concat([o.pkHash, dm, o.sigHash])));
        continue;
      }
      const m = messageOf(CHAIN_ID, ENTRY, a.pkHash, o.nextPkHash, payloadHash(a.address, a.nonce, o));
      leaves.push(keccak256(concat([a.pkHash, m, o.sigHash])));
      executed.push({ account: a.address, nonce: a.nonce, success: true });
      a.pkHash = o.nextPkHash;
      a.nonce += 1n;
    }
    if (new MerkleTree(leaves).root !== b.root || leaves.length !== b.count) throw new Error("RootMismatch");
    if (!dry) {
      this.accounts = st;
      b.executed = true;
    }
    return { status: "success", gasUsed: 1n, executed };
  }
  async simulateBundle(id: bigint, ops: BundleOp[]) {
    try {
      this.runBundle(id, ops, true);
      return undefined;
    } catch (e) {
      return (e as Error).message;
    }
  }
  private tx(action: () => TxOutcome): SignedTx {
    const hash = keccak256(toBytes(`tx-${this.n++}`));
    this.queued.set(hash, action);
    return { hash, raw: hash };
  }
  private safe(f: () => TxOutcome): () => TxOutcome {
    return () => {
      try {
        return f();
      } catch {
        return { status: "reverted", gasUsed: 1n };
      }
    };
  }
  async signSubmit(root: Hex, count: number) {
    if (this.failSubmit) throw new Error("insufficient funds for bond");
    return this.tx(() => {
      this.submits++;
      this.onchain.push({ root, count, deadline: this.t + WINDOW, slashed: false, finalized: false, executed: false });
      return { status: "success", gasUsed: 1n, submitted: { id: BigInt(this.onchain.length - 1) } };
    });
  }
  async signFinalize(id: bigint) {
    return this.tx(
      this.safe(() => {
        const b = this.onchain[Number(id)]!;
        if (this.t < b.deadline || b.slashed || b.finalized) throw new Error("WindowOpen");
        b.finalized = true;
        return { status: "success", gasUsed: 1n };
      }),
    );
  }
  async signBundle(id: bigint, ops: BundleOp[]) {
    return this.tx(this.safe(() => this.runBundle(id, ops, false)));
  }
  async signDirect(op: OpRecord) {
    return this.tx(
      this.safe(() => {
        const a = this.accounts.find((x) => x.address === op.account)!;
        const m = messageOf(CHAIN_ID, ENTRY, a.pkHash, op.nextPkHash, payloadHash(a.address, a.nonce, op));
        if (!verify(a.pkHash, m, op.sig)) throw new Error("InvalidSignature");
        const ev = { account: a.address, nonce: a.nonce, success: true };
        a.pkHash = op.nextPkHash;
        a.nonce += 1n;
        return { status: "success", gasUsed: 1n, executed: [ev] };
      }),
    );
  }
  async broadcast(tx: SignedTx) {
    if (this.crashNextBroadcast) {
      this.crashNextBroadcast = false;
      throw new Error("simulated crash before broadcast");
    }
    const f = this.queued.get(tx.hash);
    if (f && !this.mined.has(tx.hash)) this.mined.set(tx.hash, f());
  }
  async outcome(hash: Hex) {
    return this.mined.get(hash);
  }
}

function sign(chain: FakeChain, i: number, keyIndex: number, value = 1n) {
  const a = chain.accounts[i]!;
  const op = signCompactOp({ seed: seedOf(i), keyIndex, index: i, account: a.address, nonce: BigInt(keyIndex), chainId: CHAIN_ID, entry: ENTRY, call: { target: TARGET, value, data: "0x" } });
  return { index: i, account: a.address, target: op.target, value: op.value, data: op.data, nextPkHash: op.nextPkHash, sig: op.sig };
}

function setup(nAccounts: number, cfg: Partial<ConstructorParameters<typeof Batcher>[1]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sigpress-svc-"));
  const chain = new FakeChain(nAccounts);
  let now = 0;
  const clock = { advance: (ms: number) => (now += ms) };
  const make = () => new Batcher(chain, { dir, publicUrl: "http://da.test", maxOps: 64, maxWaitMs: 5000, fallbackMs: 60_000, submitBackoffMs: 1000, now: () => now, log: () => {}, ...cfg });
  return { dir, chain, clock, make, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("store: atomic JSON write round-trips bigints and leaves no temp files", () => {
  const dir = mkdtempSync(join(tmpdir(), "sigpress-store-"));
  const p = join(dir, "sub", "s.json");
  writeJsonAtomic(p, { a: 1n << 200n, b: [2n], c: "x" });
  writeJsonAtomic(p, { a: 3n, b: [], c: "y" });
  assert.deepEqual(readJson(p), { a: 3n, b: [], c: "y" });
  assert.deepEqual(readdirSync(join(dir, "sub")), ["s.json"]);
  assert.equal(readJson(join(dir, "missing.json")), undefined);
  rmSync(dir, { recursive: true, force: true });
});

test("parseOpInput: shape checks", () => {
  const chain = new FakeChain(1);
  const good = sign(chain, 0, 0);
  const body = { ...good, value: good.value.toString() };
  assert.equal(parseOpInput(body).value, 1n);
  assert.equal(parseOpInput({ ...body, value: "0x10" }).value, 16n);
  assert.throws(() => parseOpInput({ ...body, sig: "0x1234" }), RejectError);
  assert.throws(() => parseOpInput({ ...body, target: "nope" }), RejectError);
  assert.throws(() => parseOpInput({ ...body, value: "-1" }), RejectError);
  assert.throws(() => parseOpInput({ ...body, nextPkHash: "0x00" }), RejectError);
  assert.throws(() => parseOpInput({ ...body, index: undefined, account: undefined }), RejectError);
});

test("checkDA: good batch, bad signature, wrong root, wrong count", () => {
  const leaves = [0, 1, 2].map((i) => {
    const k = keygen(seedOf(i), 0);
    const m = keccak256(toBytes(`m${i}`));
    return { index: i, pkHash: k.pkHash, m, sig: signWots(k.sk, m) };
  });
  const root = new MerkleTree(leaves.map((l) => keccak256(concat([l.pkHash, l.m, keccak256(l.sig)])))).root;
  const doc = { version: 1, root, count: 3, chainId: 1, aggregator: BATCHES, leaves };
  const ok = checkDA(doc, { root, count: 3 });
  assert.ok(ok.ok && ok.firstBad === undefined);
  const b = hexToBytes(leaves[1]!.sig);
  b[5]! ^= 1;
  const badLeaves = leaves.map((l, i) => (i === 1 ? { ...l, sig: bytesToHex(b) } : l));
  const badRoot = new MerkleTree(badLeaves.map((l) => keccak256(concat([l.pkHash, l.m, keccak256(l.sig)])))).root;
  const bad = checkDA({ ...doc, leaves: badLeaves }, { root: badRoot, count: 3 });
  assert.ok(bad.ok && bad.firstBad === 1);
  assert.equal(checkDA({ ...doc, leaves: badLeaves }, { root, count: 3 }).ok, false); // DA does not match the root
  assert.equal(checkDA(doc, { root, count: 4 }).ok, false);
  assert.equal(checkDA(undefined, { root, count: 3 }).ok, false);
});

test("batcher: rejects bad ops; accepts chained ops; batches by size then by time; executes in one bundle", async () => {
  const s = setup(5, { maxOps: 3 });
  const b = s.make();
  const bad = sign(s.chain, 0, 0);
  const sb = hexToBytes(bad.sig);
  sb[0]! ^= 1;
  await assert.rejects(b.accept({ ...bad, sig: bytesToHex(sb) }), /invalid WOTS signature/);
  await assert.rejects(b.accept(sign(s.chain, 0, 1)), /invalid WOTS signature/); // skips a nonce
  await assert.rejects(b.accept({ ...sign(s.chain, 0, 0), index: 1 }), /is not index/);

  const ids: string[] = [];
  ids.push((await b.accept(sign(s.chain, 0, 0))).op.id);
  ids.push((await b.accept(sign(s.chain, 0, 1))).op.id); // chained: nonce 1 under the rotated key
  for (const i of [1, 2, 3]) ids.push((await b.accept(sign(s.chain, i, 0))).op.id);
  assert.equal((await b.accept(sign(s.chain, 1, 0))).duplicate, true);

  await b.tick(); // 5 pending >= maxOps 3: one batch of 3 now
  assert.equal(s.chain.submits, 1);
  assert.deepEqual(ids.map((id) => b.getOp(id)!.status), ["batched", "batched", "batched", "pending", "pending"]);
  await b.tick(); // remaining 2 < maxOps and younger than maxWait
  assert.equal(s.chain.submits, 1);
  s.clock.advance(5000);
  await b.tick();
  assert.equal(s.chain.submits, 2);
  assert.equal(b.getBatch("1")!.opIds.length, 2);
  assert.ok(b.getDA(b.getBatch("0")!.root)!.leaves.length === 3);

  s.chain.t += WINDOW;
  await b.tick(); // finalize + executeBundle for both
  assert.deepEqual(ids.map((id) => b.getOp(id)!.status), Array(5).fill("executed"));
  assert.equal(s.chain.accounts[0]!.nonce, 2n);
  assert.equal(s.chain.accounts[0]!.pkHash, keygen(seedOf(0), 2).pkHash);
  assert.equal(b.getBatch("b0")!.status, "executed");
  s.done();
});

test("batcher: an account's next op waits for its in-flight batch", async () => {
  const s = setup(2, { maxOps: 64, maxWaitMs: 0 });
  const b = s.make();
  const a = (await b.accept(sign(s.chain, 0, 0))).op.id;
  await b.tick();
  const c = (await b.accept(sign(s.chain, 0, 1))).op.id;
  await b.tick();
  assert.equal(b.getOp(c)!.status, "pending"); // not in a second in-flight batch
  s.chain.t += WINDOW;
  await b.tick(); // executes batch 0, then cuts op c into batch 1
  assert.equal(b.getOp(a)!.status, "executed");
  assert.equal(b.getOp(c)!.status, "batched");
  s.chain.t += WINDOW;
  await b.tick();
  assert.equal(b.getOp(c)!.status, "executed");
  s.done();
});

test("batcher: restart resumes pending ops and a signed-but-unsent submit without double-submitting", async () => {
  const s = setup(3, { maxWaitMs: 0 });
  let b = s.make();
  const ids = [];
  for (const i of [0, 1, 2]) ids.push((await b.accept(sign(s.chain, i, 0))).op.id);
  s.chain.crashNextBroadcast = true; // the process "dies" right after persisting the signed submitBatch
  await b.tick();
  assert.equal(s.chain.submits, 0);
  const persisted = readJson<any>(join(s.dir, "state.json"))!;
  assert.ok(persisted.batchList.b0.submitTx.hash);

  b = s.make(); // restart from disk
  assert.equal(b.getOp(ids[0]!)!.status, "batched");
  await b.tick(); // finds no receipt, resends the same signed tx
  assert.equal(s.chain.submits, 1);
  assert.equal(b.getBatch("b0")!.status, "submitted");

  b = s.make(); // restart again mid-window
  s.chain.t += WINDOW;
  await b.tick();
  assert.equal(s.chain.submits, 1);
  assert.deepEqual(ids.map((id) => b.getOp(id)!.status), ["executed", "executed", "executed"]);
  s.done();
});

test("batcher: op made stale on chain is failed, not batched", async () => {
  const s = setup(2, { maxWaitMs: 0 });
  const b = s.make();
  const stale = (await b.accept(sign(s.chain, 0, 0))).op.id;
  const fine = (await b.accept(sign(s.chain, 1, 0))).op.id;
  s.chain.accounts[0]!.nonce = 1n; // the account moved on chain (e.g. its owner used executeDirect elsewhere)
  s.chain.accounts[0]!.pkHash = keygen(seedOf(0), 1).pkHash;
  await b.tick();
  assert.equal(b.getOp(stale)!.status, "failed");
  assert.match(b.getOp(stale)!.error!, /stale/);
  assert.equal(b.getOp(fine)!.status, "batched");
  s.done();
});

test("batcher: single-op fallback runs executeDirect when batches cannot be submitted", async () => {
  const s = setup(1, { maxWaitMs: 0, fallbackMs: 30_000 });
  const b = s.make();
  const id = (await b.accept(sign(s.chain, 0, 0))).op.id;
  s.chain.failSubmit = true;
  await b.tick();
  assert.equal(b.getOp(id)!.status, "pending");
  assert.equal(b.getBatch("b0")!.status, "failed");
  s.clock.advance(30_000);
  await b.tick();
  const op = b.getOp(id)!;
  assert.equal(op.status, "executed");
  assert.equal(op.via, "direct");
  assert.equal(s.chain.accounts[0]!.nonce, 1n);
  assert.ok(existsSync(join(s.dir, "state.json")));
  s.done();
});

test("batcher: an op whose account moved on chain after finalize goes as a dead op; the rest still execute", async () => {
  const s = setup(3, { maxWaitMs: 0 });
  const b = s.make();
  const ids = [];
  for (const i of [0, 1, 2]) ids.push((await b.accept(sign(s.chain, i, 0))).op.id);
  await b.tick();
  assert.equal(b.getBatch("b0")!.status, "submitted");
  // Account 1's owner runs a different op at nonce 0 directly while the batch is in its window.
  s.chain.accounts[1]!.nonce = 1n;
  s.chain.accounts[1]!.pkHash = keygen(seedOf(1), 1).pkHash;
  s.chain.t += WINDOW;
  await b.tick();
  assert.equal(b.getBatch("b0")!.status, "executed");
  assert.deepEqual(ids.map((id) => b.getOp(id)!.status), ["executed", "failed", "executed"]);
  assert.match(b.getOp(ids[1]!)!.error!, /dead op/);
  assert.equal(s.chain.accounts[0]!.nonce, 1n);
  assert.equal(s.chain.accounts[2]!.nonce, 1n);
  s.done();
});
