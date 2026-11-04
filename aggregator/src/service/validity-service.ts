// Aggregator service, validity mode (MODE=validity): the trustless STARK path.
//
// Users own ValidityAccounts (contracts/src/ValidityEntry.sol), each bound at creation to one leanXMSS public key.
// A user signs ITS OWN op: message = ValidityEntry.opHash(account, nonce, target, value, data), at the service's
// current slot (GET /validity). The service checks each op off chain (registry key, nonce, signature), collects up to
// 2 x N ops for that slot (N = the deployed verifier's batch size: 256 or 1024), pads the rest with its own filler
// signers, proves the two batches into one terminal STARK (binding v2, under the shared prover lock), submits it to
// SigpressBindV2Gate, then runs the ops with ValidityEntry.execute. Nothing is trusted: the gate checks the proof
// against every (pubkey, message), and the entry checks each op's (pubkey, message) is in the accepted batch.
//
// Every signer of one proof must sign the same slot, so a slot is open until its batch is cut; then the slot
// advances and ops must be signed at the new one (a stale slot is rejected with 409). One op per account per slot.
// State: <dir>/state.json (atomic writes); per batch <dir>/batches/<key>/ (batch files, proof, statement).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { encodeFunctionData, getAddress, isAddress, isHex, keccak256, parseEventLogs, size, toBytes, type Address, type Hash, type Hex } from "viem";
import { AGG_DIR, getClients } from "../chain.ts";
import { leanxmssLoadKey, leanxmssVerify, LEANXMSS_SCHEME, LEANXMSS_SIG_BYTES, type LeanXmssSignature } from "../sdk/leanxmss.ts";
import {
  exportBatches,
  gateV2Abi,
  gatePubkeyOf,
  loadShape,
  makeSdkKeys,
  parseShape,
  proveV2,
  readProof,
  send,
  signAll,
  submitProofV2,
  validityEntryAbi,
  validityOpHash,
  type SdkSigner,
  type Shape,
  type ShapeTarget,
} from "../validity.ts";
import { readJson, toJson, writeJsonAtomic } from "./store.ts";

type Clients = Awaited<ReturnType<typeof getClients>>;

export type VOpStatus = "pending" | "batched" | "proving" | "accepted" | "executed" | "failed";
export type VBatchStatus = "cut" | "signed" | "proved" | "accepted" | "executed" | "failed";

export interface VOp {
  id: Hex; // = message (op hash); unique per (entry, account, nonce, call)
  seq: number;
  account: Address;
  nonce: bigint;
  target: Address;
  value: bigint;
  data: Hex;
  publicKey: Hex; // SSZ
  gatePubkey: Hex;
  slot: number;
  signature: Hex;
  status: VOpStatus;
  acceptedAt: number;
  batchKey?: string;
  side?: 0 | 1;
  index?: number;
  callSuccess?: boolean;
  error?: string;
}

export interface VBatch {
  key: string;
  slot: number;
  status: VBatchStatus;
  opIds: Hex[];
  fillers: number;
  createdAt: number;
  commitment?: Hex;
  submitTx?: Hash;
  executeTx?: Hash;
  gasCharged?: { submit?: number; execute?: number };
  proveSeconds?: number;
  error?: string;
}

export interface VState {
  version: 1;
  mode: "validity";
  chainId: number;
  entry: Address;
  gate: Address;
  shape: Shape;
  slot: number; // the open slot
  nextSeq: number;
  nextBatch: number;
  ops: Record<Hex, VOp>;
  batches: Record<string, VBatch>;
}

