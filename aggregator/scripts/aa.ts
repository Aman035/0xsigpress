// K8 / K9: N PQAccount4337s each sign one transfer with a one-time WOTS key; the signatures go into one
// OptimisticAggregator batch; after the window the batch is finalized and ONE EntryPoint v0.8
// handleAggregatedOps call (sent straight from our EOA, no bundler) executes all N ops.
// Then measures calldata bytes per UserOperation (K9).
//   KEY_VAR=PRIVATE_KEY_K8 pnpm aa      env: ACCOUNTS (4), FUND (0.03), SEND (0.0001), ACCOUNT_SEED
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  encodeAbiParameters,
  encodeFunctionData,
  formatEther,
  getAddress,
  hexToBytes,
  keccak256,
  parseAbi,
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
import { keygen, sign } from "../src/wots.ts";
import { leafOf, messageOf } from "../src/op.ts";
import { MerkleTree } from "../src/merkle.ts";

const N = Number(process.env.ACCOUNTS ?? 4);
const SEED_TAG = process.env.ACCOUNT_SEED ?? "sigpress-4337";
const FUND = parseEther(process.env.FUND ?? "0.03");
const SEND = parseEther(process.env.SEND ?? "0.0001");
const RECIPIENT: Address = getAddress(process.env.RECIPIENT ?? slice(keccak256(toBytes("sigpress-recipient")), 12));
const SALT: Hex = `0x${"00".repeat(32)}`;
const VGL = 100_000n;
const CGL = 50_000n;
const PVG = 50_000n;

const d = JSON.parse(readFileSync(resolve(AGG_DIR, "deployments-aa.json"), "utf8")) as {
  entryPoint: Address;
  batches: Address;
  aggregator4337: Address;
  factory4337: Address;
  explorer: string;
};

const OP = "(address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature)";
const epAbi = parseAbi([
  `function getUserOpHash(${OP} userOp) view returns (bytes32)`,
  "function getNonce(address sender, uint192 key) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  `function handleAggregatedOps((${OP}[] userOps, address aggregator, bytes signature)[] opsPerAggregator, address beneficiary)`,
  "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
  "error FailedOp(uint256 opIndex, string reason)",
  "error FailedOpWithRevert(uint256 opIndex, string reason, bytes inner)",
  "error SignatureValidationFailed(address aggregator)",
] as const);
const accountAbi = parseAbi([
  "function pkHash() view returns (bytes32)",
  "function execute(address target, uint256 value, bytes data)",
]);
const factoryAbi = parseAbi([
  "function create(bytes32 pkHash, bytes32 salt) returns (address)",
  "function addressOf(bytes32 pkHash, bytes32 salt) view returns (address)",
]);

interface UserOp {
  sender: Address;
  nonce: bigint;
  initCode: Hex;
  callData: Hex;
  accountGasLimits: Hex;
  preVerificationGas: bigint;
  gasFees: Hex;
  paymasterAndData: Hex;
  signature: Hex;
}
const pack128 = (hi: bigint, lo: bigint): Hex => `0x${hi.toString(16).padStart(32, "0")}${lo.toString(16).padStart(32, "0")}`;
const zeroBytes = (h: Hex) => hexToBytes(h).filter((b) => b === 0).length;

const { chainId, publicClient, walletClient, account } = await getClients();
const explorer = chainId === 10143 ? d.explorer : undefined;
async function send(label: string, hash: Hash) {
  console.log(`${label} ${txLink(explorer, hash)}`);
  const r = await publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  return r;
}

const gasPrice = await publicClient.getGasPrice();
const maxFee = gasPrice + gasPrice / 10n;
const gasFees = pack128(0n, maxFee);
const prefund = (VGL + CGL + PVG) * maxFee;
console.log(`EOA ${account.address}, chain ${chainId}, EntryPoint ${d.entryPoint}, aggregator4337 ${d.aggregator4337}`);
console.log(`gasPrice ${gasPrice}, maxFee ${maxFee}, prefund/op ${formatEther(prefund)} MON`);

// --- 1. create (or reuse) N accounts; key at EntryPoint nonce k is keygen(seed, k) ---
interface Acct { seed: Hex; address: Address; nonce: bigint }
const accts: Acct[] = [];
for (let i = 0; i < N; i++) {
  const seed = keccak256(toBytes(`${SEED_TAG}-${i}`));
  const pk0 = keygen(seed, 0).pkHash;
  const address = await publicClient.readContract({ address: d.factory4337, abi: factoryAbi, functionName: "addressOf", args: [pk0, SALT] });
  const code = await publicClient.getCode({ address });
  if (!code || code === "0x") {
    await send(`create account ${i}`, await walletClient.writeContract({ address: d.factory4337, abi: factoryAbi, functionName: "create", args: [pk0, SALT] }));
  }
  const nonce = (await publicClient.readContract({ address: d.entryPoint, abi: epAbi, functionName: "getNonce", args: [address, 0n] })) as bigint;
  const onchainPk = await publicClient.readContract({ address, abi: accountAbi, functionName: "pkHash" });
  if (onchainPk.toLowerCase() !== keygen(seed, Number(nonce)).pkHash.toLowerCase()) throw new Error(`account ${i}: key is not keygen(seed, ${nonce})`);
  const bal = await publicClient.getBalance({ address });
  const dep = (await publicClient.readContract({ address: d.entryPoint, abi: epAbi, functionName: "balanceOf", args: [address] })) as bigint;
  if (bal + dep < prefund + SEND) {
    await send(`fund account ${i} ${formatEther(FUND)}`, await walletClient.sendTransaction({ to: address, value: FUND }));
  }
  console.log(`account ${i} ${address} nonce ${nonce}`);
  accts.push({ seed, address, nonce });
}

