// K1 TODO: sample Monad mainnet block utilisation (read-only, no keys, no deps).
// Usage: node sample.mjs [rpc] [spreadCount] [contiguousCount] [windowBlocks]
// Tx size = exact length of each tx's canonical encoding, taken from the block RLP
// returned by debug_getRawBlock (eth_getRawTransactionByHash is not exposed by the public RPC).
import { writeFileSync } from "node:fs";

const RPC = process.argv[2] ?? "https://rpc.monad.xyz";
const SPREAD = +(process.argv[3] ?? 200);
const CONTIG = +(process.argv[4] ?? 50);
const WINDOW = +(process.argv[5] ?? 0); // 0 = derive ~24 h from block timestamps

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let id = 0;
async function rpc(method, params, tries = 6) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      });
      const j = await res.json();
      if (j.error) throw new Error(JSON.stringify(j.error));
      return j.result;
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(500 * (i + 1));
    }
  }
}

// Minimal RLP decoder: returns {items|bytes, start, end} spans over the buffer.
function decode(buf, pos = 0) {
  const b = buf[pos];
  if (b < 0x80) return { type: "str", start: pos, dataStart: pos, end: pos + 1 };
  if (b < 0xb8) return { type: "str", start: pos, dataStart: pos + 1, end: pos + 1 + (b - 0x80) };
  if (b < 0xc0) {
    const ll = b - 0xb7; const len = readLen(buf, pos + 1, ll);
    return { type: "str", start: pos, dataStart: pos + 1 + ll, end: pos + 1 + ll + len };
  }
  let dataStart, end;
  if (b < 0xf8) { dataStart = pos + 1; end = dataStart + (b - 0xc0); }
  else { const ll = b - 0xf7; dataStart = pos + 1 + ll; end = dataStart + readLen(buf, pos + 1, ll); }
  const items = []; let p = dataStart;
  while (p < end) { const it = decode(buf, p); items.push(it); p = it.end; }
  return { type: "list", start: pos, dataStart, end, items };
}
function readLen(buf, p, n) { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + buf[p + i]; return v; }

// Per-tx encoded size: legacy tx = whole RLP list; typed tx (EIP-2718) = string payload (type byte || rlp).
function txSizesFromRawBlock(hex) {
  const buf = Buffer.from(hex.slice(2), "hex");
  const block = decode(buf);
  const txs = block.items[1];
  return { blockRlpBytes: buf.length, sizes: txs.items.map((t) => (t.type === "list" ? t.end - t.start : t.end - t.dataStart)) };
}

const HANDLE_OPS = new Set(["0x1fad948c", "0x765e827f"]); // handleOps v0.6 / v0.7+
const HANDLE_AGG = new Set(["0x4b1d7cf5", "0xdbed18e0"]); // handleAggregatedOps v0.6 / v0.7+

async function sampleBlock(n) {
  const tag = "0x" + n.toString(16);
  const [blk, raw] = await Promise.all([rpc("eth_getBlockByNumber", [tag, true]), rpc("debug_getRawBlock", [tag])]);
  const { sizes, blockRlpBytes } = txSizesFromRawBlock(raw);
  if (sizes.length !== blk.transactions.length) throw new Error(`tx count mismatch at ${n}`);
  const types = {}; let handleOps = 0, handleAgg = 0;
  for (const t of blk.transactions) {
    const ty = parseInt(t.type, 16); types[ty] = (types[ty] ?? 0) + 1;
    const sel = (t.input ?? "0x").slice(0, 10);
    if (HANDLE_OPS.has(sel)) handleOps++;
    if (HANDLE_AGG.has(sel)) handleAgg++;
  }
  return {
    number: n, timestamp: parseInt(blk.timestamp, 16), txCount: sizes.length,
    txBytes: sizes.reduce((a, b) => a + b, 0), blockRlpBytes, sizes,
    gasUsed: parseInt(blk.gasUsed, 16), gasLimit: parseInt(blk.gasLimit, 16), types, handleOps, handleAgg,
  };
}