export class RejectError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface ValidityConfig {
  dir: string;
  target: ShapeTarget;
  entry: Address;
  maxWaitMs?: number; // cut a non-full batch when its oldest op is this old (default 20000)
  startSlot?: number; // first slot of a fresh state (default 1)
  fillerLogSlots?: number; // filler keys sign 2^this slots (default 10)
  concurrency?: number; // parallel CLI signs (default 8)
  log?: (s: string) => void;
}

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export class ValidityService {
  readonly state: VState;
  readonly cfg: Required<Omit<ValidityConfig, "log">> & Pick<ValidityConfig, "log">;
  private readonly path: string;
  private accepting: Promise<unknown> = Promise.resolve();
  private loop: { stop: boolean; done: Promise<void> } | undefined;
  private fillers: SdkSigner[] | undefined;

  constructor(
    readonly c: Clients,
    cfg: ValidityConfig,
  ) {
    this.cfg = { maxWaitMs: 20_000, startSlot: 1, fillerLogSlots: 10, concurrency: 8, ...cfg };
    this.path = join(cfg.dir, "state.json");
    const loaded = readJson<VState>(this.path);
    if (loaded) {
      if (loaded.chainId !== c.chainId || !eq(loaded.entry, cfg.entry) || loaded.shape !== cfg.target.shape)
        throw new Error(`${this.path} belongs to chain ${loaded.chainId} entry ${loaded.entry} ${loaded.shape}`);
      this.state = loaded;
      this.log(`resumed ${this.path}: slot ${loaded.slot}, ${Object.keys(loaded.ops).length} ops, ${Object.keys(loaded.batches).length} batches`);
    } else {
      this.state = { version: 1, mode: "validity", chainId: c.chainId, entry: cfg.entry, gate: cfg.target.gate, shape: cfg.target.shape, slot: this.cfg.startSlot, nextSeq: 0, nextBatch: 0, ops: {}, batches: {} };
      this.save();
    }
  }

  get capacity() {
    return 2 * this.cfg.target.perChild;
  }

  private log(s: string) {
    (this.cfg.log ?? ((m: string) => console.log(`[validity ${new Date().toISOString()}] ${m}`)))(s);
  }

  private save() {
    writeJsonAtomic(this.path, this.state);
  }

  private ops(f: (o: VOp) => boolean) {
    return Object.values(this.state.ops)
      .filter(f)
      .sort((a, b) => a.seq - b.seq);
  }

  info() {
    return { mode: "validity", chainId: this.state.chainId, entry: this.state.entry, gate: this.state.gate, shape: this.state.shape, slot: this.state.slot, capacity: this.capacity, queued: this.ops((o) => o.status === "pending").length };
  }

  // ---------------- accept ----------------

  accept(input: VOpInput): Promise<{ op: VOp; duplicate: boolean }> {
    const run = this.accepting.then(() => this.acceptNow(input));
    this.accepting = run.catch(() => {});
    return run;
  }

  private async acceptNow(input: VOpInput): Promise<{ op: VOp; duplicate: boolean }> {
    const { publicClient } = this.c;
    const entry = this.state.entry;
    if (input.slot !== this.state.slot) throw new RejectError(`slot ${input.slot} is not open; sign at slot ${this.state.slot} (GET /validity)`, 409);
    const gatePubkey = gatePubkeyOf({ publicKey: input.publicKey });
    const registered = await publicClient.readContract({ address: entry, abi: validityEntryAbi, functionName: "keyOf", args: [input.account] });
    if (!eq(registered, gatePubkey)) throw new RejectError(`account ${input.account} is not bound to this public key (registry has ${registered})`);
    const onchain = await publicClient.readContract({ address: entry, abi: validityEntryAbi, functionName: "nonceOf", args: [input.account] });
    const live = this.ops((o) => eq(o.account, input.account) && ["pending", "batched", "proving", "accepted"].includes(o.status));
    const expected = live.length ? live.at(-1)!.nonce + 1n : onchain;
    const nonce = input.nonce ?? expected;
    const message = validityOpHash({ chainId: this.state.chainId, entry, account: input.account, nonce, target: input.target, value: input.value, data: input.data });
    const dup = this.state.ops[message.toLowerCase() as Hex];
    if (dup && dup.status !== "failed") return { op: dup, duplicate: true }; // a failed op may be re-signed at a new slot
    if (nonce !== expected) throw new RejectError(`nonce ${nonce} is not the account's next (${expected})`);
    if (live.some((o) => o.slot === input.slot)) throw new RejectError(`account already has an op at slot ${input.slot}; one op per account per slot`, 409);
    if (this.ops((o) => o.slot === input.slot && eq(o.gatePubkey, gatePubkey)).length) throw new RejectError("this key already signed at this slot");
    if (!leanxmssVerify(input.publicKey, input.slot, message, input.signature)) throw new RejectError(`invalid leanXMSS signature over the op hash ${message} at slot ${input.slot}`);
    if (this.ops((o) => o.slot === input.slot && o.status === "pending").length >= this.capacity) throw new RejectError(`slot ${input.slot} is full (${this.capacity}); wait for the next slot`, 503);
    const op: VOp = {
      id: message.toLowerCase() as Hex,
      seq: this.state.nextSeq++,
      account: getAddress(input.account),
      nonce,
      target: input.target,
      value: input.value,
      data: input.data,
      publicKey: input.publicKey.toLowerCase() as Hex,
      gatePubkey,
      slot: input.slot,
      signature: input.signature,
      status: "pending",
      acceptedAt: Date.now(),
    };
    this.state.ops[op.id] = op;
    this.save();
    this.log(`accepted op ${op.id.slice(0, 10)}… account ${op.account} nonce ${nonce} slot ${op.slot}`);
    return { op, duplicate: false };
  }

  view(o: VOp) {
    const b = o.batchKey ? this.state.batches[o.batchKey] : undefined;
    return { id: o.id, status: o.status, account: o.account, nonce: o.nonce, slot: o.slot, side: o.side, index: o.index, callSuccess: o.callSuccess, error: o.error, batch: b && this.viewBatch(b) };
  }

  viewBatch(b: VBatch) {
    return { key: b.key, slot: b.slot, status: b.status, ops: b.opIds.length, fillers: b.fillers, commitment: b.commitment, submitTx: b.submitTx, executeTx: b.executeTx, gasCharged: b.gasCharged, proveSeconds: b.proveSeconds, error: b.error };
  }

  // ---------------- state machine ----------------

  start(tickMs = 1000) {
    const loop = { stop: false, done: Promise.resolve() };
    loop.done = (async () => {
      while (!loop.stop) {
        try {
          await this.tick();
        } catch (e) {
          this.log(`tick error: ${(e as Error).message.split("\n")[0]}`);
        }
        await new Promise((r) => setTimeout(r, tickMs));
      }
    })();
    this.loop = loop;
  }

  async stop() {
    if (this.loop) {
      this.loop.stop = true;
      await this.loop.done;
    }
  }

  /** One step: cut a batch if due, then drive every unfinished batch forward (one at a time, in order). */
  async tick() {
    const pending = this.ops((o) => o.status === "pending" && o.slot === this.state.slot);
    const due = pending.length >= this.capacity || (pending.length > 0 && Date.now() - pending[0]!.acceptedAt >= this.cfg.maxWaitMs);
    if (due) this.cut(pending.slice(0, this.capacity));
    for (const b of Object.values(this.state.batches).sort((x, y) => x.createdAt - y.createdAt)) {
      if (b.status === "executed" || b.status === "failed") continue;
      await this.advance(b);
      return; // one batch in flight at a time (proofs are serialised by the lock anyway)
    }
  }

  private cut(ops: VOp[]) {
    const key = `v${this.state.nextBatch++}`;
    const b: VBatch = { key, slot: this.state.slot, status: "cut", opIds: ops.map((o) => o.id), fillers: this.capacity - ops.length, createdAt: Date.now() };
    for (const o of ops) {
      o.status = "batched";
      o.batchKey = key;
    }
    this.state.batches[key] = b;
    this.state.slot += 1; // close the slot before anything else: later ops must sign the next one
    this.save();
    this.log(`cut batch ${key}: ${ops.length} ops + ${b.fillers} filler signers at slot ${b.slot}; slot ${this.state.slot} now open`);
  }

  private batchDir(b: VBatch) {
    return resolve(this.cfg.dir, "batches", b.key);
  }

  private async fillerPool(): Promise<SdkSigner[]> {
    if (this.fillers) return this.fillers;
    const dir = resolve(this.cfg.dir, "fillers");
    const n = this.capacity;
    const signers: SdkSigner[] = [];
    for (let k = 0; k < n; k++) {
      const keyPath = resolve(dir, `filler-${k}.key.json`);
      if (!existsSync(keyPath)) break;
      signers.push({ key: leanxmssLoadKey(keyPath), statePath: resolve(dir, `filler-${k}.state.json`) });
    }
    if (signers.length < n) {
      this.log(`creating ${n - signers.length} filler keys (one-time) ...`);
      const { signers: more } = await makeSdkKeys(dir, n, { prefix: "filler", logSlots: this.cfg.fillerLogSlots, concurrency: this.cfg.concurrency, skip: signers.length });
      signers.push(...more);
    }
    this.fillers = signers;
    return signers;
  }

  private async advance(b: VBatch) {
    const dir = this.batchDir(b);
    const ops = b.opIds.map((id) => this.state.ops[id]!);
    try {
      if (b.status === "cut") {
        mkdirSync(dir, { recursive: true });
        // Fillers: service keys over throwaway messages at this slot (KeyStore refuses a reused slot).
        const pool = (await this.fillerPool()).slice(0, b.fillers);
        const fsigs = await signAll(pool.map((signer, i) => ({ signer, message: keccak256(toBytes(`sigpress-filler|${this.state.entry}|${b.slot}|${i}`)) })), b.slot, this.cfg.concurrency);
        const user: LeanXmssSignature[] = ops.map((o) => ({ scheme: LEANXMSS_SCHEME, publicKey: o.publicKey, slot: o.slot, index: 0, message: o.id, signature: o.signature }));
        const all = [...user, ...fsigs];
        const n = this.cfg.target.perChild;
        exportBatches(dir, all.slice(0, n), all.slice(n));
        b.status = "signed";
        this.save();
        this.log(`batch ${b.key}: ${fsigs.length} filler signatures, batch files written`);
      }
      if (b.status === "signed") {
        for (const o of ops) o.status = "proving";
        this.save();
        const meta = await proveV2({ outDir: dir, target: this.cfg.target, batches: { left: resolve(dir, "batch-left.json"), right: resolve(dir, "batch-right.json") }, log: (s) => this.log(`batch ${b.key}: ${s}`) });
        if (meta.slot !== b.slot) throw new Error(`proof slot ${meta.slot} != batch slot ${b.slot}`);
        b.commitment = meta.commitment;
        b.proveSeconds = meta.proveSeconds;
        b.status = "proved";
        this.save();
        this.log(`batch ${b.key}: proved in ${meta.proveSeconds} s, commitment ${meta.commitment}`);
      }
      if (b.status === "proved") {
        const { publicClient } = this.c;
        const already = await publicClient.readContract({ address: this.state.gate, abi: gateV2Abi, functionName: "accepted", args: [b.commitment!] });
        if (!already) {
          const v = await submitProofV2(this.c, dir, this.cfg.target, (s) => this.log(`batch ${b.key}: ${s}`), { negatives: [] });
          b.submitTx = v.txHash;
          b.gasCharged = { ...b.gasCharged, submit: v.gasCharged };
          this.log(`batch ${b.key}: gate.submit ${v.txHash} (${v.gasCharged} gas charged)`);
        }
        b.status = "accepted";
        for (const o of ops) o.status = "accepted";
        this.save();
      }
      if (b.status === "accepted") await this.execute(b, ops);
    } catch (e) {
      const msg = (e as Error).message.split("\n")[0]!;
      b.error = msg;
      this.log(`batch ${b.key} (${b.status}): ${msg}`);
      if (b.status === "cut" || b.status === "signed") {
        // Can't prove these signatures (e.g. prover failure): fail the batch; users re-sign at a new slot.
        b.status = "failed";
        for (const o of ops) Object.assign(o, { status: "failed", error: `batch ${b.key}: ${msg}` });
      }
      this.save();
      throw e;
    }
  }

  private async execute(b: VBatch, ops: VOp[]) {
    const { publicClient } = this.c;
    const { statement: st } = readProof(this.batchDir(b));
    const sides = [st.left, st.right] as const;
    const live: VOp[] = [];
    for (const o of ops) {
      if (o.status === "executed" || o.status === "failed") continue;
      const nonce = await publicClient.readContract({ address: this.state.entry, abi: validityEntryAbi, functionName: "nonceOf", args: [o.account] });
      if (nonce > o.nonce) {
        Object.assign(o, { status: "executed", error: "nonce already used on chain (executed by someone else)" });
        continue;
      }
      if (nonce < o.nonce) continue; // an earlier op of this account is not done yet; next tick
      let found: { side: 0 | 1; index: number } | undefined;
      for (const s of [0, 1] as const) {
        const i = sides[s].pubkeys.findIndex((pk, k) => eq(pk, o.gatePubkey) && eq(sides[s].messages[k]!, o.id));
        if (i >= 0) found = { side: s, index: i };
      }
      if (!found) throw new Error(`op ${o.id} not found in the proven statement`);
      Object.assign(o, found);
      live.push(o);
    }
    if (live.length) {
      const strip = (s: (typeof sides)[number]) => ({ pubkeys: s.pubkeys, messages: s.messages });
      const args = [st.slot, strip(st.left), strip(st.right), live.map((o) => ({ account: o.account, nonce: o.nonce, target: o.target, value: o.value, data: o.data, side: o.side!, index: o.index! }))] as const;
      const data = encodeFunctionData({ abi: validityEntryAbi, functionName: "execute", args });
      const r = await send(this.c, this.state.entry, data);
      b.executeTx = r.hash;
      b.gasCharged = { ...b.gasCharged, execute: Number(r.receipt.gasUsed) };
      const evs = parseEventLogs({ abi: validityEntryAbi, logs: r.receipt.logs, eventName: "OpExecuted" });
      for (const o of live) {
        const ev = evs.find((e) => eq(e.args.account, o.account) && e.args.nonce === o.nonce);
        Object.assign(o, { status: "executed", callSuccess: ev?.args.success });
      }
      this.log(`batch ${b.key}: ValidityEntry.execute ${r.hash} ran ${live.length} ops (${r.receipt.gasUsed} gas charged)`);
    }
    if (ops.every((o) => o.status === "executed" || o.status === "failed")) b.status = "executed";
    this.save();
  }
}

