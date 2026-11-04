// Watchtower: follows BatchSubmitted on ANY OptimisticAggregator (whoever posted the batch), fetches the
// batch's signatures from its DA document, verifies every WOTS signature off chain, and calls `challenge`
// on the first bad one while the window is open (the bond goes to the challenger).
// If the DA document is missing or does not rebuild the posted root, nobody can challenge that batch: it is
// logged loudly on every poll until the window closes. That is the optimistic design's DA risk.
//   pnpm watchtower      env: AGGREGATOR (default: the service deployments' OptimisticAggregator),
//                        DA_URL (comma-separated base URLs, tried after the event's own http(s) dataURI),
//                        WATCH_KEY_VAR (key for challenge txs; default KEY_VAR), RPC_URL, FROM_BLOCK,
//                        POLL_MS (2000), LOG_CHUNK (100 blocks per eth_getLogs), WATCH_STATE (state file)
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEventLogs, type Address, type Hex } from "viem";
import { aggregatorAbi } from "../abi.ts";
import { AGG_DIR, getClients, MONAD_EXPLORER, txLink } from "../chain.ts";
import { checkDA, type DADoc } from "./da.ts";
import { readJson, writeJsonAtomic } from "./store.ts";
import { revertReason } from "./chain.ts";

export type WatchStatus = "open" | "ok" | "challenged" | "slashed" | "closed-unchecked" | "closed";

export interface WatchedBatch {
  id: bigint;
  root: Hex;
  count: number;
  submitter: Address;
  dataURI: string;
  deadline: bigint;
  status: WatchStatus;
  daMissingSince?: number;
  lastLoud?: number;
  note?: string;
  challengeTx?: Hex;
}

export type WatchEvent =
  | { type: "batch"; id: bigint; submitter: Address; count: number }
  | { type: "ok"; id: bigint; count: number }
  | { type: "da-missing"; id: bigint; reason: string }
  | { type: "challenged"; id: bigint; index: number; txHash: Hex }
  | { type: "challenge-failed"; id: bigint; index: number; reason: string }
  | { type: "slashed-elsewhere"; id: bigint }
  | { type: "closed-unchecked"; id: bigint; reason: string };

export interface WatchtowerOptions {
  aggregator: Address;
  stateFile: string;
  rpc?: string;
  privateKey?: Hex;
  keyVar?: string;
  daUrls?: string[];
  fromBlock?: bigint;
  pollMs?: number;
  logChunk?: number;
  fetchTimeoutMs?: number;
  onEvent?: (e: WatchEvent) => void;
  log?: (msg: string) => void;
}

interface WatchState {
  version: 1;
  aggregator: Address;
  nextBlock?: bigint;
  batches: Record<string, WatchedBatch>;
}