const latest = parseInt(await rpc("eth_blockNumber", []), 16);
let window = WINDOW;
if (!window) {
  const probe = latest - 100000;
  const [a, b] = await Promise.all([rpc("eth_getBlockByNumber", ["0x" + latest.toString(16), false]), rpc("eth_getBlockByNumber", ["0x" + probe.toString(16), false])]);
  const secPerBlock = (parseInt(a.timestamp, 16) - parseInt(b.timestamp, 16)) / 100000;
  window = Math.round(86400 / secPerBlock);
  console.error(`~${secPerBlock.toFixed(3)} s/block -> 24 h ~ ${window} blocks`);
}
const step = Math.floor(window / SPREAD);
const spread = Array.from({ length: SPREAD }, (_, i) => latest - CONTIG - i * step);
const contig = Array.from({ length: CONTIG }, (_, i) => latest - CONTIG + 1 + i);
const targets = [...contig.map((n) => ["contiguous", n]), ...spread.map((n) => ["spread", n])];

const out = [];
for (let i = 0; i < targets.length; i += 5) {
  const chunk = targets.slice(i, i + 5);
  const res = await Promise.all(chunk.map(([set, n]) => sampleBlock(n).then((r) => ({ set, ...r }))));
  out.push(...res);
  process.stderr.write(`\r${out.length}/${targets.length}`);
  await sleep(600);
}
process.stderr.write("\n");

// ---- stats ----
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const avg = (arr) => arr.reduce((a, b) => a + b, 0) / (arr.length || 1);
function summarise(blocks) {
  const sizes = blocks.flatMap((b) => b.sizes);
  const types = {}; let hops = 0, hagg = 0;
  for (const b of blocks) { for (const [k, v] of Object.entries(b.types)) types[k] = (types[k] ?? 0) + v; hops += b.handleOps; hagg += b.handleAgg; }
  return {
    blocks: blocks.length, fromBlock: Math.min(...blocks.map((b) => b.number)), toBlock: Math.max(...blocks.map((b) => b.number)),
    fromTime: new Date(Math.min(...blocks.map((b) => b.timestamp)) * 1000).toISOString(),
    toTime: new Date(Math.max(...blocks.map((b) => b.timestamp)) * 1000).toISOString(),
    txs: sizes.length, emptyBlocks: blocks.filter((b) => b.txCount === 0).length,
    txSize: { avg: avg(sizes), p50: pct(sizes, 50), p95: pct(sizes, 95), max: Math.max(0, ...sizes) },
    txPerBlock: { avg: avg(blocks.map((b) => b.txCount)), p50: pct(blocks.map((b) => b.txCount), 50), p95: pct(blocks.map((b) => b.txCount), 95), max: Math.max(...blocks.map((b) => b.txCount)) },
    txBytesPerBlock: { avg: avg(blocks.map((b) => b.txBytes)), p95: pct(blocks.map((b) => b.txBytes), 95), max: Math.max(...blocks.map((b) => b.txBytes)) },
    blockRlpBytes: { avg: avg(blocks.map((b) => b.blockRlpBytes)), max: Math.max(...blocks.map((b) => b.blockRlpBytes)) },
    pctOfByteCap: { avg: (100 * avg(blocks.map((b) => b.txBytes))) / 1_500_000, max: (100 * Math.max(...blocks.map((b) => b.txBytes))) / 1_500_000 },
    pctOfTxCap: { avg: (100 * avg(blocks.map((b) => b.txCount))) / 3750, max: (100 * Math.max(...blocks.map((b) => b.txCount))) / 3750 },
    gas: { avgUsed: avg(blocks.map((b) => b.gasUsed)), avgLimit: avg(blocks.map((b) => b.gasLimit)), avgPct: avg(blocks.map((b) => (100 * b.gasUsed) / b.gasLimit)), maxPct: Math.max(...blocks.map((b) => (100 * b.gasUsed) / b.gasLimit)) },
    txTypes: types, handleOps: hops, handleAggregatedOps: hagg,
  };
}
const summary = {
  rpc: RPC, sampledAt: new Date().toISOString(), latest, windowBlocks: window, step,
  all: summarise(out), contiguous: summarise(out.filter((b) => b.set === "contiguous")), spread: summarise(out.filter((b) => b.set === "spread")),
};
writeFileSync(new URL("./results/blocks.json", import.meta.url), JSON.stringify(out.map(({ sizes, ...r }) => r), null, 1));
writeFileSync(new URL("./results/summary.json", import.meta.url), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