// --- 2. build and WOTS-sign one UserOperation per account ---
const callData = encodeFunctionData({ abi: accountAbi, functionName: "execute", args: [RECIPIENT, SEND, "0x"] });
const signed = [];
for (const a of accts) {
  const k = Number(a.nonce);
  const key = keygen(a.seed, k);
  const next = keygen(a.seed, k + 1);
  const op: UserOp = {
    sender: a.address,
    nonce: a.nonce,
    initCode: "0x",
    callData,
    accountGasLimits: pack128(VGL, CGL),
    preVerificationGas: PVG,
    gasFees,
    paymasterAndData: "0x",
    signature: next.pkHash, // per-op signature field = nextPkHash (32 B); the WOTS sig itself stays off chain
  };
  const userOpHash = (await publicClient.readContract({ address: d.entryPoint, abi: epAbi, functionName: "getUserOpHash", args: [op] })) as Hex;
  const m = messageOf(chainId, d.batches, key.pkHash, next.pkHash, userOpHash);
  const sig = sign(key.sk, m);
  signed.push({ op, userOpHash, m, sig, sigHash: keccak256(sig), leaf: leafOf(key.pkHash, m, sig) });
}

// --- 3. one optimistic batch over the N leaves; wait out the window; finalize ---
const tree = new MerkleTree(signed.map((s) => s.leaf));
const outDir = resolve(AGG_DIR, "out");
mkdirSync(outDir, { recursive: true });
const daName = `aa-batch-${tree.root}.json`;
writeFileSync(resolve(outDir, daName), JSON.stringify({ root: tree.root, chainId, ops: signed }, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
const bond = await publicClient.readContract({ address: d.batches, abi: aggregatorAbi, functionName: "bond" });
const submitTx = await walletClient.writeContract({ address: d.batches, abi: aggregatorAbi, functionName: "submitBatch", args: [tree.root, signed.length, `sigpress-da:${daName}`], value: bond });
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

// --- 4. one handleAggregatedOps call from the EOA ---
const aggSig = encodeAbiParameters(
  [{ type: "uint256" }, { type: "uint256[]" }, { type: "bytes32[][]" }, { type: "bytes32[]" }],
  [batchId, signed.map((_, i) => BigInt(i)), signed.map((_, i) => tree.proof(i)), signed.map((s) => s.sigHash)],
);
const opas = [{ userOps: signed.map((s) => s.op), aggregator: d.aggregator4337, signature: aggSig }] as const;
const before = await publicClient.getBalance({ address: RECIPIENT });
const handleTx = await walletClient.writeContract({ address: d.entryPoint, abi: epAbi, functionName: "handleAggregatedOps", args: [opas, account.address] });
const r = await send("handleAggregatedOps", handleTx);
const opEvents = parseEventLogs({ abi: epAbi, logs: r.logs, eventName: "UserOperationEvent" }) as unknown as { args: { userOpHash: Hex; success: boolean } }[];
const after = await publicClient.getBalance({ address: RECIPIENT });
if (opEvents.length !== N || !opEvents.every((e) => e.args.success)) throw new Error(`expected ${N} successful UserOperationEvents, got ${opEvents.map((e) => e.args.success)}`);
if (after - before !== SEND * BigInt(N)) throw new Error(`recipient got ${formatEther(after - before)}`);

// --- 5. K9: bytes ---
const tx = await publicClient.getTransaction({ hash: handleTx });
const inputBytes = size(tx.input);
const rawBytes = size(
  serializeTransaction(
    { chainId, type: tx.type as "eip1559", nonce: tx.nonce, to: tx.to!, value: tx.value, data: tx.input, gas: tx.gas, maxFeePerGas: tx.maxFeePerGas!, maxPriorityFeePerGas: tx.maxPriorityFeePerGas!, accessList: tx.accessList },
    { r: tx.r, s: tx.s, yParity: tx.yParity! },
  ),
);
const opTuple = [{ type: "tuple", components: epAbi.find((x) => x.type === "function" && x.name === "getUserOpHash")!.inputs[0]!.components }] as const;
const perOpAbiBytes = size(encodeAbiParameters(opTuple as any, [signed[0]!.op])) + 32; // + its array offset word
const aggSigBytes = size(aggSig);
const k9 = {
  ops: N,
  inputBytes,
  inputZeroBytes: zeroBytes(tx.input),
  rawTxBytes: rawBytes,
  rawTxBytesPerOp: +(rawBytes / N).toFixed(1),
  inputBytesPerOp: +(inputBytes / N).toFixed(1),
  perOpUserOpAbiBytes: perOpAbiBytes,
  aggregatedSignatureBytes: aggSigBytes,
  aggregatedSignatureBytesPerOp: +(aggSigBytes / N).toFixed(1),
};
const result = {
  chainId,
  entryPoint: d.entryPoint,
  aggregator4337: d.aggregator4337,
  batches: d.batches,
  batchId: Number(batchId),
  submitTx,
  finalizeTx,
  handleAggregatedOpsTx: handleTx,
  gasLimit: Number(tx.gas),
  gasUsedReceipt: Number(r.gasUsed),
  gasPerOp: Math.round(Number(r.gasUsed) / N),
  userOpHashes: opEvents.map((e) => e.args.userOpHash),
  recipient: RECIPIENT,
  amountEach: formatEther(SEND),
  k9,
};
console.log(JSON.stringify(result, null, 2));
writeFileSync(resolve(outDir, `aa-results-${N}.json`), JSON.stringify(result, null, 2) + "\n");
