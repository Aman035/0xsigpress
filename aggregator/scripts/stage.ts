// One command for the live demo: the four beats from docs/demo.md, on Monad testnet.
//   Beat 1  capacity model (K1 arithmetic, labelled as a model, not live TPS)
//   Beat 2  sign N ops, submit one batch (live tx)
//   Beat 3  naive vs batch comparison (naive from results.json, or a live naive tx if missing)
//   Beat 4  tamper: one flipped bit -> challenger finds it off chain -> challenge -> slashed (live txs)
// Env: N (default 256), BAD_INDEX (default 7), STEP=1 (wait for Enter between beats),
//      NAIVE=live (send a fresh naive tx instead of reading results.json), RPC_URL, DEPLOYMENTS.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { formatEther, hexToBytes, keccak256, parseEventLogs, toBytes, type Hash, type TransactionReceipt } from "viem";
import { AGG_DIR, getClients, loadDeployments, txLink } from "../src/chain.ts";
import { aggregatorAbi, naiveLaneAbi } from "../src/abi.ts";
import { buildBatch } from "../src/batch.ts";
import { keygen, sign, verify } from "../src/wots.ts";
import { leafOf, messageOf } from "../src/op.ts";
import { verifyProof } from "../src/merkle.ts";
import { writeResults } from "../src/results.ts";

// ---------- terminal styling (plain ANSI, disabled when not a TTY or NO_COLOR is set) ----------
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const sgr = (code: string) => (s: string | number) => (color ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = sgr("1"), dim = sgr("2"), red = sgr("31"), green = sgr("32"), yellow = sgr("33"), cyan = sgr("36"), magenta = sgr("35");
const fmt = (n: number, d = 0) => n.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
const visLen = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - visLen(s)));
const padL = (s: string, w: number) => " ".repeat(Math.max(0, w - visLen(s))) + s;
const line = (ch = "─", w = 78) => dim(ch.repeat(w));
const bar = (frac: number, w = 40, full = "█", empty = "░") => {
  const k = Math.max(0, Math.min(w, Math.round(frac * w)));
  return full.repeat(k) + dim(empty.repeat(w - k));
};
function table(rows: string[][], align: ("l" | "r")[]) {
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => visLen(r[c]!))));
  for (const [i, r] of rows.entries()) {
    console.log("  " + r.map((cell, c) => (align[c] === "r" ? padL(cell, widths[c]!) : pad(cell, widths[c]!))).join("   "));
    if (i === 0) console.log("  " + dim(widths.map((w) => "─".repeat(w)).join("   ")));
  }
}
function beat(n: number, title: string, tag: string) {
  console.log("\n" + line("━"));
  console.log(`${bold(cyan(`BEAT ${n}`))}  ${bold(title)}  ${tag}`);
  console.log(line("━"));
}
const LIVE = bold(green("[LIVE on Monad testnet]"));
const MODEL = bold(yellow("[CAPACITY MODEL, not live TPS]"));

const STEP = process.env.STEP === "1";
// One readline for the whole run; buffered lines are handed out one per pause. If stdin ends (piped
// input), remaining pauses just continue.
const rl = STEP ? createInterface({ input: process.stdin }) : undefined;
const lines: string[] = [];
const waiters: (() => void)[] = [];
let stdinClosed = false;
rl?.on("line", (l) => (waiters.length ? waiters.shift()!() : lines.push(l)));
rl?.on("close", () => {
  stdinClosed = true;
  while (waiters.length) waiters.shift()!();
});
async function pause(next: string) {
  if (!rl) return;
  process.stdout.write(dim(`\n  press Enter for ${next} ...`));
  if (lines.length) lines.shift();
  else if (!stdinClosed) await new Promise<void>((r) => waiters.push(r));
  process.stdout.write("\n");
}

// ---------- setup ----------
const N = Number(process.env.N ?? 256);
const BAD = Number(process.env.BAD_INDEX ?? 7);
if (!Number.isInteger(N) || N < 1 || N > 4096) throw new Error(`N must be an integer 1..4096 (got ${process.env.N})`);
if (!Number.isInteger(BAD) || BAD < 0 || BAD >= N) throw new Error(`BAD_INDEX must be in 0..${N - 1}`);

const d = loadDeployments();
const { chainId, publicClient, walletClient, account } = await getClients();
const explorer = chainId === 10143 ? d.explorer : undefined;
const runTag = `sigpress-stage-${Date.now()}`; // fresh keys/roots every run
const stage: Record<string, unknown> = { startedAt: new Date().toISOString(), n: N, chainId, account: account.address };