// ---------------- HTTP ----------------

export interface VOpInput {
  account: Address;
  nonce?: bigint;
  target: Address;
  value: bigint;
  data: Hex;
  publicKey: Hex;
  slot: number;
  signature: Hex;
}

export function parseVOpInput(body: unknown): VOpInput {
  const b = body as Record<string, unknown>;
  if (!b || typeof b !== "object") throw new RejectError("body must be a JSON object");
  const addr = (k: string): Address => {
    const v = b[k];
    if (typeof v !== "string" || !isAddress(v, { strict: false })) throw new RejectError(`${k} must be an address`);
    return getAddress(v);
  };
  const hex = (k: string, bytes?: number): Hex => {
    const v = b[k] ?? (k === "data" ? "0x" : undefined);
    if (typeof v !== "string" || !isHex(v) || v.length % 2) throw new RejectError(`${k} must be 0x-hex`);
    if (bytes !== undefined && size(v) !== bytes) throw new RejectError(`${k} must be ${bytes} bytes`);
    return v.toLowerCase() as Hex;
  };
  const big = (k: string, d?: bigint): bigint => {
    const v = b[k];
    if (v === undefined && d !== undefined) return d;
    try {
      if (typeof v !== "string" && !(typeof v === "number" && Number.isSafeInteger(v))) throw new Error();
      const x = BigInt(v);
      if (x < 0n || x >= 2n ** 256n) throw new Error();
      return x;
    } catch {
      throw new RejectError(`${k} must be a decimal or 0x string`);
    }
  };
  const slot = Number(b.slot);
  if (!Number.isInteger(slot) || slot < 0 || slot > 0xffffffff) throw new RejectError("slot must be a uint32");
  const data = hex("data");
  if (size(data) > 0xffff) throw new RejectError("data > 65535 bytes");
  return {
    account: addr("account"),
    nonce: b.nonce === undefined ? undefined : big("nonce"),
    target: addr("target"),
    value: big("value", 0n),
    data,
    publicKey: hex("publicKey", 32),
    slot,
    signature: hex("signature", LEANXMSS_SIG_BYTES),
  };
}

