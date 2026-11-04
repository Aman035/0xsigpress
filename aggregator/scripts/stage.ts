// One command for the live demo: the four beats from docs/demo.md, on Monad testnet.
//   Beat 1  capacity model (K1 arithmetic, labelled as a model, not live TPS)
//   Beat 2  sign N ops, submit one batch (live tx)
//   Beat 3  naive vs batch comparison (naive from results.json, or a live naive tx if missing)
//   Beat 4  tamper: one flipped bit -> challenger finds it off chain -> challenge -> slashed (live txs)
//   Beat 5  the headline: the trustless validity proof (binding v2). A pre-built STARK over 2 x 1024 leanXMSS signers,
//           each over its own message, submitted to SigpressBindV2Gate in ONE live tx; tamper / wrong-message /
//           swapped-batch eth_calls revert before it, and a replay eth_call reverts after it. No live proving.
// Env: N (default 256), BAD_INDEX (default 7), STEP=1 (wait for Enter between beats),
//      NAIVE=live (send a fresh naive tx instead of reading results.json), RPC_URL, DEPLOYMENTS,
//      VALIDITY=1|0 (Beat 5 on / off; default: on if a pre-built, not yet accepted proof exists),
//      VALIDITY_SHAPE (default 2x1024), PROOF_DIR (proof for Beat 5; default: latest fresh one under out/validity/,
//      made by `SHAPE=2x1024 PROVE_ONLY=1 pnpm validity`).
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { formatEther, hexToBytes, keccak256, parseEventLogs, toBytes, type Hash, type TransactionReceipt } from "viem";
import { AGG_DIR, CHALLENGE_GAS, getClients, loadDeployments, txLink } from "../src/chain.ts";
import { aggregatorAbi, naiveLaneAbi } from "../src/abi.ts";
import { buildBatch } from "../src/batch.ts";
import { keygen, sign, verify } from "../src/wots.ts";
import { leafOf, messageOf } from "../src/op.ts";
import { verifyProof } from "../src/merkle.ts";
import { writeResults } from "../src/results.ts";
import { gateV2Abi, latestProofDir, loadShape, NOT_BOUND, parseShape, readProof, submitProofV2, type ProofMeta } from "../src/validity.ts";

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
// One readline for the whole run. Enter only counts while a pause is waiting, so an accidental extra
// press can't skip a beat (and piped `yes` can't flood memory). If stdin ends, remaining pauses continue.
const rl = STEP ? createInterface({ input: process.stdin }) : undefined;
const waiters: (() => void)[] = [];
let stdinClosed = false;
rl?.on("line", () => waiters.shift()?.());
rl?.on("close", () => {
  stdinClosed = true;
  while (waiters.length) waiters.shift()!();
});
async function pause(next: string) {
  if (!rl) return;
  process.stdout.write(dim(`\n  press Enter for ${next} ...`));
  if (!stdinClosed) await new Promise<void>((r) => waiters.push(r));
  process.stdout.write("\n");
}

// ---------- setup ----------
const N = Number(process.env.N ?? 256);
// Measured on Monad testnet by `pnpm compact` (128-op executeBundle): bytes per executed op.
const COMPACT_BPO = (() => {
  try {
    const c = JSON.parse(readFileSync(new URL("../deployments-compact.json", import.meta.url), "utf8"));
    return Number(c.runs?.["128"]?.rawTxBytesPerOp ?? 98);
  } catch { return 98; }
})();
const COMPACT_GAS_PER_OP = (() => {
  try {
    const c = JSON.parse(readFileSync(new URL("../deployments-compact.json", import.meta.url), "utf8"));
    const r = c.runs?.["128"];
    return r ? Math.round(r.gasCharged / 128) : 27184;
  } catch { return 27184; }
})();
const BAD = Number(process.env.BAD_INDEX ?? 7);
if (!Number.isInteger(N) || N < 1 || N > 4096) throw new Error(`N must be an integer 1..4096 (got ${process.env.N})`);
if (!Number.isInteger(BAD) || BAD < 0 || BAD >= N) throw new Error(`BAD_INDEX must be in 0..${N - 1}`);

const d = loadDeployments();
const clients = await getClients();
const { chainId, publicClient, walletClient, account } = clients;
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
// Beat 5 setup, checked up front so a missing proof or low balance fails before Beat 1.
const vShape = parseShape(process.env.VALIDITY_SHAPE, "2x1024");
const vTarget = process.env.VALIDITY === "0" ? undefined : loadShape(vShape, chainId);
const isFresh = async (m: ProofMeta) => !(await publicClient.readContract({ address: vTarget!.gate, abi: gateV2Abi, functionName: "accepted", args: [m.commitment] }));
const vDir = !vTarget ? undefined : process.env.PROOF_DIR ? resolve(process.env.PROOF_DIR) : await latestProofDir(vShape, isFresh);
const VALIDITY = process.env.VALIDITY === "1" || (process.env.VALIDITY === undefined && !!vDir);
if (process.env.VALIDITY === "1" && !vDir)
  throw new Error(`VALIDITY=1 needs a pre-built ${vShape} proof not yet accepted by the gate: run \`SHAPE=${vShape} PROVE_ONLY=1 pnpm validity\` first or set PROOF_DIR`);