async function confirm(label: string, hash: Hash): Promise<TransactionReceipt> {
  console.log(`  ${dim(label)} ${cyan(txLink(explorer, hash))}`);
  let r: TransactionReceipt;
  try {
    r = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  } catch (e) {
    throw new Error(`${label}: no receipt for ${hash} within 120 s (${(e as Error).message})`);
  }
  if (r.status !== "success") throw new Error(`${label} reverted on chain: ${txLink(explorer, hash)}`);
  return r;
}

console.log(line("━"));
console.log(bold(magenta("  SIGPRESS")) + bold("  post-quantum signatures, compressed for Monad"));
console.log(dim(`  chain ${chainId} · aggregator ${d.aggregator} · naive lane ${d.naiveLane}`));
console.log(dim(`  sender ${account.address} · batch size N=${N}`));
const [bond, balance] = await Promise.all([
  publicClient.readContract({ address: d.aggregator, abi: aggregatorAbi, functionName: "bond" }),
  publicClient.getBalance({ address: account.address }),
]);
console.log(dim(`  balance ${formatEther(balance)} MON · bond per batch ${formatEther(bond)} MON`));
if (balance < 3n * bond) throw new Error(`balance ${formatEther(balance)} MON too low: need at least ${formatEther(3n * bond)} MON (two bonds + gas). Faucet: https://faucet.monad.xyz`);

// ---------- Beat 1: capacity model ----------
// K1 (docs/decisions.md): MIP-12 caps 1,500,000 B and 3,750 tx per block; capacity = min(tx cap, byte cap / bytes-per-tx);
// baseline tx ~400 B, PQ tx ~ 400 - 65 + signature (+ public key).
beat(1, "What post-quantum signatures do to a Monad block", MODEL);
const BLOCK_BYTES = 1_500_000, TX_CAP = 3_750;
const naivePrev = process.env.NAIVE === "live" ? undefined : readNaiveFromResults();
const wotsCalldata = naivePrev?.calldataBytes ?? 2_276;
const capRows: [string, number, string][] = [
  ["ECDSA (today)", TX_CAP, "tx-cap bound"],
  ["ML-DSA-44, sig only (pk stored)", 544, "~2,755 B/tx"],
  ["ML-DSA-44, sig + pk", 369, "~4,067 B/tx"],
  [`our naive WOTS (measured ${fmt(wotsCalldata)} B calldata)`, Math.min(TX_CAP, Math.floor(BLOCK_BYTES / wotsCalldata)), "measured calldata"],
];
for (const [name, tx, note] of capRows) {
  const c = tx >= TX_CAP ? green : tx > 1000 ? yellow : red;
  console.log(`  ${pad(name, 44)} ${c(padL(fmt(tx), 5))} tx/block  ${dim(note)}`);
  console.log(`  ${bar(tx / TX_CAP, 60)}`);
}
console.log(dim(`\n  Block caps from MIP-12: ${fmt(BLOCK_BYTES)} B and ${fmt(TX_CAP)} tx per 300 ms block.`));
console.log(dim(`  ML-DSA rows: K1 arithmetic in docs/decisions.md (sizes from FIPS 204). WOTS row: bytes from our testnet tx.`));
console.log(`  ${bold("Naive PQ cuts block capacity by ~85-90%.")} ${dim("This is block capacity, not measured throughput.")}`);
await pause("Beat 2 (live batch)");

