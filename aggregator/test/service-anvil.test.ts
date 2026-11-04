// End to end on a local anvil: deploy OptimisticAggregator + SigpressEntry with the forge script, run the
// service and the watchtower in-process, push 10 good ops over HTTP -> one batch -> executed in one
// executeBundle. Then a malicious batch (one tampered signature, DA published by the attacker) is posted
// straight to the aggregator -> the watchtower challenges and slashes it; and a batch with no DA is logged
// as missing. Skipped when anvil/forge are not installed. Uses anvil's default dev keys only.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bytesToHex, hexToBytes, keccak256, parseEther, parseEventLogs, toBytes, type Address, type Hex } from "viem";
import { getClients } from "../src/chain.ts";
import { aggregatorAbi } from "../src/abi.ts";
import { entryAbi, signCompactOp } from "../src/compact.ts";
import { keygen } from "../src/wots.ts";
import { leafOf } from "../src/op.ts";
import { MerkleTree } from "../src/merkle.ts";
import { viemChain } from "../src/service/chain.ts";
import { startService, type ServiceHandle } from "../src/service/server.ts";
import { startWatchtower, type WatchEvent } from "../src/service/watchtower.ts";

const here = dirname(fileURLToPath(import.meta.url));
const CONTRACTS = resolve(here, "../../contracts");
const KEYS: Hex[] = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // deployer / users' relayer
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", // service
  keccak256(toBytes("sigpress e2e watchtower")), // watchtower (fresh key, funded below)
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6", // malicious aggregator
];
const have = (bin: string) => spawnSync(bin, ["--version"], { stdio: "ignore" }).status === 0;
const skip = !(have("anvil") && have("forge")) ? "anvil/forge not installed" : false;
const PORT = 19545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;
const WINDOW = 8;
const BOND = parseEther("0.01");

let anvil: ChildProcess | undefined;
let dir = "";
let entry: Address;
let batches: Address;
let svc: ServiceHandle | undefined;
let tower: Awaited<ReturnType<typeof startWatchtower>> | undefined;
let attackerDA: Server | undefined;
const events: WatchEvent[] = [];
const towerLog: string[] = [];

async function until<T>(what: string, f: () => Promise<T | undefined> | T | undefined, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v !== undefined && v !== false) return v as T;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

before(async () => {
  if (skip) return;
  dir = mkdtempSync(join(tmpdir(), "sigpress-svc-e2e-"));
  anvil = spawn("anvil", ["--port", String(PORT), "--block-time", "1", "--silent"], { stdio: "ignore" });
  await until("anvil", () => fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }).then((r) => r.ok).catch(() => undefined), 10_000);
  const r = spawnSync("forge", ["script", "script/DeployCompact.s.sol", "--rpc-url", RPC, "--broadcast"], {
    cwd: CONTRACTS,
    encoding: "utf8",
    env: { ...process.env, KEY_VAR: "SIGPRESS_E2E_KEY", SIGPRESS_E2E_KEY: KEYS[0], WINDOW: String(WINDOW), BOND: BOND.toString(), BATCHES: "" },
  });
  if (r.status !== 0) throw new Error(`forge script failed: ${r.stderr || r.stdout}`);
  batches = r.stdout.match(/OptimisticAggregator (0x[0-9a-fA-F]{40})/)![1] as Address;
  entry = r.stdout.match(/SigpressEntry (0x[0-9a-fA-F]{40})/)![1] as Address;
});