export async function startWatchtower(opts: WatchtowerOptions) {
  const { chainId, publicClient, walletClient, account } = await getClients({ rpc: opts.rpc, privateKey: opts.privateKey, keyVar: opts.keyVar });
  const explorer = chainId === 10143 ? MONAD_EXPLORER : undefined;
  const log = opts.log ?? ((m: string) => console.log(`[watchtower ${new Date().toISOString()}] ${m}`));
  const loud = (m: string) => log(`!!!!! ${m} !!!!!`);
  const emit = (e: WatchEvent) => opts.onEvent?.(e);
  const pollMs = opts.pollMs ?? 2000;
  const chunk = BigInt(opts.logChunk ?? 100);
  const state: WatchState = readJson<WatchState>(opts.stateFile) ?? { version: 1, aggregator: opts.aggregator, batches: {} };
  if (state.aggregator.toLowerCase() !== opts.aggregator.toLowerCase()) throw new Error(`${opts.stateFile} is for aggregator ${state.aggregator}`);
  const save = () => writeJsonAtomic(opts.stateFile, state);

  async function fetchDA(b: WatchedBatch): Promise<{ doc?: unknown; tried: string[] }> {
    const urls: string[] = [];
    if (/^https?:\/\//.test(b.dataURI)) urls.push(b.dataURI);
    for (const base of opts.daUrls ?? []) urls.push(`${base.replace(/\/$/, "")}/da/${b.root}`);
    const tried: string[] = [];
    for (const u of urls) {
      try {
        const r = await fetch(u, { signal: AbortSignal.timeout(opts.fetchTimeoutMs ?? 5000) });
        if (!r.ok) {
          tried.push(`${u} -> HTTP ${r.status}`);
          continue;
        }
        return { doc: await r.json(), tried };
      } catch (e) {
        tried.push(`${u} -> ${(e as Error).message}`);
      }
    }
    if (!urls.length) tried.push(`dataURI "${b.dataURI}" is not http(s) and no DA_URL is configured`);
    return { tried };
  }

  async function scan() {
    const latest = await publicClient.getBlockNumber();
    let from = state.nextBlock ?? opts.fromBlock ?? (latest > 1000n ? latest - 1000n : 0n);
    while (from <= latest) {
      const to = from + chunk - 1n < latest ? from + chunk - 1n : latest;
      const logs = await publicClient.getLogs({ address: opts.aggregator, fromBlock: from, toBlock: to });
      for (const ev of parseEventLogs({ abi: aggregatorAbi, logs, eventName: "BatchSubmitted" })) {
        const key = ev.args.id.toString();
        if (state.batches[key]) continue;
        const [, , deadline] = await publicClient.readContract({ address: opts.aggregator, abi: aggregatorAbi, functionName: "batches", args: [ev.args.id] });
        state.batches[key] = { id: ev.args.id, root: ev.args.root, count: Number(ev.args.count), submitter: ev.args.aggregator, dataURI: ev.args.dataURI, deadline, status: "open" };
        log(`batch ${key} from ${ev.args.aggregator}: ${ev.args.count} leaves, root ${ev.args.root}, dataURI ${ev.args.dataURI}`);
        emit({ type: "batch", id: ev.args.id, submitter: ev.args.aggregator, count: Number(ev.args.count) });
      }
      from = to + 1n;
      state.nextBlock = from;
      save();
    }
  }

  async function check(b: WatchedBatch, now: bigint) {
    const [, , , , slashed] = await publicClient.readContract({ address: opts.aggregator, abi: aggregatorAbi, functionName: "batches", args: [b.id] });
    if (slashed) {
      b.status = "slashed";
      emit({ type: "slashed-elsewhere", id: b.id });
      log(`batch ${b.id} already slashed`);
      return;
    }
    if (now >= b.deadline) {
      if (b.daMissingSince !== undefined) {
        b.status = "closed-unchecked";
        loud(`DA RISK: batch ${b.id} from ${b.submitter} passed its window WITHOUT its signatures ever being available (${b.note}). It can finalize unchecked.`);
        emit({ type: "closed-unchecked", id: b.id, reason: b.note ?? "" });
      } else b.status = "closed";
      return;
    }
    const { doc, tried } = await fetchDA(b);
    const res = doc === undefined ? ({ ok: false, reason: `DA unavailable: ${tried.join("; ")}` } as const) : checkDA(doc, { root: b.root, count: b.count });
    if (!res.ok) {
      const first = b.daMissingSince === undefined;
      b.daMissingSince ??= Date.now();
      b.note = res.reason;
      if (first || Date.now() - (b.lastLoud ?? 0) > 15_000) {
        b.lastLoud = Date.now();
        loud(`DA MISSING for batch ${b.id} from ${b.submitter} (${now < b.deadline ? `${b.deadline - now}s of window left` : "window closed"}): ${res.reason}`);
        emit({ type: "da-missing", id: b.id, reason: res.reason });
      }
      return;
    }
    b.daMissingSince = undefined;
    if (res.firstBad === undefined) {
      b.status = "ok";
      log(`batch ${b.id}: all ${b.count} signatures valid`);
      emit({ type: "ok", id: b.id, count: b.count });
      return;
    }
    const i = res.firstBad;
    const leaf = (doc as DADoc).leaves[i]!;
    log(`batch ${b.id}: signature ${i} is INVALID; challenging`);
    const args = [b.id, leaf.pkHash, leaf.m, leaf.sig, BigInt(i), res.tree.proof(i)] as const;
    try {
      await publicClient.simulateContract({ account, address: opts.aggregator, abi: aggregatorAbi, functionName: "challenge", args });
      const hash = await walletClient.writeContract({ address: opts.aggregator, abi: aggregatorAbi, functionName: "challenge", args });
      b.challengeTx = hash;
      save();
      const r = await publicClient.waitForTransactionReceipt({ hash });
      if (r.status !== "success") throw new Error(`challenge tx reverted ${hash}`);
      b.status = "challenged";
      log(`batch ${b.id} SLASHED by challenge ${txLink(explorer, hash)} (bond to ${account.address})`);
      emit({ type: "challenged", id: b.id, index: i, txHash: hash });
    } catch (e) {
      const reason = revertReason(e);
      log(`challenge of batch ${b.id} leaf ${i} failed: ${reason}`);
      emit({ type: "challenge-failed", id: b.id, index: i, reason });
    }
  }

  async function poll() {
    await scan();
    const now = (await publicClient.getBlock({ blockTag: "latest" })).timestamp;
    for (const b of Object.values(state.batches)) {
      if (b.status !== "open") continue;
      try {
        await check(b, now);
      } catch (e) {
        log(`batch ${b.id}: ${(e as Error).message.split("\n")[0]}`);
      }
    }
    save();
  }

  let stopped = false;
  let running: Promise<void> = Promise.resolve();
  const loop = (async () => {
    log(`watching OptimisticAggregator ${opts.aggregator} on chain ${chainId} as ${account.address}; DA fallbacks: ${(opts.daUrls ?? []).join(", ") || "none"}`);
    while (!stopped) {
      running = poll().catch((e) => log(`poll: ${(e as Error).message.split("\n")[0]}`));
      await running;
      await new Promise((r) => setTimeout(r, pollMs));
    }
  })();
  return {
    state,
    poll,
    async stop() {
      stopped = true;
      await running;
      await loop;
    },
  };
}

async function main() {
  const { serviceDeployments } = await import("./server.ts");
  const dep = serviceDeployments();
  const { readFileSync } = await import("node:fs");
  const d = JSON.parse(readFileSync(dep.path, "utf8")) as { batches: Address };
  const aggregator = (process.env.AGGREGATOR as Address | undefined) ?? d.batches;
  const keyVar = process.env.WATCH_KEY_VAR ?? process.env.KEY_VAR;
  const stateFile = process.env.WATCH_STATE ? resolve(process.env.WATCH_STATE) : resolve(AGG_DIR, "out/service", `watchtower-${aggregator.toLowerCase()}.json`);
  await startWatchtower({
    aggregator,
    keyVar,
    stateFile,
    daUrls: (process.env.DA_URL ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    fromBlock: process.env.FROM_BLOCK ? BigInt(process.env.FROM_BLOCK) : undefined,
    pollMs: process.env.POLL_MS ? Number(process.env.POLL_MS) : undefined,
    logChunk: process.env.LOG_CHUNK ? Number(process.env.LOG_CHUNK) : undefined,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