// ---------- Beat 2: sign N ops, submit one batch ----------
beat(2, `Sign ${fmt(N)} post-quantum ops, put ONE batch on chain`, LIVE);
const t0 = performance.now();
const honest = buildBatch({ n: N, chainId, aggregator: d.aggregator, seedTag: `${runTag}-ok-` });
const signMs = performance.now() - t0;
console.log(`  signed ${bold(fmt(N))} WOTS ops (keygen + sign + Merkle root) in ${bold(`${fmt(signMs)} ms`)} ${dim(`(${fmt(signMs / N, 2)} ms/op)`)}`);
console.log(dim(`  root ${honest.tree.root}`));
console.log(dim(`  DA file ${honest.daFile}`));
const tSubmit = performance.now();
const batchTx = await walletClient.writeContract({
  address: d.aggregator,
  abi: aggregatorAbi,
  functionName: "submitBatch",
  args: [honest.tree.root, N, honest.dataURI],
  value: bond,
});
const batchReceipt = await confirm("submitBatch", batchTx);
const confirmMs = performance.now() - tSubmit;
const batchEv = parseEventLogs({ abi: aggregatorAbi, logs: batchReceipt.logs, eventName: "BatchSubmitted" })[0];
if (!batchEv) throw new Error("submitBatch receipt has no BatchSubmitted event");
const batchInput = hexToBytes((await publicClient.getTransaction({ hash: batchTx })).input).length;
const batchGas = Number(batchReceipt.gasUsed);
const batchBytesPerOp = batchInput / N;
console.log(`  ${green("✓")} batch #${batchEv.args.id} accepted in block ${batchReceipt.blockNumber} ${dim(`(${fmt(confirmMs)} ms submit→receipt)`)}`);
console.log(`  gas charged ${bold(fmt(batchGas))} ${dim(`(${fmt(batchGas / N)} gas/op; Monad charges the gas limit, incl. our 30% buffer)`)}`);
console.log(`  calldata ${bold(`${fmt(batchInput)} B`)} → ${bold(green(`${fmt(batchBytesPerOp, 2)} B/op`))}`);
stage.batch = { txHash: batchTx, batchId: Number(batchEv.args.id), gasUsed: batchGas, inputBytes: batchInput, bytesPerOp: batchBytesPerOp, signMs: Math.round(signMs), confirmMs: Math.round(confirmMs), at: new Date().toISOString() };
writeResults({ batch: { txHash: batchTx, gasUsed: batchGas, count: N, root: honest.tree.root, bytesPerOp: batchBytesPerOp } });
await pause("Beat 3 (comparison)");

// ---------- Beat 3: naive vs batch ----------
beat(3, "Naive post-quantum vs Sigpress batch", LIVE);
let naive = naivePrev;
let naiveFresh = false;
if (!naive) {
  console.log(dim(`  ${process.env.NAIVE === "live" ? "NAIVE=live" : "no naive result in results.json"}; sending one naive tx now ...`));
  naive = await runNaive();
  naiveFresh = true;
  writeResults({ naive });
}
const naiveTxCap = Math.min(TX_CAP, Math.floor(BLOCK_BYTES / naive.calldataBytes));
// Batch: one tx carries N ops; bytes cap no longer binds, so the tx cap times N is the ceiling (model).
const batchOpsCap = Math.min(TX_CAP * N, Math.floor(BLOCK_BYTES / batchInput) * N);
table(
  [
    ["", "naive (1 sig on chain)", `Sigpress batch (${fmt(N)} ops)`],
    ["bytes on chain per op", red(`${fmt(naive.calldataBytes)} B`), green(`${fmt(batchBytesPerOp, 2)} B`)],
    ["gas charged per op", fmt(naive.gasUsed), green(fmt(batchGas / N))],
    ["transactions", fmt(1), `1 for ${fmt(N)} ops`],
    [`PQ ops/block, sig bytes only ${yellow("(model)")}`, red(fmt(naiveTxCap)), green(fmt(batchOpsCap))],
  ],
  ["l", "r", "r"],
);
console.log(dim(`  (model) = min(${fmt(TX_CAP)} tx cap, ${fmt(BLOCK_BYTES)} B ÷ bytes per tx) × ops per tx. Counts signature bytes only:`));
console.log(dim(`  it ignores each op's own execution gas (executeFromBatch measured ~135k gas), so it is a ceiling, not live TPS.`));
console.log(`\n  naive tx  ${cyan(txLink(explorer, naive.txHash as Hash))}${naiveFresh ? "" : dim(" (from results.json)")}`);
console.log(`  batch tx  ${cyan(txLink(explorer, batchTx))}`);
console.log(`  ${bold(`${fmt(naive.calldataBytes / batchBytesPerOp)}x fewer bytes per op.`)} ${dim("Optimistic: signatures are checked off chain, a bonded challenge catches fraud (Beat 4).")}`);
stage.comparison = { naiveTx: naive.txHash, naiveFresh, naiveBytesPerOp: naive.calldataBytes, naiveGasPerOp: naive.gasUsed, batchBytesPerOp, batchGasPerOp: batchGas / N, at: new Date().toISOString() };
await pause("Beat 4 (tamper)");

