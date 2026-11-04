// Sigpress aggregator service: HTTP API over the Batcher (node:http, no framework).
//   POST /ops            signed compact op for a SigpressAccount -> 202 {id, status, ...} (400 if invalid)
//   GET  /ops/:id        op status: pending | batched | finalized | executed | failed
//   GET  /batches/:id    by on-chain batch id, local key (b0) or root
//   GET  /da/:root       the batch's signatures (data availability for challengers)
//   GET  /health
// Run: KEY_VAR=PRIVATE_KEY_K13 pnpm service   (see docs/service.md for every env var)
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getAddress, isAddress, isHex, size, type Address, type Hex } from "viem";
import { AGG_DIR } from "../chain.ts";
import { SIG_BYTES } from "../wots.ts";
import { Batcher, RejectError, type BatcherConfig, type OpInput } from "./batcher.ts";
import { viemChain, type ChainAdapter } from "./chain.ts";
import { startRevealer, type RevealerOptions } from "./revealer.ts";
import { toJson } from "./store.ts";

const MAX_BODY = 64 * 1024;

/** Parse and shape-check a POST /ops body. Signature validity is checked by Batcher.accept. */
export function parseOpInput(body: unknown): OpInput {
  const b = body as Record<string, unknown>;
  if (!b || typeof b !== "object") throw new RejectError("body must be a JSON object");
  const addr = (k: string, required: boolean): Address | undefined => {
    const v = b[k];
    if (v === undefined && !required) return undefined;
    if (typeof v !== "string" || !isAddress(v, { strict: false })) throw new RejectError(`${k} must be an address`);
    return getAddress(v);
  };
  const hex = (k: string, bytes?: number): Hex => {
    const v = b[k];
    if (typeof v !== "string" || !isHex(v) || v.length % 2) throw new RejectError(`${k} must be 0x-hex`);
    if (bytes !== undefined && size(v) !== bytes) throw new RejectError(`${k} must be ${bytes} bytes`);
    return v.toLowerCase() as Hex;
  };
  let value: bigint;
  try {
    const v = b.value ?? "0";
    if (typeof v !== "string" && typeof v !== "number") throw new Error();
    if (typeof v === "number" && !Number.isSafeInteger(v)) throw new Error();
    value = BigInt(v);
  } catch {
    throw new RejectError("value must be a decimal or 0x string (wei)");
  }
  if (value < 0n || value >= 2n ** 256n) throw new RejectError("value out of range");
  let index: number | undefined;
  if (b.index !== undefined) {
    index = Number(b.index);
    if (!Number.isInteger(index) || index < 0 || index > 0xffffffff) throw new RejectError("index must be a uint32");
  }
  const account = addr("account", index === undefined);
  const data = b.data === undefined ? ("0x" as Hex) : hex("data");
  if (size(data) > 0xffff) throw new RejectError("data > 65535 bytes");
  return { account, index, target: addr("target", true)!, value, data, nextPkHash: hex("nextPkHash", 32), sig: hex("sig", SIG_BYTES) };
}

function send(res: ServerResponse, status: number, body: unknown) {
  const text = toJson(body);
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > MAX_BODY) throw new RejectError("body too large", 413);
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RejectError("body is not JSON");
  }
}

export function apiHandler(batcher: Batcher) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", "http://x");
      const parts = url.pathname.split("/").filter(Boolean);
      if (req.method === "OPTIONS") return send(res, 204, {});
      if (req.method === "POST" && url.pathname === "/ops") {
        const { op, duplicate } = await batcher.accept(parseOpInput(await readBody(req)));
        return send(res, duplicate ? 200 : 202, batcher.view(op));
      }
      if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });
      if (parts[0] === "ops" && parts.length === 2) {
        const op = batcher.getOp(parts[1]!);
        return op ? send(res, 200, batcher.view(op)) : send(res, 404, { error: "unknown op" });
      }
      if (parts[0] === "batches" && parts.length === 2) {
        const b = batcher.getBatch(parts[1]!);
        return b ? send(res, 200, batcher.viewBatch(b)) : send(res, 404, { error: "unknown batch" });
      }
      if (parts[0] === "da" && parts.length === 2 && /^0x[0-9a-fA-F]{64}$/.test(parts[1]!)) {
        const da = batcher.getDA(parts[1]! as Hex);
        return da ? send(res, 200, da) : send(res, 404, { error: "no DA document for this root" });
      }
      if (url.pathname === "/health") {
        const counts: Record<string, number> = {};
        for (const o of Object.values(batcher.state.ops)) counts[o.status] = (counts[o.status] ?? 0) + 1;
        const c = batcher.chain;
        return send(res, 200, { ok: true, chainId: c.chainId, entry: c.entry, aggregator: c.batches, sender: c.sender, ops: counts, batches: Object.keys(batcher.state.batchList).length });
      }
      return send(res, 404, { error: "not found" });
    } catch (e) {
      if (e instanceof RejectError) return send(res, e.status, { error: e.message });
      console.error(e);
      return send(res, 500, { error: (e as Error).message.split("\n")[0] });
    }
  };
}