function reply(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" });
  res.end(toJson(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const ch of req) {
    n += (ch as Buffer).length;
    if (n > 256 * 1024) throw new RejectError("body too large", 413);
    chunks.push(ch as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RejectError("body is not JSON");
  }
}

export function validityHandler(svc: ValidityService) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", "http://x");
      const parts = url.pathname.split("/").filter(Boolean);
      if (req.method === "OPTIONS") return reply(res, 204, {});
      if (req.method === "POST" && url.pathname === "/ops") {
        const { op, duplicate } = await svc.accept(parseVOpInput(await readBody(req)));
        return reply(res, duplicate ? 200 : 202, svc.view(op));
      }
      if (req.method !== "GET") return reply(res, 405, { error: "method not allowed" });
      if (url.pathname === "/validity" || url.pathname === "/health") {
        const counts: Record<string, number> = {};
        for (const o of Object.values(svc.state.ops)) counts[o.status] = (counts[o.status] ?? 0) + 1;
        return reply(res, 200, { ok: true, ...svc.info(), sender: svc.c.account.address, ops: counts, batches: Object.keys(svc.state.batches).length });
      }
      if (parts[0] === "ops" && parts.length === 2) {
        const op = svc.state.ops[parts[1]!.toLowerCase() as Hex];
        return op ? reply(res, 200, svc.view(op)) : reply(res, 404, { error: "unknown op" });
      }
      if (parts[0] === "batches" && parts.length === 2) {
        const b = svc.state.batches[parts[1]!];
        return b ? reply(res, 200, svc.viewBatch(b)) : reply(res, 404, { error: "unknown batch" });
      }
      return reply(res, 404, { error: "not found" });
    } catch (e) {
      if (e instanceof RejectError) return reply(res, e.status, { error: e.message });
      console.error(e);
      return reply(res, 500, { error: (e as Error).message.split("\n")[0] });
    }
  };
}

