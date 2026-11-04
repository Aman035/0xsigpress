// The batcher: accepts validated SigpressAccount ops, cuts them into OptimisticAggregator batches by size
// (maxOps) or age (maxWaitMs), submits root + bond, waits out the challenge window, finalizes, then runs
// the whole batch with one SigpressEntry.executeBundle(). State lives in <dir>/state.json (atomic writes);
// each batch's DA document in <dir>/da/<root>.json. Every tx is signed and persisted before broadcast, so
// a restart picks up exactly where it stopped (resend or read the receipt). tick() is the whole state
// machine; start() just calls it in a loop.
//
// Ordering rule: an account never has ops in two in-flight batches (later ops wait until the earlier batch
// executes), because the entry rebuilds each leaf from the account's on-chain key and nonce at execution.
// Chained ops of one account inside a single batch are fine (they run in order).
import { join } from "node:path";
import { keccak256, type Address, type Hex } from "viem";
import { payloadHash } from "../account.ts";
import { MerkleTree } from "../merkle.ts";
import { leafOf, messageOf } from "../op.ts";
import { verify } from "../wots.ts";
import type { ChainAdapter, TxOutcome } from "./chain.ts";
import type { DADoc } from "./da.ts";
import { readJson, writeJsonAtomic } from "./store.ts";
import type { BatchRecord, OpRecord, ServiceState, SignedTx } from "./types.ts";

export interface BatcherConfig {
  dir: string;
  /** Base URL the DA documents are served from; dataURI = `${publicUrl}/da/<root>`. */
  publicUrl: string;
  maxOps?: number; // MAX_OPS, default 64
  maxWaitMs?: number; // MAX_WAIT_MS, default 5000
  /** An op still unbatched this long after it was queued goes on chain via executeDirect. 0 disables. */
  fallbackMs?: number; // FALLBACK_MS, default 60000
  maxPending?: number; // default 10000
  receiptTimeoutMs?: number; // default 60000
  submitBackoffMs?: number; // after a failed submit, default 5000
  now?: () => number;
  log?: (msg: string) => void;
}

export interface OpInput {
  account?: Address;
  index?: number;
  target: Address;
  value: bigint;
  data: Hex;
  nextPkHash: Hex;
  sig: Hex;
}