// ---------- Beat 4: tamper ----------
beat(4, `Flip ONE bit in ONE of ${fmt(N)} signatures`, LIVE);
const evil = buildBatch({ n: N, chainId, aggregator: d.aggregator, seedTag: `${runTag}-bad-`, tamperIndex: BAD });
console.log(`  dishonest aggregator flips 1 bit in signature #${BAD} and posts the batch with its bond`);
const evilTx = await walletClient.writeContract({
  address: d.aggregator,
  abi: aggregatorAbi,
  functionName: "submitBatch",
  args: [evil.tree.root, N, evil.dataURI],
  value: bond,
});
const evilReceipt = await confirm("submitBatch (tampered)", evilTx);
const evilEv = parseEventLogs({ abi: aggregatorAbi, logs: evilReceipt.logs, eventName: "BatchSubmitted" })[0];
if (!evilEv) throw new Error("tampered submitBatch receipt has no BatchSubmitted event");
const evilId = evilEv.args.id;
const tCheck = performance.now();
const bad = evil.ops.findIndex((o) => !verify(o.pkHash, o.m, o.sig));
const checkMs = performance.now() - tCheck;
if (bad < 0) throw new Error("challenger found no bad signature");
console.log(`  challenger re-checks all ${fmt(N)} signatures off chain in ${fmt(checkMs)} ms → ${red(`signature #${bad} is INVALID`)}`);
const op = evil.ops[bad]!;
const proof = evil.tree.proof(bad);
if (!verifyProof(evil.tree.root, leafOf(op.pkHash, op.m, op.sig), bad, proof)) throw new Error("local Merkle proof for the bad leaf does not verify");
const challengeTx = await walletClient.writeContract({
  address: d.aggregator,
  abi: aggregatorAbi,
  functionName: "challenge",
  args: [evilId, op.pkHash, op.m, op.sig, BigInt(bad), proof],
});
const chReceipt = await confirm("challenge", challengeTx);
const slashedEv = parseEventLogs({ abi: aggregatorAbi, logs: chReceipt.logs, eventName: "BatchSlashed" });
const onchain = await publicClient.readContract({ address: d.aggregator, abi: aggregatorAbi, functionName: "batches", args: [evilId] });
const slashed = onchain[4] && slashedEv.length > 0;
if (!slashed) throw new Error(`batch ${evilId} not marked slashed after challenge ${challengeTx}`);
console.log(`\n  ${bold(color ? "\x1b[41;97m BATCH REJECTED, bond slashed \x1b[0m" : "BATCH REJECTED, bond slashed")}  ${dim(`batch #${evilId}, ${formatEther(bond)} MON to the challenger`)}`);
console.log(`  the contract re-ran WOTS verify on chain for that one signature (${fmt(Number(chReceipt.gasUsed))} gas charged)`);
console.log(`  ${cyan(txLink(explorer, challengeTx))}`);
console.log(dim(`  "One bad signature, the whole batch rejected — on chain, not on trust."`));
stage.tamper = { submitTx: evilTx, challengeTx, batchId: Number(evilId), badIndex: bad, slashed, challengeGas: Number(chReceipt.gasUsed), checkMs: Math.round(checkMs), at: new Date().toISOString() };
stage.finishedAt = new Date().toISOString();
writeResults({ tamper: { submitTx: evilTx, challengeTx, slashed }, stage });
console.log("\n" + line("━"));
console.log(`${green("✓")} ${bold("demo complete")} ${dim(`· ${stage.startedAt} → ${stage.finishedAt}`)}`);
rl?.close();

// ---------- helpers ----------
interface NaiveResult { txHash: string; gasUsed: number; calldataBytes: number }

function readNaiveFromResults(): NaiveResult | undefined {
  const p = resolve(AGG_DIR, "out/results.json");
  const alt = resolve(AGG_DIR, "../web/public/results.json");
  for (const f of [p, alt]) {
    if (!existsSync(f)) continue;
    try {
      const n = (JSON.parse(readFileSync(f, "utf8")) as { naive?: NaiveResult }).naive;
      if (n?.txHash && n.gasUsed && n.calldataBytes) return n;
    } catch {
      /* fall through */
    }
  }
  return undefined;
}

async function runNaive(): Promise<NaiveResult> {
  const seed = keccak256(toBytes(`${runTag}-naive`));
  const key = keygen(seed, 0);
  const next = keygen(seed, 1);
  const m = messageOf(chainId, d.naiveLane, key.pkHash, next.pkHash, keccak256(toBytes("naive payload")));
  const sig = sign(key.sk, m);
  if (!verify(key.pkHash, m, sig)) throw new Error("naive: local verify failed");
  const hash = await walletClient.writeContract({ address: d.naiveLane, abi: naiveLaneAbi, functionName: "submit", args: [key.pkHash, m, sig] });
  const r = await confirm("naive submit", hash);
  const calldataBytes = hexToBytes((await publicClient.getTransaction({ hash })).input).length;
  return { txHash: hash, gasUsed: Number(r.gasUsed), calldataBytes };
}