if (VALIDITY && vTarget && vDir) {
  const { meta } = readProof(vDir);
  if (!(await isFresh(meta))) throw new Error(`${vDir} was already accepted by the gate (replays revert AlreadyAccepted); prove a fresh one`);
  const gasPrice = await publicClient.getGasPrice();
  const g = meta.shape === "2x1024" ? 23_500_000n : 17_000_000n; // ~estimate + 5% (Monad charges the limit)
  const need = 3n * bond + gasPrice * g;
  console.log(dim(`  Beat 5: proof ${relative(AGG_DIR, vDir)} · ${meta.shape} gate ${vTarget.gate} · needs ~${formatEther(gasPrice * g)} MON`));
  if (balance < need) throw new Error(`balance ${formatEther(balance)} MON too low for Beat 5: need ~${formatEther(need)} MON (or VALIDITY=0)`);
} else console.log(dim(`  Beat 5 off (${process.env.VALIDITY === "0" ? "VALIDITY=0" : `no pre-built ${vShape} proof that the gate has not accepted yet`})`));
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
console.log(`  ${bold("Naive ML-DSA cuts the block ceiling ~85-90% at 400 B/tx (MIP-12 math), 58-76% at today's measured mainnet mix (1,728 B avg tx).")} ${dim("Block capacity, not measured throughput.")}`);
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
table(
  [
    ["", "naive (1 sig on chain)", `Sigpress batch (${fmt(N)} ops)`],
    ["signature bytes on chain per op", red(`${fmt(naive.calldataBytes)} B`), green(`${fmt(batchBytesPerOp, 2)} B`)],
    [`whole executed op on chain ${dim("(compact bundle)")}`, red(`${fmt(naive.calldataBytes)} B`), green(`${fmt(COMPACT_BPO + batchBytesPerOp, 1)} B`)],
    ["gas charged per op: batch root only", fmt(naive.gasUsed), green(fmt(batchGas / N))],
    [`gas charged per executed op ${dim("(compact bundle)")}`, fmt(naive.gasUsed), green(fmt(COMPACT_GAS_PER_OP + batchGas / N))],
    ["transactions", fmt(1), `1 for ${fmt(N)} ops`],
    [`PQ ops per 1.5 MB block, bytes only ${yellow("(model)")}`, red(fmt(naiveTxCap)), green(fmt(Math.floor(BLOCK_BYTES / (COMPACT_BPO + batchBytesPerOp))))],
  ],
  ["l", "r", "r"],
);
console.log(dim(`  (model) = ${fmt(BLOCK_BYTES)} B ÷ bytes per executed op (naive also capped at ${fmt(TX_CAP)} tx). Bytes only: gas (~${fmt(COMPACT_GAS_PER_OP)}/op`));
console.log(dim(`  measured) would cap a 150M-gas block near ${fmt(Math.floor(150_000_000 / COMPACT_GAS_PER_OP))} ops. A ceiling, not live TPS.`));
console.log(`\n  naive tx  ${cyan(txLink(explorer, naive.txHash as Hash))}${naiveFresh ? "" : dim(" (from results.json)")}`);
console.log(`  batch tx  ${cyan(txLink(explorer, batchTx))}`);
console.log(`  ${bold(`${fmt(naive.calldataBytes / (COMPACT_BPO + batchBytesPerOp))}x fewer bytes per executed op`)} ${dim(`(compact bundle measured on testnet: ${COMPACT_BPO} B/op at 128 ops).`)}`);
console.log(`  ${dim("Signature overhead alone:")} ${bold(`${fmt(naive.calldataBytes / batchBytesPerOp)}x smaller.`)} ${dim("Optimistic: signatures are checked off chain, a bonded challenge catches fraud (Beat 4).")}`);
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
  gas: CHALLENGE_GAS, // Monad's estimate for challenge is ~2.5M vs <=188k executed; fixed cap (charged on the limit)
});
const chReceipt = await confirm("challenge", challengeTx);
const slashedEv = parseEventLogs({ abi: aggregatorAbi, logs: chReceipt.logs, eventName: "BatchSlashed" });
const onchain = await publicClient.readContract({ address: d.aggregator, abi: aggregatorAbi, functionName: "batches", args: [evilId] });
const slashed = onchain[4] && slashedEv.length > 0;
if (!slashed) throw new Error(`batch ${evilId} not marked slashed after challenge ${challengeTx}`);
console.log(`\n  ${bold(color ? "\x1b[41;97m BATCH REJECTED, bond slashed \x1b[0m" : "BATCH REJECTED, bond slashed")}  ${dim(`batch #${evilId}: half the ${formatEther(bond)} MON bond to the challenger, the rest burnt`)}`);
console.log(`  the contract re-ran WOTS verify on chain for that one signature (${fmt(Number(chReceipt.gasUsed))} gas charged)`);
console.log(`  ${cyan(txLink(explorer, challengeTx))}`);
console.log(dim(`  "One bad signature, the whole batch rejected — on chain, not on trust."`));
stage.tamper = { submitTx: evilTx, challengeTx, batchId: Number(evilId), badIndex: bad, slashed, challengeGas: Number(chReceipt.gasUsed), checkMs: Math.round(checkMs), at: new Date().toISOString() };
writeResults({ tamper: { submitTx: evilTx, challengeTx, slashed }, stage });

// ---------- Beat 5: the trustless validity proof ----------
if (VALIDITY && vTarget && vDir) {
  await pause("Beat 5 (validity proof)");
  const { meta } = readProof(vDir);
  beat(5, `${fmt(meta.signatures)} post-quantum signatures, ONE STARK, ONE tx, no trusted party`, LIVE);
  console.log(`  ${bold(fmt(meta.signatures))} leanXMSS signers (2 batches x ${fmt(meta.perChild)}), ${bold("each over its own 32-byte message")}${meta.distinctMessages ? dim(" (all distinct)") : ""}`);
  console.log(`  ${dim(meta.source === "sdk" ? "fresh user keys from the TS SDK; each signed its own op hash" : "prover-generated test keys, one message per signer")}`);
  console.log(`  proved off chain ${dim(`before the demo (${meta.createdAt}${meta.proveSeconds ? `, ${meta.proveSeconds} s wall on a 16 GB M4` : ""}) — not proved live`)}`);
  console.log(dim(`  leanVM aggregation x2 -> lift x2 -> Keccak terminal root proof (${fmt(meta.terminalProofBytes ?? 0)} B) -> generated Solidity verifier`));
  console.log(dim(`  the gate rebuilds the proof's statement from the ${fmt(meta.signatures)} raw pubkeys + messages in calldata (no registrar)`));
  const v = await submitProofV2(clients, vDir, vTarget, (s) => console.log(dim(`  ${s}`)));
  console.log(`  ${green("✓")} gate.submit: STARK verified and bound to every (pubkey, message) on chain, accepted=${v.accepted}`);
  console.log(`  ${cyan(txLink(explorer, v.txHash))}`);
  console.log(`  gas charged ${bold(fmt(v.gasCharged))} ${dim(`(estimate ${fmt(v.gasEstimate)} + 5%; Monad charges the limit)`)} · calldata ${bold(`${fmt(v.calldataBytes)} B`)} · ${bold("1 tx")}`);
  console.log(`  per signature: ${bold(green(`${fmt(v.gasPerSig)} gas`))} and ${bold(green(`${fmt(v.bytesPerSig, 1)} B`))} ${dim("(the ~12M verifier is flat; binding adds ~3-4k gas and 64 B per signer)")}`);
  if (naive) console.log(dim(`  vs naive WOTS on chain: ${fmt(naive.gasUsed)} gas and ${fmt(naive.calldataBytes)} B per signature`));
  for (const n of v.negatives) {
    const what = { "tampered-proof": "1 bit flipped in the proof", "wrong-message": "one signer's message changed", "wrong-signer": "one pubkey changed", "swap-batches": "the two batches swapped", "wrong-slot": "slot + 1", "wrong-commitment": "prover commitment changed", replay: "same submit again (replay)", "": "unmodified" }[n.name];
    console.log(`  ${pad(what ?? n.name, 34)} eth_call: ${n.reverted ? red(`REVERTS ${n.reason}`) : yellow("did not revert")}`);
  }
  console.log(`\n  ${bold(yellow("Bound on chain:"))} slot, every signer's pubkey, every signer's own message, order and count, both batches.`);
  console.log(`  ${bold(yellow("Not bound / limits:"))}`);
  for (const n of NOT_BOUND) console.log(dim(`   - ${n}`));
  stage.validity = { txHash: v.txHash, gasCharged: v.gasCharged, gasPerSig: v.gasPerSig, bytesPerSig: v.bytesPerSig, signatures: v.signatures, shape: v.shape, proofDir: relative(AGG_DIR, vDir), negatives: v.negatives, at: v.at };
  writeResults({ validityStage: { ...v, proofDir: relative(AGG_DIR, vDir) }, stage });
}
stage.finishedAt = new Date().toISOString();
writeResults({ stage });
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