export class RejectError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const ZERO32: Hex = `0x${"00".repeat(32)}`;
const LIVE = new Set(["pending", "batched", "finalized"]);
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export class Batcher {
  readonly state: ServiceState;
  readonly cfg: Required<Omit<BatcherConfig, "now" | "log">> & Pick<BatcherConfig, "now" | "log">;
  private readonly path: string;
  private accepting: Promise<unknown> = Promise.resolve();
  private ticking: Promise<void> | undefined;
  private loop: { stop: boolean; done: Promise<void> } | undefined;
  private lastSubmitFail = -Infinity;

  constructor(
    readonly chain: ChainAdapter,
    cfg: BatcherConfig,
  ) {
    this.cfg = {
      maxOps: 64,
      maxWaitMs: 5000,
      fallbackMs: 60_000,
      maxPending: 10_000,
      receiptTimeoutMs: 60_000,
      submitBackoffMs: 5000,
      ...cfg,
    };
    if (this.cfg.maxOps < 1) throw new Error("maxOps must be >= 1");
    this.path = join(cfg.dir, "state.json");
    const loaded = readJson<ServiceState>(this.path);
    if (loaded) {
      if (loaded.chainId !== chain.chainId || !eq(loaded.entry, chain.entry))
        throw new Error(`${this.path} belongs to chain ${loaded.chainId} entry ${loaded.entry}, not ${chain.chainId} ${chain.entry}`);
      this.state = loaded;
      const live = Object.values(loaded.ops).filter((o) => LIVE.has(o.status)).length;
      this.log(`resumed ${this.path}: ${Object.keys(loaded.ops).length} ops (${live} live), ${Object.keys(loaded.batchList).length} batches`);
    } else {
      this.state = { version: 1, chainId: chain.chainId, entry: chain.entry, batches: chain.batches, nextSeq: 0, nextBatch: 0, ops: {}, batchList: {} };
      this.save();
    }
  }

  private now() {
    return this.cfg.now ? this.cfg.now() : Date.now();
  }

  private log(msg: string) {
    (this.cfg.log ?? ((m: string) => console.log(`[service ${new Date().toISOString()}] ${m}`)))(msg);
  }

  private save() {
    writeJsonAtomic(this.path, this.state);
  }

  daPath(root: Hex) {
    return join(this.cfg.dir, "da", `${root.toLowerCase()}.json`);
  }

  getDA(root: Hex): DADoc | undefined {
    return readJson<DADoc>(this.daPath(root));
  }

  getOp(id: string): OpRecord | undefined {
    return this.state.ops[id.toLowerCase() as Hex];
  }

  /** By local key (b3), on-chain batch id (3) or root (0x...). */
  getBatch(id: string): BatchRecord | undefined {
    const all = Object.values(this.state.batchList);
    if (/^b\d+$/.test(id)) return this.state.batchList[id];
    if (/^\d+$/.test(id)) return all.find((b) => b.id === BigInt(id));
    if (/^0x[0-9a-fA-F]{64}$/.test(id)) return all.filter((b) => eq(b.root, id)).at(-1);
    return undefined;
  }

  private ops(filter: (o: OpRecord) => boolean): OpRecord[] {
    return Object.values(this.state.ops)
      .filter(filter)
      .sort((a, b) => a.seq - b.seq);
  }

  private inflightAccounts(): Set<string> {
    // An op being sent via executeDirect also blocks its account (its later ops chain from it).
    return new Set(this.ops((o) => o.status === "batched" || o.status === "finalized" || (o.status === "pending" && !!o.directTx)).map((o) => o.account.toLowerCase()));
  }

  // ---------------- accept ----------------

  /** Validate an op off chain and queue it. Serialised so two ops for one account get consecutive nonces. */
  accept(input: OpInput): Promise<{ op: OpRecord; duplicate: boolean }> {
    const run = this.accepting.then(() => this.acceptNow(input));
    this.accepting = run.catch(() => {});
    return run;
  }

  private async acceptNow(input: OpInput): Promise<{ op: OpRecord; duplicate: boolean }> {
    const c = this.chain;
    let index = input.index;
    if (index === undefined) {
      if (!input.account) throw new RejectError("need account or index");
      index = await c.findAccountIndex?.(input.account);
      if (index === undefined) throw new RejectError("could not resolve account index from logs; pass `index`");
    }
    const count = await c.accountCount();
    if (index < 0 || index >= count) throw new RejectError(`unknown account index ${index} (accountCount ${count})`);
    const account = await c.accountOf(index);
    if (input.account && !eq(input.account, account)) throw new RejectError(`account ${input.account} is not index ${index} (${account})`);
    if (eq(input.nextPkHash, ZERO32)) throw new RejectError("nextPkHash is zero; that would lock the account");

    // Expected key and nonce: after this account's last live op in the service, else the chain's.
    const sigHash = keccak256(input.sig);
    const dup = this.ops((o) => o.sigHash === sigHash && eq(o.account, account))[0];
    if (dup) return { op: dup, duplicate: true };
    const live = this.ops((o) => eq(o.account, account) && LIVE.has(o.status)).at(-1);
    let pkHash: Hex, nonce: bigint;
    if (live) {
      pkHash = live.nextPkHash;
      nonce = live.nonce + 1n;
    } else {
      ({ pkHash, nonce } = await c.accountState(account));
      if (eq(pkHash, ZERO32)) throw new RejectError("account has no key");
    }
    const call = { target: input.target, value: input.value, data: input.data };
    const m = messageOf(c.chainId, c.entry, pkHash, input.nextPkHash, payloadHash(account, nonce, call));
    if (!verify(pkHash, m, input.sig)) throw new RejectError(`invalid WOTS signature for account ${index} at nonce ${nonce} (key ${pkHash})`);
    const id = leafOf(pkHash, m, input.sig).toLowerCase() as Hex;
    if (this.state.ops[id]) return { op: this.state.ops[id]!, duplicate: true };
    const pendingCount = this.ops((o) => o.status === "pending").length;
    if (pendingCount >= this.cfg.maxPending) throw new RejectError("queue full", 503);

    const now = this.now();
    const op: OpRecord = {
      id,
      seq: this.state.nextSeq++,
      accountIndex: index,
      account,
      nonce,
      pkHash,
      nextPkHash: input.nextPkHash,
      ...call,
      m,
      sig: input.sig,
      sigHash,
      status: "pending",
      acceptedAt: now,
      queuedAt: now,
    };
    this.state.ops[id] = op;
    this.save();
    this.log(`accepted op ${id.slice(0, 10)} account ${index} nonce ${nonce}`);
    return { op, duplicate: false };
  }

  // ---------------- state machine ----------------

  /** One pass of the state machine. Concurrent calls share the running pass. */
  tick(): Promise<void> {
    if (!this.ticking) {
      this.ticking = this.tickNow().finally(() => {
        this.ticking = undefined;
      });
    }
    return this.ticking;
  }

  private async tickNow() {
    for (const b of Object.values(this.state.batchList)) {
      try {
        await this.advance(b);
      } catch (e) {
        this.log(`batch ${b.key}: ${(e as Error).message}`);
      }
    }
    await this.cut();
    await this.fallback();
  }

  start(intervalMs = 500) {
    if (this.loop) return;
    const loop = { stop: false, done: Promise.resolve() };
    loop.done = (async () => {
      while (!loop.stop) {
        try {
          await this.tick();
        } catch (e) {
          this.log(`tick: ${(e as Error).message}`);
        }
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    })();
    this.loop = loop;
  }

  async stop() {
    if (!this.loop) return;
    this.loop.stop = true;
    await this.loop.done;
    this.loop = undefined;
  }

  /**
   * Send a tx with its signed form persisted first. If one is already persisted (restart), look for its
   * receipt, resend it if missing. Returns undefined if not mined within the timeout (retry next tick).
   */
  private async send(slot: { tx?: SignedTx }, make: () => Promise<SignedTx>): Promise<TxOutcome | undefined> {
    const c = this.chain;
    if (slot.tx) {
      const o = await c.outcome(slot.tx.hash, 1000);
      if (o) return o;
      try {
        await c.broadcast(slot.tx);
      } catch (e) {
        this.log(`resend ${slot.tx.hash} failed (${(e as Error).message.split("\n")[0]}); will re-sign`);
        slot.tx = undefined;
        this.save();
        return undefined;
      }
      return c.outcome(slot.tx.hash, this.cfg.receiptTimeoutMs);
    }
    slot.tx = await make();
    this.save();
    await c.broadcast(slot.tx);
    return c.outcome(slot.tx.hash, this.cfg.receiptTimeoutMs);
  }

  private slot<K extends "submitTx" | "finalizeTx" | "executeTx">(b: BatchRecord, k: K) {
    return {
      get tx() {
        return b[k];
      },
      set tx(v: SignedTx | undefined) {
        b[k] = v;
      },
    };
  }

  private setOps(b: BatchRecord, patch: Partial<OpRecord>) {
    for (const id of b.opIds) Object.assign(this.state.ops[id as Hex]!, patch);
  }

  /** Put a batch's ops back in the queue; cut() re-checks them against the chain before re-batching. */
  private requeue(b: BatchRecord, why: string) {
    for (const id of b.opIds) {
      const o = this.state.ops[id as Hex]!;
      if (o.status === "executed" || o.status === "failed") continue;
      // queuedAt is kept: the fallback clock keeps running from when the op was first queued.
      Object.assign(o, { status: "pending", batchKey: undefined, error: `requeued: ${why}` });
    }
  }

  private async advance(b: BatchRecord) {
    const c = this.chain;
    if (b.status === "built") {
      let o: TxOutcome | undefined;
      try {
        o = await this.send(this.slot(b, "submitTx"), () => c.signSubmit(b.root, b.opIds.length, `${this.cfg.publicUrl.replace(/\/$/, "")}/da/${b.root}`));
      } catch (e) {
        if (b.submitTx) throw e; // broadcast state unknown; retry next tick
        b.status = "failed";
        b.error = `submit: ${(e as Error).message.split("\n")[0]}`;
        this.requeue(b, b.error);
        this.lastSubmitFail = this.now();
        this.save();
        this.log(`batch ${b.key} ${b.error}`);
        return;
      }
      if (!o) return;
      if (o.status !== "success" || !o.submitted) {
        b.status = "failed";
        b.error = "submitBatch reverted";
        this.requeue(b, b.error);
        this.lastSubmitFail = this.now();
      } else {
        b.id = o.submitted.id;
        b.deadline = (await c.batchInfo(b.id)).deadline;
        b.status = "submitted";
        this.log(`batch ${b.key} submitted as id ${b.id} (${b.opIds.length} ops), tx ${b.submitTx!.hash}, deadline ${b.deadline}`);
      }
      this.save();
    }
    if (b.status === "submitted") {
      const info = await c.batchInfo(b.id!);
      if (info.slashed) {
        b.status = "slashed";
        this.requeue(b, "batch slashed");
        this.save();
        this.log(`batch ${b.key} (id ${b.id}) was SLASHED; ops requeued`);
        return;
      }
      if (!info.finalized) {
        if ((await c.timestamp()) < info.deadline) return;
        const o = await this.send(this.slot(b, "finalizeTx"), () => c.signFinalize(b.id!));
        if (!o) return;
        if (o.status !== "success") {
          // Someone else may have finalized it (finalize is permissionless) or it was slashed at the edge.
          const again = await c.batchInfo(b.id!);
          if (!again.finalized) {
            b.finalizeTx = undefined;
            this.save();
            throw new Error(`finalize reverted (slashed ${again.slashed})`);
          }
        }
      }
      b.status = "finalized";
      this.setOps(b, { status: "finalized" });
      this.save();
      this.log(`batch ${b.key} (id ${b.id}) finalized`);
    }
    if (b.status === "finalized") {
      const bundle = b.opIds.map((id) => this.state.ops[id as Hex]!);
      let o: TxOutcome | undefined;
      if (!b.executeTx && (await c.bundleExecuted(b.id!))) {
        o = { status: "success", gasUsed: 0n }; // executed by someone else (anyone can, from the DA data)
      } else {
        if (!b.executeTx) {
          const why = await c.simulateBundle(b.id!, bundle);
          if (why) {
            b.status = "failed";
            b.error = `executeBundle would revert: ${why}`;
            this.requeue(b, b.error);
            this.save();
            this.log(`batch ${b.key} (id ${b.id}) ${b.error}; ops requeued`);
            return;
          }
        }
        o = await this.send(this.slot(b, "executeTx"), () => c.signBundle(b.id!, bundle));
        if (!o) return;
        if (o.status !== "success") {
          if (await c.bundleExecuted(b.id!)) o = { status: "success", gasUsed: 0n };
          else {
            b.executeTx = undefined;
            this.save();
            throw new Error("executeBundle reverted; will re-simulate");
          }
        }
      }
      const ev = o.executed ?? [];
      for (const op of bundle) {
        const e = ev.find((x) => eq(x.account, op.account) && x.nonce === op.nonce);
        Object.assign(op, { status: "executed", via: "bundle", txHash: b.executeTx?.hash, callSuccess: e ? e.success : undefined });
      }
      b.status = "executed";
      this.save();
      this.log(`batch ${b.key} (id ${b.id}) executed in one tx ${b.executeTx?.hash ?? "(by someone else)"}, gasUsed ${o.gasUsed}`);
    }
  }

  /** Keep, in order, the ops of one account that chain from its current on-chain key; fail the rest. */
  private async checkFresh(acctOps: OpRecord[]): Promise<OpRecord[]> {
    let { pkHash, nonce } = await this.chain.accountState(acctOps[0]!.account);
    const ok: OpRecord[] = [];
    for (const o of acctOps) {
      if (o.nonce === nonce && eq(o.pkHash, pkHash)) {
        ok.push(o);
        pkHash = o.nextPkHash;
        nonce += 1n;
      } else {
        Object.assign(o, { status: "failed", error: `stale: account is at nonce ${nonce} key ${pkHash.slice(0, 10)}, op was for nonce ${o.nonce}` });
        this.log(`op ${o.id.slice(0, 10)} failed: ${o.error}`);
      }
    }
    return ok;
  }

  private async cut() {
    const now = this.now();
    if (now - this.lastSubmitFail < this.cfg.submitBackoffMs) return;
    for (;;) {
      const inflight = this.inflightAccounts();
      const cands = this.ops((o) => o.status === "pending" && !o.directTx && !inflight.has(o.account.toLowerCase()));
      if (!cands.length) return;
      const oldest = Math.min(...cands.map((o) => o.queuedAt));
      if (cands.length < this.cfg.maxOps && now - oldest < this.cfg.maxWaitMs) return;

      // Take up to maxOps in acceptance order (a prefix of each account's chain), re-checked on chain.
      const byAcct = new Map<string, OpRecord[]>();
      for (const o of cands) {
        const k = o.account.toLowerCase();
        if (!byAcct.has(k)) byAcct.set(k, []);
        byAcct.get(k)!.push(o);
      }
      const fresh = new Set<OpRecord>();
      let n = 0;
      for (const o of cands) {
        if (n >= this.cfg.maxOps) break;
        const k = o.account.toLowerCase();
        const group = byAcct.get(k);
        if (!group) continue;
        byAcct.delete(k);
        for (const f of await this.checkFresh(group)) fresh.add(f);
        n = fresh.size;
      }
      const chosen = cands.filter((o) => fresh.has(o)).slice(0, this.cfg.maxOps);
      if (!chosen.length) {
        this.save();
        continue;
      }
      // Within one account the chosen ops must be a prefix of its chain (slice may cut the last account).
      const tree = new MerkleTree(chosen.map((o) => o.id));
      const b: BatchRecord = { key: `b${this.state.nextBatch++}`, root: tree.root, status: "built", opIds: chosen.map((o) => o.id), createdAt: now };
      const da: DADoc = {
        version: 1,
        root: tree.root,
        count: chosen.length,
        chainId: this.chain.chainId,
        aggregator: this.chain.batches,
        entry: this.chain.entry,
        leaves: chosen.map((o, index) => ({
          index,
          pkHash: o.pkHash,
          m: o.m,
          sig: o.sig,
          accountIndex: o.accountIndex,
          account: o.account,
          nonce: o.nonce.toString(),
          target: o.target,
          value: o.value.toString(),
          data: o.data,
          nextPkHash: o.nextPkHash,
        })),
      };
      // DA first: it must be servable before the BatchSubmitted event exists.
      writeJsonAtomic(this.daPath(tree.root), da);
      for (const o of chosen) Object.assign(o, { status: "batched", batchKey: b.key, error: undefined });
      this.state.batchList[b.key] = b;
      this.save();
      this.log(`cut batch ${b.key}: ${chosen.length} ops, root ${tree.root}`);
      try {
        await this.advance(b);
      } catch (e) {
        this.log(`batch ${b.key}: ${(e as Error).message.split("\n")[0]} (retrying next tick)`);
        return;
      }
      if (b.status !== "submitted") return;
    }
  }

  private async fallback() {
    const now = this.now();
    const inflight = this.inflightAccounts();
    const seen = new Set<string>();
    for (const o of this.ops((x) => x.status === "pending")) {
      const k = o.account.toLowerCase();
      if (seen.has(k)) continue; // only the first queued op of each account can run directly
      seen.add(k);
      if (!o.directTx) {
        if (this.cfg.fallbackMs <= 0 || now - o.queuedAt < this.cfg.fallbackMs || inflight.has(k)) continue;
        if (!(await this.checkFresh([o])).length) {
          this.save();
          continue;
        }
        this.log(`op ${o.id.slice(0, 10)} unbatched for ${now - o.queuedAt} ms; single-op fallback executeDirect`);
      }
      const slot = {
        get tx() {
          return o.directTx;
        },
        set tx(v) {
          o.directTx = v;
        },
      };
      let out: TxOutcome | undefined;
      try {
        out = await this.send(slot, () => this.chain.signDirect(o));
      } catch (e) {
        this.log(`executeDirect ${o.id.slice(0, 10)}: ${(e as Error).message.split("\n")[0]}`);
        continue;
      }
      if (!out) continue;
      if (out.status === "success") {
        const e = out.executed?.find((x) => eq(x.account, o.account));
        Object.assign(o, { status: "executed", via: "direct", txHash: o.directTx!.hash, callSuccess: e?.success, error: undefined });
        this.log(`op ${o.id.slice(0, 10)} executed directly, tx ${o.directTx!.hash}`);
      } else {
        Object.assign(o, { status: "failed", error: "executeDirect reverted", txHash: o.directTx!.hash });
      }
      this.save();
    }
  }

  /** Public view of an op. */
  view(o: OpRecord) {
    const b = o.batchKey ? this.state.batchList[o.batchKey] : undefined;
    return {
      id: o.id,
      status: o.status,
      account: o.account,
      accountIndex: o.accountIndex,
      nonce: o.nonce.toString(),
      via: o.via,
      txHash: o.txHash,
      callSuccess: o.callSuccess,
      error: o.error,
      batch: b ? { key: b.key, id: b.id?.toString(), status: b.status, root: b.root, deadline: b.deadline?.toString() } : undefined,
    };
  }

  viewBatch(b: BatchRecord) {
    return {
      key: b.key,
      id: b.id?.toString(),
      status: b.status,
      root: b.root,
      count: b.opIds.length,
      deadline: b.deadline?.toString(),
      submitTx: b.submitTx?.hash,
      finalizeTx: b.finalizeTx?.hash,
      executeTx: b.executeTx?.hash,
      error: b.error,
      ops: b.opIds,
      da: `/da/${b.root}`,
    };
  }
}
