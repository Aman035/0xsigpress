// Accepted batch -> real on-chain effect: N PQAccounts each send a tiny transfer, authorised only by a
// finalized batch (no on-chain signature check), then one executeDirect for comparison.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatEther, getAddress, keccak256, parseEther, parseEventLogs, slice, toBytes, type Address, type Hash, type Hex } from "viem";
import { AGG_DIR, getClients, loadDeployments, txLink } from "../src/chain.ts";
import { aggregatorAbi, pqAccountAbi, pqAccountFactoryAbi } from "../src/abi.ts";
import { signAccountOp, type AccountOp } from "../src/account.ts";
import { keygen } from "../src/wots.ts";
import { MerkleTree } from "../src/merkle.ts";
import { writeResults } from "../src/results.ts";

const N = Number(process.env.ACCOUNTS ?? 4);
const SEED_TAG = process.env.ACCOUNT_SEED ?? "sigpress-account";
const FUND = parseEther(process.env.FUND ?? "0.001");
const SEND = parseEther(process.env.SEND ?? "0.0001");
const RECIPIENT: Address = getAddress(process.env.RECIPIENT ?? slice(keccak256(toBytes("sigpress-recipient")), 12));
const SALT: Hex = `0x${"00".repeat(32)}`;

const d = loadDeployments();
if (!d.factory) throw new Error("deployments has no factory (PQAccountFactory) address");
const factory = d.factory;
const { chainId, publicClient, walletClient, account } = await getClients();
const explorer = chainId === 10143 ? d.explorer : undefined;

async function send(label: string, hash: Hash) {
  console.log(`${label} ${txLink(explorer, hash)}`);
  const r = await publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  return r;
}

console.log(`deployer ${account.address}, chain ${chainId}, factory ${factory}, aggregator ${d.aggregator}, recipient ${RECIPIENT}`);

// --- 1. create (or reuse) N accounts and fund them ---
interface Acct { seed: Hex; address: Address; nonce: bigint; keyIndex: number }
const accts: Acct[] = [];
for (let i = 0; i < N; i++) {
  const seed = keccak256(toBytes(`${SEED_TAG}-${i}`));
  const pk0 = keygen(seed, 0).pkHash;
  const address = await publicClient.readContract({ address: factory, abi: pqAccountFactoryAbi, functionName: "addressOf", args: [pk0, SALT] });
  const code = await publicClient.getCode({ address });
  if (!code || code === "0x") {
    await send(`create account ${i}`, await walletClient.writeContract({ address: factory, abi: pqAccountFactoryAbi, functionName: "create", args: [pk0, SALT] }));
  } else {
    console.log(`account ${i} exists at ${address}`);
  }
  const nonce = await publicClient.readContract({ address, abi: pqAccountAbi, functionName: "nonce" });
  const onchainPk = await publicClient.readContract({ address, abi: pqAccountAbi, functionName: "pkHash" });
  // Convention: the key at nonce k is keygen(seed, k), because every op rotates to keyIndex + 1.
  const keyIndex = Number(nonce);
  if (onchainPk.toLowerCase() !== keygen(seed, keyIndex).pkHash.toLowerCase()) throw new Error(`account ${i}: on-chain key is not keygen(seed, ${keyIndex})`);
  const bal = await publicClient.getBalance({ address });
  if (bal < 2n * SEND) {
    await send(`fund account ${i} ${formatEther(FUND)}`, await walletClient.sendTransaction({ to: address, value: FUND }));
  }
  console.log(`account ${i} ${address} nonce ${nonce} balance ${formatEther(await publicClient.getBalance({ address }))}`);
  accts.push({ seed, address, nonce, keyIndex });
}

// --- 2. sign one transfer per account and submit the batch root ---
const call = { target: RECIPIENT, value: SEND, data: "0x" as Hex };
const ops: AccountOp[] = accts.map((a) =>
  signAccountOp({ seed: a.seed, keyIndex: a.keyIndex, account: a.address, nonce: a.nonce, chainId, aggregator: d.aggregator, call }),
);
const tree = new MerkleTree(ops.map((o) => o.leaf));
const outDir = resolve(AGG_DIR, "out");
mkdirSync(outDir, { recursive: true });
const daName = `execute-batch-${tree.root}.json`;
writeFileSync(
  resolve(outDir, daName),
  JSON.stringify({ root: tree.root, count: ops.length, chainId, aggregator: d.aggregator, ops }, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2),
);

