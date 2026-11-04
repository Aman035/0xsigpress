// Drive a running service like a wallet would: make (or reuse) N SigpressAccounts, sign one tiny transfer
// per account with its WOTS key, POST them to the service, and poll until each is executed.
//   KEY_VAR=PRIVATE_KEY_K13 pnpm service:demo
//   env: SERVICE_URL (http://127.0.0.1:8547), OPS (4), ACCOUNT_SEED (sigpress-service), FUND (0.0005 per new
//        account), SEND (0.0001), BAD (1 = also POST one tampered op and expect a 400), RECORD (1 = write the run
//        into deployments-service.json)
// The KEY_VAR wallet only creates/funds accounts here; ops are authorised by the WOTS signatures alone.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { bytesToHex, formatEther, getAddress, hexToBytes, keccak256, parseEther, parseEventLogs, slice, toBytes, type Address, type Hex } from "viem";
import { AGG_DIR, getClients, txLink } from "../src/chain.ts";
import { entryAbi, sigpressAccountAbi, signCompactOp } from "../src/compact.ts";
import { keygen } from "../src/wots.ts";
import { readJson, writeJsonAtomic } from "../src/service/store.ts";

const URL_ = (process.env.SERVICE_URL ?? "http://127.0.0.1:8547").replace(/\/$/, "");
const N = Number(process.env.OPS ?? 4);
const TAG = process.env.ACCOUNT_SEED ?? "sigpress-service";
const FUND = parseEther(process.env.FUND ?? "0.0005");
const SEND = parseEther(process.env.SEND ?? "0.0001");
const RECIPIENT: Address = getAddress(process.env.RECIPIENT ?? slice(keccak256(toBytes("sigpress-recipient")), 12));

const health = (await (await fetch(`${URL_}/health`)).json()) as { entry: Address; chainId: number };
const entry = health.entry;
const { chainId, publicClient, walletClient, account } = await getClients();
if (chainId !== health.chainId) throw new Error(`service is on chain ${health.chainId}, wallet on ${chainId}`);
const explorer = chainId === 10143 ? "https://testnet.monadexplorer.com" : undefined;
console.log(`service ${URL_} entry ${entry}; relayer ${account.address} (${formatEther(await publicClient.getBalance({ address: account.address }))} MON)`);

// Account indices for this seed tag on this entry (entry indices are shared by everyone, so remember ours).
const seedOf = (i: number) => keccak256(toBytes(`${TAG}-${i}`));
const idxFile = resolve(AGG_DIR, "out/service", `demo-accounts-${chainId}-${entry.toLowerCase()}-${TAG}.json`);
const known = readJson<{ indices: number[] }>(idxFile) ?? { indices: [] };
const createTxs: Hex[] = [];
if (known.indices.length < N) {
  const from = known.indices.length;
  const pks = Array.from({ length: N - from }, (_, j) => keygen(seedOf(from + j), 0).pkHash);
  const value = FUND * BigInt(pks.length);
  const h = await walletClient.writeContract({ address: entry, abi: entryAbi, functionName: "createAccounts", args: [pks], value });
  const r = await publicClient.waitForTransactionReceipt({ hash: h });
  if (r.status !== "success") throw new Error(`createAccounts reverted ${h}`);
  console.log(`createAccounts x${pks.length} ${txLink(explorer, h)}`);
  createTxs.push(h);
  for (const ev of parseEventLogs({ abi: entryAbi, logs: r.logs, eventName: "AccountCreated" })) known.indices.push(Number(ev.args.index));
  writeJsonAtomic(idxFile, known);
}

const post = async (body: Record<string, unknown>) => {
  const r = await fetch(`${URL_}/ops`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
};

const ids: string[] = [];
let badOp: { status: number; error: string } | undefined;
for (let i = 0; i < N; i++) {
  const index = known.indices[i]!;
  const address = await publicClient.readContract({ address: entry, abi: entryAbi, functionName: "accountOf", args: [BigInt(index)] });
  const nonce = await publicClient.readContract({ address, abi: sigpressAccountAbi, functionName: "nonce" });
  const bal = await publicClient.getBalance({ address });
  if (bal < SEND) {
    const g = await publicClient.estimateGas({ account, to: address, value: FUND });
    const h = await walletClient.sendTransaction({ to: address, value: FUND, gas: (g * 13n) / 10n });
    await publicClient.waitForTransactionReceipt({ hash: h });
    console.log(`top up account ${index} ${txLink(explorer, h)}`);
  }
  const op = signCompactOp({ seed: seedOf(i), keyIndex: Number(nonce), index, account: address, nonce, chainId, entry, call: { target: RECIPIENT, value: SEND, data: "0x" } });
  const body = { index, account: address, target: op.target, value: op.value.toString(), data: op.data, nextPkHash: op.nextPkHash, sig: op.sig };
  if (i === 0 && process.env.BAD === "1") {
    const b = hexToBytes(op.sig);
    b[7]! ^= 1;
    const r = await post({ ...body, sig: bytesToHex(b) });
    badOp = { status: r.status, error: r.body.error };
    console.log(`tampered op -> HTTP ${r.status}: ${r.body.error}`);
  }
  const r = await post(body);
  if (r.status >= 300) throw new Error(`POST /ops ${r.status}: ${r.body.error}`);
  console.log(`op account ${index} nonce ${nonce} -> ${r.status} ${r.body.id} (${r.body.status})`);
  ids.push(r.body.id);
}

const t0 = Date.now();
let last = "";
let views: any[] = [];
for (;;) {
  views = await Promise.all(ids.map(async (id) => (await (await fetch(`${URL_}/ops/${id}`)).json()) as any));
  const line = views.map((v) => v.status).join(",");
  if (line !== last) {
    console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${line}`);
    last = line;
  }
  if (views.every((v) => v.status === "executed" || v.status === "failed")) break;
  await new Promise((r) => setTimeout(r, 2000));
}
const batchIds = [...new Set(views.map((v) => v.batch?.id).filter(Boolean))];
const batches = await Promise.all(batchIds.map(async (id) => (await (await fetch(`${URL_}/batches/${id}`)).json()) as any));
for (const b of batches) {
  console.log(`batch ${b.id}: ${b.count} ops, status ${b.status}`);
  for (const k of ["submitTx", "finalizeTx", "executeTx"]) if (b[k]) console.log(`  ${k} ${txLink(explorer, b[k])}`);
}
for (const v of views.filter((x) => x.via === "direct")) console.log(`direct ${txLink(explorer, v.txHash)}`);
const failed = views.filter((v) => v.status === "failed");
if (failed.length) console.log(`FAILED: ${JSON.stringify(failed, null, 2)}`);

if (process.env.RECORD === "1") {
  const p = resolve(AGG_DIR, "deployments-service.json");
  const d = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
  d.runs = d.runs ?? [];
  d.runs.push({
    at: new Date().toISOString(),
    ops: N,
    executed: views.filter((v) => v.status === "executed").length,
    secondsToExecuted: Math.round((Date.now() - t0) / 1000),
    createTxs,
    badOpRejected: badOp,
    batches: batches.map((b) => ({ id: b.id, count: b.count, status: b.status, submitTx: b.submitTx, finalizeTx: b.finalizeTx, executeTx: b.executeTx })),
  });
  writeFileSync(p, JSON.stringify(d, null, 2) + "\n");
  console.log(`recorded in ${p}`);
}
if (failed.length) process.exit(1);