export interface ServiceHandle {
  url: string;
  batcher: Batcher;
  server: Server;
  close(): Promise<void>;
}

/** Start the HTTP API and the batching loop. publicUrl defaults to the bound URL. */
export async function startService(opts: {
  chain: ChainAdapter;
  dir: string;
  port?: number;
  host?: string;
  publicUrl?: string;
  tickMs?: number;
  batcher?: Omit<BatcherConfig, "dir" | "publicUrl">;
  /** Answer requestReveal on our batches from the DA store (SR-R1). Omit to not run it. */
  revealer?: Omit<RevealerOptions, "aggregator" | "getDA">;
}): Promise<ServiceHandle> {
  const host = opts.host ?? "127.0.0.1";
  // The DA URL goes into each BatchSubmitted event, so bind first to learn the port.
  let handler: ReturnType<typeof apiHandler> | undefined;
  const server = createServer((req, res) => (handler ? void handler(req, res) : send(res, 503, { error: "starting" })));
  await new Promise<void>((r) => server.listen(opts.port ?? 0, host, r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.port;
  const url = `http://${host}:${port}`;
  const b = new Batcher(opts.chain, { ...opts.batcher, dir: opts.dir, publicUrl: opts.publicUrl ?? url });
  handler = apiHandler(b);
  b.start(opts.tickMs ?? 500);
  const rv = opts.revealer ? await startRevealer({ ...opts.revealer, aggregator: opts.chain.batches, getDA: (root) => b.getDA(root) }) : undefined;
  return {
    url,
    batcher: b,
    server,
    async close() {
      await rv?.stop();
      await b.stop();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** deployments-service.json if present, else deployments-compact.json (override: SERVICE_DEPLOYMENTS). */
export function serviceDeployments(): { path: string; entry: Address; explorer?: string } {
  const path = process.env.SERVICE_DEPLOYMENTS
    ? resolve(process.env.SERVICE_DEPLOYMENTS)
    : [resolve(AGG_DIR, "deployments-service.json"), resolve(AGG_DIR, "deployments-compact.json")].find((p) => existsSync(p))!;
  const d = JSON.parse(readFileSync(path, "utf8")) as { entry: Address; explorer?: string };
  return { path, entry: (process.env.ENTRY as Address | undefined) ?? d.entry, explorer: d.explorer };
}

async function main() {
  const dep = serviceDeployments();
  const chain = await viemChain({ entry: dep.entry });
  const num = (k: string, d: number) => (process.env[k] ? Number(process.env[k]) : d);
  const dir = process.env.SERVICE_DIR ? resolve(process.env.SERVICE_DIR) : resolve(AGG_DIR, "out/service", `${chain.chainId}-${chain.entry.toLowerCase()}`);
  const svc = await startService({
    chain,
    dir,
    port: num("PORT", 8547),
    host: process.env.HOST ?? "127.0.0.1",
    publicUrl: process.env.PUBLIC_URL,
    tickMs: num("TICK_MS", 500),
    batcher: { maxOps: num("MAX_OPS", 64), maxWaitMs: num("MAX_WAIT_MS", 5000), fallbackMs: num("FALLBACK_MS", 60_000) },
    // Without this, anyone could requestReveal on our batches and slash them for half the bond.
    revealer: process.env.REVEALER === "0" ? undefined : { keyVar: process.env.REVEAL_KEY_VAR ?? process.env.KEY_VAR },
  });
  console.log(`sigpress service on ${svc.url} (DA base ${process.env.PUBLIC_URL ?? svc.url})`);
  console.log(`chain ${chain.chainId}, entry ${chain.entry}, aggregator ${chain.batches}, sender ${chain.sender}, state ${dir}`);
  const shutdown = async () => {
    console.log("shutting down (state is on disk; restart resumes)");
    await svc.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