const bond = await publicClient.readContract({ address: d.aggregator, abi: aggregatorAbi, functionName: "bond" });
const windowSec = await publicClient.readContract({ address: d.aggregator, abi: aggregatorAbi, functionName: "window" });
const submitTx = await walletClient.writeContract({
  address: d.aggregator,
  abi: aggregatorAbi,
  functionName: "submitBatch",
  args: [tree.root, ops.length, `sigpress-da:${daName}`],
  value: bond,
});
const subReceipt = await send("submitBatch", submitTx);
const ev = parseEventLogs({ abi: aggregatorAbi, logs: subReceipt.logs, eventName: "BatchSubmitted" })[0];
if (!ev) throw new Error("no BatchSubmitted event");
const batchId = ev.args.id;
const [, , deadline] = await publicClient.readContract({ address: d.aggregator, abi: aggregatorAbi, functionName: "batches", args: [batchId] });
console.log(`batch ${batchId}, root ${tree.root}, window ${windowSec}s, deadline ${deadline}`);

// --- 3. wait out the challenge window (by block timestamp), then finalize ---
let lastLog = 0;
for (;;) {
  const { timestamp } = await publicClient.getBlock({ blockTag: "latest" });
  if (timestamp >= deadline) break;
  if (Date.now() - lastLog > 10_000) {
    console.log(`waiting for challenge window: ${deadline - timestamp}s left (block ts ${timestamp})`);
    lastLog = Date.now();
  }
  await new Promise((r) => setTimeout(r, 2000));
}
const finalizeTx = await walletClient.writeContract({ address: d.aggregator, abi: aggregatorAbi, functionName: "finalize", args: [batchId] });
await send("finalize", finalizeTx);

// --- 4. each account executes its op from the accepted batch ---
const before = await publicClient.getBalance({ address: RECIPIENT });
const executeTxs: { account: Address; txHash: Hash; gasUsed: number }[] = [];
for (let i = 0; i < ops.length; i++) {
  const o = ops[i]!;
  const hash = await walletClient.writeContract({
    address: o.account,
    abi: pqAccountAbi,
    functionName: "executeFromBatch",
    args: [batchId, o.nextPkHash, o.target, o.value, o.data, BigInt(i), tree.proof(i), o.sigHash],
  });
  const r = await send(`executeFromBatch account ${i}`, hash);
  executeTxs.push({ account: o.account, txHash: hash, gasUsed: Number(r.gasUsed) });
}
const after = await publicClient.getBalance({ address: RECIPIENT });
if (after - before !== SEND * BigInt(ops.length)) throw new Error(`recipient got ${formatEther(after - before)}, expected ${formatEther(SEND * BigInt(ops.length))}`);
const gasPerExecute = Math.round(executeTxs.reduce((s, t) => s + t.gasUsed, 0) / executeTxs.length);
console.log(`recipient +${formatEther(after - before)}; gasPerExecute ${gasPerExecute}`);

// --- 5. single-op fallback for comparison: account 0 executeDirect (WOTS verified on chain) ---
const a0 = accts[0]!;
const direct = signAccountOp({ seed: a0.seed, keyIndex: a0.keyIndex + 1, account: a0.address, nonce: a0.nonce + 1n, chainId, aggregator: d.aggregator, call });
const directTx = await walletClient.writeContract({
  address: a0.address,
  abi: pqAccountAbi,
  functionName: "executeDirect",
  args: [direct.nextPkHash, direct.target, direct.value, direct.data, direct.sig],
});
const directReceipt = await send("executeDirect account 0", directTx);
console.log(`executeDirect gasUsed ${directReceipt.gasUsed}`);

writeResults({
  execute: {
    batchId: Number(batchId),
    submitTx,
    finalizeTx,
    executeTxs,
    gasPerExecute,
    recipient: RECIPIENT,
    amountEach: formatEther(SEND),
    directTx,
    directGas: Number(directReceipt.gasUsed),
  },
});