export interface ValidityServiceHandle {
  url: string;
  svc: ValidityService;
  server: Server;
  close(): Promise<void>;
}

export async function startValidityService(opts: { c: Clients; cfg: ValidityConfig; port?: number; host?: string; tickMs?: number }): Promise<ValidityServiceHandle> {
  const host = opts.host ?? "127.0.0.1";
  const svc = new ValidityService(opts.c, opts.cfg);
  const server = createServer((req, res) => void validityHandler(svc)(req, res));
  await new Promise<void>((r) => server.listen(opts.port ?? 0, host, r));
  const a = server.address();
  const url = `http://${host}:${typeof a === "object" && a ? a.port : opts.port}`;
  svc.start(opts.tickMs ?? 1000);
  return {
    url,
    svc,
    server,
    async close() {
      await svc.stop();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** `MODE=validity pnpm service` */
export async function validityMain() {
  const c = await getClients();
  const shape = parseShape(process.env.SHAPE);
  const target = loadShape(shape, c.chainId);
  const entry = (process.env.ENTRY as Address | undefined) ?? target.entry;
  if (!entry) throw new Error(`no ValidityEntry for ${shape} on chain ${c.chainId}: run \`SHAPE=${shape} pnpm validity:deploy\` or set ENTRY`);
  const gateOfEntry = await c.publicClient.readContract({ address: entry, abi: validityEntryAbi, functionName: "gate" });
  if (!eq(gateOfEntry, target.gate)) throw new Error(`ValidityEntry ${entry} points at gate ${gateOfEntry}, not the ${shape} gate ${target.gate}`);
  const num = (k: string, d: number) => (process.env[k] ? Number(process.env[k]) : d);
  const dir = process.env.SERVICE_DIR ? resolve(process.env.SERVICE_DIR) : resolve(AGG_DIR, "out/service", `validity-${c.chainId}-${entry.toLowerCase()}`);
  const h = await startValidityService({
    c,
    cfg: { dir, target: { ...target, entry }, entry, maxWaitMs: num("MAX_WAIT_MS", 20_000), startSlot: num("START_SLOT", 1), concurrency: num("CONCURRENCY", 8) },
    port: num("PORT", 8548),
    host: process.env.HOST ?? "127.0.0.1",
    tickMs: num("TICK_MS", 1000),
  });
  console.log(`sigpress service (MODE=validity, ${shape}) on ${h.url}`);
  console.log(`chain ${c.chainId}, ValidityEntry ${entry}, gate ${target.gate}, verifier ${target.verifier}, sender ${c.account.address}, state ${dir}`);
  const shutdown = async () => {
    console.log("shutting down (state is on disk; restart resumes)");
    await h.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
