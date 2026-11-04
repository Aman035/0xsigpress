// K9 fix: N WOTS-signed ops from SigpressAccounts go into one OptimisticAggregator batch; after the window the
// batch is finalized and ONE SigpressEntry.executeBundle() tx runs the whole batch from a packed bundle
// (root recomputed on chain, no per-op proofs). Then measures bytes per op and gas.
//   KEY_VAR=PRIVATE_KEY_K9 pnpm compact
//   env: OPS (4), ACCOUNTS (min(OPS, 32); ops are spread round-robin, so an account may sign several ops in
//        one bundle with chained keys), FUND (0.0005 per new account), SEND (0.0001), ACCOUNT_SEED,
//        GAS_MULT (1.15, gas limit = eth_estimateGas × this), COMPACT_DEPLOYMENTS (deployments-compact.json)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  formatEther,
  getAddress,
  hexToBytes,
  keccak256,
  parseEther,
  parseEventLogs,
  serializeTransaction,
  size,
  slice,
  toBytes,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { AGG_DIR, getClients, txLink } from "../src/chain.ts";
import { aggregatorAbi } from "../src/abi.ts";
import { keygen } from "../src/wots.ts";
import { MerkleTree } from "../src/merkle.ts";
import { bundleCalldata, entryAbi, sigpressAccountAbi, signCompactOp, type CompactOp } from "../src/compact.ts";

const N = Number(process.env.OPS ?? 4);
const A = Number(process.env.ACCOUNTS ?? Math.min(N, 32));
const SEED_TAG = process.env.ACCOUNT_SEED ?? "sigpress-compact";
const FUND = parseEther(process.env.FUND ?? "0.0005");
const SEND = parseEther(process.env.SEND ?? "0.0001");
const GAS_MULT = Number(process.env.GAS_MULT ?? 1.15);
const RECIPIENT: Address = getAddress(process.env.RECIPIENT ?? slice(keccak256(toBytes("sigpress-recipient")), 12));
const depPath = process.env.COMPACT_DEPLOYMENTS ? resolve(process.env.COMPACT_DEPLOYMENTS) : resolve(AGG_DIR, "deployments-compact.json");
const d = JSON.parse(readFileSync(depPath, "utf8")) as { entry: Address; batches: Address; explorer: string };

const { chainId, publicClient, walletClient, account, rpc } = await getClients();
const explorer = chainId === 10143 ? d.explorer : undefined;
const mult = (g: bigint) => (g * BigInt(Math.round(GAS_MULT * 1000))) / 1000n;
async function send(label: string, hash: Hash) {
  console.log(`${label} ${txLink(explorer, hash)}`);
  const r = await publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  return r;
}
const startBal = await publicClient.getBalance({ address: account.address });
console.log(`EOA ${account.address} (${formatEther(startBal)} MON), chain ${chainId}, entry ${d.entry}, batches ${d.batches}`);
console.log(`OPS ${N}, ACCOUNTS ${A}, SEND ${formatEther(SEND)}`);

// --- 1. create missing accounts (one tx per 32, funded in the same tx); key at nonce k is keygen(seed, k) ---
const seedOf = (i: number) => keccak256(toBytes(`${SEED_TAG}-${i}`));
let count = Number(await publicClient.readContract({ address: d.entry, abi: entryAbi, functionName: "accountCount" }));
const createTxs: Hash[] = [];
while (count < A) {
  const k = Math.min(32, A - count);
  const pks = Array.from({ length: k }, (_, j) => keygen(seedOf(count + j), 0).pkHash);
  const value = FUND * BigInt(k);
  const est = await publicClient.estimateContractGas({ address: d.entry, abi: entryAbi, functionName: "createAccounts", args: [pks], value, account });
  const h = await walletClient.writeContract({ address: d.entry, abi: entryAbi, functionName: "createAccounts", args: [pks], value, gas: mult(est) });
  await send(`createAccounts ${count}..${count + k - 1} (est ${est})`, h);
  createTxs.push(h);
  count += k;
}
if (SEED_TAG !== "sigpress-compact" && count > A) console.warn("note: accounts beyond ACCOUNTS exist; indices are shared across seed tags");

interface Acct { index: number; seed: Hex; address: Address; nonce: bigint }
const opsPer = Math.ceil(N / A);
const accts: Acct[] = [];
for (let i = 0; i < A; i++) {
  const address = await publicClient.readContract({ address: d.entry, abi: entryAbi, functionName: "accountOf", args: [BigInt(i)] });
  const nonce = await publicClient.readContract({ address, abi: sigpressAccountAbi, functionName: "nonce" });
  const pk = await publicClient.readContract({ address, abi: sigpressAccountAbi, functionName: "pkHash" });
  const seed = seedOf(i);
  if (pk.toLowerCase() !== keygen(seed, Number(nonce)).pkHash.toLowerCase()) throw new Error(`account ${i}: key is not keygen(seed, ${nonce})`);
  const bal = await publicClient.getBalance({ address });
  const need = SEND * BigInt(opsPer);
  if (bal < need) {
    // the clone's receive() delegatecalls the implementation, so a 21k-gas transfer is not enough
    const g = await publicClient.estimateGas({ account, to: address, value: FUND });
    await send(`top up account ${i}`, await walletClient.sendTransaction({ to: address, value: FUND, gas: mult(g) }));
  }
  accts.push({ index: i, seed, address, nonce });
}

