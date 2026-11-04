// Cross-check on a local anvil: a TS XMSS signature (h = 10) verifies in the Solidity XMSSAccount, and the
// SigpressClient flow (createAccount -> signOp -> submitDirect / batch -> submitFromBatch) works end to end.
// Skipped when anvil/forge/cast are not installed. Uses anvil's default dev key only.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  parseEther,
  parseEventLogs,
  toBytes,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { aggregatorAbi } from "../src/abi.ts";
import { buildBatch, SigpressClient, xmssMessageOf } from "../src/sdk/client.ts";
import { KeyStore } from "../src/sdk/keystore.ts";
import { xmssKeygen, xmssSignUnsafe } from "../src/sdk/xmss.ts";
import { payloadHash } from "../src/account.ts";

const here = dirname(fileURLToPath(import.meta.url));
const CONTRACTS = resolve(here, "../../contracts");
const ANVIL_KEY: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const have = (bin: string) => spawnSync(bin, ["--version"], { stdio: "ignore" }).status === 0;
const skip = !(have("anvil") && have("forge") && have("cast")) ? "anvil/forge/cast not installed" : false;

const PORT = 18545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;
let anvil: ChildProcess | undefined;
let dir = "";

function run(bin: string, args: string[]): string {
  const r = spawnSync(bin, args, { cwd: CONTRACTS, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${bin} ${args.slice(0, 2).join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

function forgeCreate(contract: string, args: string[]): Address {
  const out = run("forge", ["create", contract, "--rpc-url", RPC, "--private-key", ANVIL_KEY, "--broadcast", "--constructor-args", ...args]);
  const m = out.match(/Deployed to: (0x[0-9a-fA-F]{40})/);
  if (!m) throw new Error(`no address in forge create output: ${out}`);
  return m[1] as Address;
}

before(async () => {
  if (skip) return;
  dir = mkdtempSync(join(tmpdir(), "sigpress-anvil-"));
  run("forge", ["build", "--quiet"]);
  anvil = spawn("anvil", ["--port", String(PORT), "--silent"], { stdio: "ignore" });
  const probe = createPublicClient({ transport: http(RPC) });
  for (let i = 0; i < 100; i++) {
    try {
      await probe.getChainId();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("anvil did not start");
});

after(() => {
  anvil?.kill("SIGKILL");
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const seed = keccak256(toBytes("sigpress-anvil-xmss"));
const recipient = "0x000000000000000000000000000000000000bEEF" as Address;

test("anvil: TS XMSS sig (h = 10) verifies in Solidity via forge create + cast call", { skip }, () => {
  const key = xmssKeygen(seed, 10);
  const acct = forgeCreate("src/xmss/XMSSAccount.sol:XMSSAccount", ["0x0000000000000000000000000000000000000001", key.root, "10"]);
  assert.equal(run("cast", ["call", acct, "root()(bytes32)", "--rpc-url", RPC]), key.root);

  // Message: TS and Solidity agree.
  const leaf = 777;
  const call = { target: recipient, value: 1n, data: "0x" as Hex };
  const m = xmssMessageOf(31337, acct, key.root, leaf, payloadHash(acct, 0n, call));
  const mSol = run("cast", ["call", acct, "messageFor(uint256,address,uint256,bytes)(bytes32)", String(leaf), recipient, "1", "0x", "--rpc-url", RPC]);
  assert.equal(mSol, m);

  const s = xmssSignUnsafe(key, leaf, m);
  const verify = (path: Hex[], idx = s.leafIndex) =>
    run("cast", ["call", acct, "verify(bytes32,uint256,bytes32,bytes,bytes32[])(bool)", m, String(idx), s.leafPk, s.wotsSig, `[${path.join(",")}]`, "--rpc-url", RPC]);
  assert.equal(verify(s.authPath), "true");
  assert.equal(verify(s.authPath, leaf + 1), "false");
  const bad = [...s.authPath];
  bad[9] = keccak256(bad[9]!);
  assert.equal(verify(bad), "false");
});

test("anvil: SigpressClient createAccount -> signOp -> submitDirect, then batch path", { skip }, async () => {
  const chain = defineChain({ id: 31337, name: "anvil", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
  const publicClient = createPublicClient({ chain, transport: http(RPC) });
  const walletClient = createWalletClient({ chain, account: privateKeyToAccount(ANVIL_KEY), transport: http(RPC) });
  const window = 60n;
  const bond = parseEther("0.01");
  const aggregator = forgeCreate("src/OptimisticAggregator.sol:OptimisticAggregator", [bond.toString(), window.toString()]);
  const client = new SigpressClient({ publicClient, walletClient, aggregator });

  const key = xmssKeygen(keccak256(toBytes("sigpress-anvil-client")), 4);
  const ks = KeyStore.create(join(dir, "client-key.json"), key, { onWarn: () => {} });
  const account = await client.createAccount(key, { fund: parseEther("1") });
  const call = { target: recipient, value: parseEther("0.001"), data: "0x" as Hex };
  const before = await publicClient.getBalance({ address: recipient });

  // Direct path, two ops.
  const op1 = await client.signOp({ account, key, keystore: ks, call });
  const r1 = await client.submitDirect(op1);
  const op2 = await client.signOp({ account, key, keystore: ks, call });
  const r2 = await client.submitDirect(op2);
  assert.deepEqual([op1.sig.leafIndex, op2.sig.leafIndex], [0, 1]);
  assert.equal(await client.nonce(account), 2n);
  assert.equal(await client.isUsed(account, 0), true);
  console.log(`XMSSAccount.executeDirect tx gasUsed (h=4, anvil): op1 ${r1.gasUsed}, op2 ${r2.gasUsed}`);

  // Replay of op1 fails (nonce moved), and a second message from used leaf 1 is rejected on chain.
  await assert.rejects(client.submitDirect(op1));
  const reuseM = xmssMessageOf(31337, account, key.root, 1, payloadHash(account, 2n, call));
  const reuse = { ...op2, nonce: 2n, m: reuseM, sig: xmssSignUnsafe(key, 1, reuseM) };
  await assert.rejects(client.submitDirect(reuse), /LeafUsed|reverted/);

  // Batch path: op3's leaf goes in an OptimisticAggregator batch; after the window it executes.
  const op3 = await client.signOp({ account, key, keystore: ks, call });
  const other = { leaf: keccak256(toBytes("someone else's op")) };
  const batch = buildBatch([op3, other]);
  const sub = await publicClient.waitForTransactionReceipt({
    hash: await walletClient.writeContract({ address: aggregator, abi: aggregatorAbi, functionName: "submitBatch", args: [batch.root, 2, "local"], value: bond }),
  });
  const batchId = parseEventLogs({ abi: aggregatorAbi, logs: sub.logs, eventName: "BatchSubmitted" })[0]!.args.id;
  await assert.rejects(client.submitFromBatch(op3, { batchId, index: 0, proof: batch.proofs[0]! })); // window open
  await publicClient.request({ method: "evm_increaseTime" as any, params: [Number(window) + 1] as any });
  await publicClient.request({ method: "evm_mine" as any, params: [] as any });
  await publicClient.waitForTransactionReceipt({
    hash: await walletClient.writeContract({ address: aggregator, abi: aggregatorAbi, functionName: "finalize", args: [batchId] }),
  });
  const r3 = await client.submitFromBatch(op3, { batchId, index: 0, proof: batch.proofs[0]! });
  console.log(`XMSSAccount.executeFromBatch tx gasUsed (h=4, anvil): ${r3.gasUsed}`);
  assert.equal(await client.isUsed(account, 2), true);
  assert.equal((await publicClient.getBalance({ address: recipient })) - before, 3n * call.value);
  ks.close();
});