after(async () => {
  if (process.env.E2E_DEBUG) console.log(towerLog.join("\n"));
  await tower?.stop();
  await svc?.close();
  attackerDA?.close();
  anvil?.kill("SIGKILL");
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const seedOf = (i: number) => keccak256(toBytes(`svc-e2e-${i}`));
const RECIPIENT = "0x000000000000000000000000000000000000bEEF" as Address;

test("anvil e2e: 10 good ops -> one batch -> executed; moved account -> dead op; tampered batch -> watchtower slashes; missing DA is flagged", { skip, timeout: 180_000 }, async () => {
  const user = await getClients({ rpc: RPC, privateKey: KEYS[0] });
  const pc = user.publicClient;
  const towerAddr = (await getClients({ rpc: RPC, privateKey: KEYS[2] })).account.address;
  await pc.waitForTransactionReceipt({ hash: await user.walletClient.sendTransaction({ to: towerAddr, value: parseEther("1") }) });
  // 10 accounts, 1 ETH each.
  const pks = Array.from({ length: 10 }, (_, i) => keygen(seedOf(i), 0).pkHash);
  const h = await user.walletClient.writeContract({ address: entry, abi: entryAbi, functionName: "createAccounts", args: [pks], value: parseEther("10") });
  assert.equal((await pc.waitForTransactionReceipt({ hash: h })).status, "success");

  // Service (its own key) + watchtower (another key), DA fallback = the service.
  const chain = await viemChain({ entry, rpc: RPC, privateKey: KEYS[1] });
  svc = await startService({ chain, dir: join(dir, "svc"), tickMs: 200, batcher: { maxOps: 64, maxWaitMs: 1500, fallbackMs: 0, receiptTimeoutMs: 20_000, log: () => {} } });
  tower = await startWatchtower({
    aggregator: batches,
    rpc: RPC,
    privateKey: KEYS[2],
    stateFile: join(dir, "tower.json"),
    daUrls: [svc.url],
    fromBlock: 0n,
    pollMs: 300,
    onEvent: (e) => events.push(e),
    log: (m) => towerLog.push(m),
  });

  const post = (body: unknown) => fetch(`${svc!.url}/ops`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)) });
  const value = parseEther("0.001");
  const ops: ReturnType<typeof signCompactOp>[] = [];
  for (let i = 0; i < 10; i++) {
    const account = await pc.readContract({ address: entry, abi: entryAbi, functionName: "accountOf", args: [BigInt(i)] });
    ops.push(signCompactOp({ seed: seedOf(i), keyIndex: 0, index: i, account, nonce: 0n, chainId: 31337, entry, call: { target: RECIPIENT, value, data: "0x" } }));
  }
  // A bad signature is rejected before it gets anywhere near a batch.
  const bad = hexToBytes(ops[0]!.sig);
  bad[3]! ^= 1;
  const rej = await post({ index: 0, account: ops[0]!.account, target: RECIPIENT, value, data: "0x", nextPkHash: ops[0]!.nextPkHash, sig: bytesToHex(bad) });
  assert.equal(rej.status, 400);
  assert.match(((await rej.json()) as any).error, /invalid WOTS signature/);

  const before = await pc.getBalance({ address: RECIPIENT });
  const ids: string[] = [];
  for (const o of ops) {
    const r = await post({ index: o.index, account: o.account, target: o.target, value: o.value, data: o.data, nextPkHash: o.nextPkHash, sig: o.sig });
    assert.equal(r.status, 202);
    ids.push(((await r.json()) as any).id);
  }
  const final = await until("10 ops executed", async () => {
    const st = await Promise.all(ids.map(async (id) => (await (await fetch(`${svc!.url}/ops/${id}`)).json()) as any));
    if (st.some((s) => s.status === "failed")) throw new Error(`op failed: ${JSON.stringify(st.find((s) => s.status === "failed"))}`);
    return st.every((s) => s.status === "executed") ? st : undefined;
  });
  assert.ok(final.every((s: any) => s.via === "bundle" && s.callSuccess === true));
  assert.equal(new Set(final.map((s: any) => s.txHash)).size, 1, "all 10 ops ran in one executeBundle tx");
  assert.equal((await pc.getBalance({ address: RECIPIENT })) - before, value * 10n);
  const batchId = final[0].batch.id as string;
  const batch = (await (await fetch(`${svc.url}/batches/${batchId}`)).json()) as any;
  assert.equal(batch.status, "executed");
  assert.equal(batch.count, 10);
  const da = (await (await fetch(`${svc.url}${batch.da}`)).json()) as any;
  assert.equal(da.leaves.length, 10);
  await until("watchtower verified the good batch", () => events.find((e) => e.type === "ok" && e.id === BigInt(batchId)));

  // --- a user runs a different op directly while their batched op waits: it goes as a dead op on chain ---
  const next = [0, 1].map((i) => signCompactOp({ seed: seedOf(i), keyIndex: 1, index: i, account: ops[i]!.account, nonce: 1n, chainId: 31337, entry, call: { target: RECIPIENT, value, data: "0x" } }));
  const ids2: string[] = [];
  for (const o of next) ids2.push(((await (await post({ index: o.index, target: o.target, value: o.value, data: o.data, nextPkHash: o.nextPkHash, sig: o.sig })).json()) as any).id);
  await until("second batch submitted", async () => ((await (await fetch(`${svc!.url}/ops/${ids2[1]}`)).json()) as any).batch?.id);
  const other = signCompactOp({ seed: seedOf(1), keyIndex: 1, index: 1, account: ops[1]!.account, nonce: 1n, chainId: 31337, entry, call: { target: RECIPIENT, value: 2n, data: "0x" } });
  const direct = await user.walletClient.writeContract({
    address: ops[1]!.account,
    abi: [{ type: "function", name: "executeDirect", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }, { type: "bytes" }, { type: "bytes" }], outputs: [] }] as const,
    functionName: "executeDirect",
    args: [other.nextPkHash, other.target, other.value, other.data, other.sig],
  });
  assert.equal((await pc.waitForTransactionReceipt({ hash: direct })).status, "success");
  const st2 = await until("second batch done", async () => {
    const st = await Promise.all(ids2.map(async (id) => (await (await fetch(`${svc!.url}/ops/${id}`)).json()) as any));
    return st.every((x) => x.status === "executed" || x.status === "failed") ? st : undefined;
  });
  assert.deepEqual(st2.map((x: any) => x.status), ["executed", "failed"]);
  assert.match(st2[1].error, /dead op/);
  const execR = await pc.getTransactionReceipt({ hash: st2[0].txHash });
  assert.equal(parseEventLogs({ abi: entryAbi, logs: execR.logs, eventName: "OpSkipped" }).length, 1);

  // --- malicious aggregator: one tampered signature, its own DA server, posted directly ---
  const evil = await getClients({ rpc: RPC, privateKey: KEYS[3] });
  const leaves = Array.from({ length: 4 }, (_, i) => {
    const k = keygen(seedOf(100 + i), 0);
    const o = signCompactOp({ seed: seedOf(100 + i), keyIndex: 0, index: 100 + i, account: RECIPIENT, nonce: 0n, chainId: 31337, entry, call: { target: RECIPIENT, value: 1n, data: "0x" } });
    let sig = o.sig;
    if (i === 2) {
      const b = hexToBytes(sig);
      b[0]! ^= 1;
      sig = bytesToHex(b);
    }
    return { index: i, pkHash: k.pkHash, m: o.m, sig };
  });
  const tree = new MerkleTree(leaves.map((l) => leafOf(l.pkHash, l.m, l.sig)));
  const doc = { version: 1, root: tree.root, count: 4, chainId: 31337, aggregator: batches, leaves };
  attackerDA = createServer((_, res) => res.end(JSON.stringify(doc)));
  await new Promise<void>((r) => attackerDA!.listen(0, "127.0.0.1", r));
  const daUrl = `http://127.0.0.1:${(attackerDA.address() as any).port}/bad.json`;
  const towerBal = await pc.getBalance({ address: towerAddr });
  const sub = await evil.walletClient.writeContract({ address: batches, abi: aggregatorAbi, functionName: "submitBatch", args: [tree.root, 4, daUrl], value: BOND });
  const subR = await pc.waitForTransactionReceipt({ hash: sub });
  const evilId = parseEventLogs({ abi: aggregatorAbi, logs: subR.logs, eventName: "BatchSubmitted" })[0]!.args.id;
  const ch = await until("watchtower challenge", () => events.find((e) => e.type === "challenged" && e.id === evilId), 30_000);
  assert.equal(ch.type === "challenged" && ch.index, 2);
  const [, , , , slashed] = await pc.readContract({ address: batches, abi: aggregatorAbi, functionName: "batches", args: [evilId] });
  assert.equal(slashed, true);
  assert.ok((await pc.getBalance({ address: towerAddr })) > towerBal, "watchtower earned the bond (net of gas)");

  // --- a batch whose signatures are never published: logged loudly as DA missing ---
  const ghostRoot = keccak256(toBytes("no data anywhere"));
  const g = await evil.walletClient.writeContract({ address: batches, abi: aggregatorAbi, functionName: "submitBatch", args: [ghostRoot, 3, "ipfs://withheld"], value: BOND });
  const gR = await pc.waitForTransactionReceipt({ hash: g });
  const ghostId = parseEventLogs({ abi: aggregatorAbi, logs: gR.logs, eventName: "BatchSubmitted" })[0]!.args.id;
  const miss = await until("DA missing flagged", () => events.find((e) => e.type === "da-missing" && e.id === ghostId), 30_000);
  assert.match(miss.type === "da-missing" ? miss.reason : "", /DA unavailable/);
  assert.ok(towerLog.some((l) => l.includes("DA MISSING") && l.includes(`batch ${ghostId}`)));
  await until("ghost batch window closes unchecked", () => events.find((e) => e.type === "closed-unchecked" && e.id === ghostId), 30_000);
});