// --- 2. sign N ops round-robin (chained keys / nonces when an account signs more than one) ---
const ops: CompactOp[] = [];
for (let j = 0; j < N; j++) {
  const a = accts[j % A]!;
  ops.push(
    signCompactOp({ seed: a.seed, keyIndex: Number(a.nonce), index: a.index, account: a.address, nonce: a.nonce, chainId, entry: d.entry, call: { target: RECIPIENT, value: SEND, data: "0x" } }),
  );
  a.nonce += 1n;
}

// --- 3. one optimistic batch; wait out the window; finalize ---
const tree = new MerkleTree(ops.map((o) => o.leaf));
const outDir = resolve(AGG_DIR, "out");
mkdirSync(outDir, { recursive: true });
const daName = `compact-batch-${tree.root}.json`;
writeFileSync(resolve(outDir, daName), JSON.stringify({ root: tree.root, chainId, entry: d.entry, ops }, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
const bond = await publicClient.readContract({ address: d.batches, abi: aggregatorAbi, functionName: "bond" });
const submitTx = await walletClient.writeContract({ address: d.batches, abi: aggregatorAbi, functionName: "submitBatch", args: [tree.root, ops.length, `sigpress-da:${daName}`], value: bond });
const subReceipt = await send("submitBatch", submitTx);
const ev = parseEventLogs({ abi: aggregatorAbi, logs: subReceipt.logs, eventName: "BatchSubmitted" })[0];
if (!ev) throw new Error("no BatchSubmitted event");
const batchId = ev.args.id;
const [, , deadline] = await publicClient.readContract({ address: d.batches, abi: aggregatorAbi, functionName: "batches", args: [batchId] });
console.log(`batch ${batchId}, root ${tree.root}, deadline ${deadline}`);
let lastLog = 0;
for (;;) {
  const { timestamp } = await publicClient.getBlock({ blockTag: "latest" });
  if (timestamp >= deadline) break;
  if (Date.now() - lastLog > 15_000) {
    console.log(`waiting for challenge window: ${deadline - timestamp}s left`);
    lastLog = Date.now();
  }
  await new Promise((r) => setTimeout(r, 2000));
}
const finalizeTx = await walletClient.writeContract({ address: d.batches, abi: aggregatorAbi, functionName: "finalize", args: [batchId] });
await send("finalize", finalizeTx);

// --- 4. ONE executeBundle tx for the whole batch ---
const data = bundleCalldata(batchId, ops);
const estimate = await publicClient.estimateGas({ account, to: d.entry, data });
const before = await publicClient.getBalance({ address: RECIPIENT });
const execTx = await walletClient.sendTransaction({ to: d.entry, data, gas: mult(estimate) });
const r = await send(`executeBundle (${N} ops, estimate ${estimate})`, execTx);
const executed = parseEventLogs({ abi: sigpressAccountAbi, logs: r.logs, eventName: "Executed" });
const after = await publicClient.getBalance({ address: RECIPIENT });
if (executed.length !== N || !executed.every((e) => e.args.success)) throw new Error(`expected ${N} successful Executed events, got ${executed.length}`);
if (after - before !== SEND * BigInt(N)) throw new Error(`recipient got ${formatEther(after - before)}`);

// --- 5. bytes ---
const tx = await publicClient.getTransaction({ hash: execTx });
let raw: Hex | undefined;
try {
  raw = (await publicClient.request({ method: "eth_getRawTransactionByHash" as any, params: [execTx] as any })) as Hex;
} catch {
  raw = undefined;
}
const reserialised = serializeTransaction(
  { chainId, type: tx.type as "eip1559", nonce: tx.nonce, to: tx.to!, value: tx.value, data: tx.input, gas: tx.gas, maxFeePerGas: tx.maxFeePerGas!, maxPriorityFeePerGas: tx.maxPriorityFeePerGas!, accessList: tx.accessList },
  { r: tx.r, s: tx.s, yParity: tx.yParity! },
);
if (keccak256(reserialised) !== execTx) throw new Error("re-serialised tx hash mismatch");
if (raw && raw !== reserialised) throw new Error("eth_getRawTransactionByHash differs from re-serialised tx");
const inputBytes = size(tx.input);
const rawBytes = size(reserialised);
const zero = hexToBytes(tx.input).filter((b) => b === 0).length;
const endBal = await publicClient.getBalance({ address: account.address });
const result = {
  chainId,
  rpc,
  entry: d.entry,
  batches: d.batches,
  batchId: Number(batchId),
  ops: N,
  accounts: A,
  opsPerAccountMax: opsPer,
  amountEach: formatEther(SEND),
  createTxs,
  submitTx,
  finalizeTx,
  executeBundleTx: execTx,
  bytes: {
    inputBytes,
    inputZeroBytes: zero,
    rawTxBytes: rawBytes,
    rawFromRpc: raw !== undefined,
    inputBytesPerOp: +(inputBytes / N).toFixed(1),
    rawTxBytesPerOp: +(rawBytes / N).toFixed(1),
    opEncodingBytes: (inputBytes - 8) / N,
  },
  gas: {
    estimate: Number(estimate),
    gasLimit: Number(tx.gas),
    gasUsedReceipt: Number(r.gasUsed),
    estimatePerOp: Math.round(Number(estimate) / N),
    chargedPerOp: Math.round(Number(r.gasUsed) / N),
    effectiveGasPrice: Number(r.effectiveGasPrice),
  },
  spentThisRunMON: formatEther(startBal - endBal),
};
console.log(JSON.stringify(result, null, 2));
writeFileSync(resolve(outDir, `compact-results-${N}.json`), JSON.stringify(result, null, 2) + "\n");
