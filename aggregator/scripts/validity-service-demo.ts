// Drive a running MODE=validity service like a wallet would: make (or reuse) N ValidityAccounts, each bound at creation
// to its own leanXMSS key; sign one tiny transfer per account (message = ValidityEntry.opHash of the op) at the
// service's open slot; POST them; poll until each is executed through a STARK-proven batch.
//   KEY_VAR=PRIVATE_KEY_K14 pnpm validity:demo
//   env: SERVICE_URL (http://127.0.0.1:8548), OPS (3), FUND (0.001 MON per new account), SEND (0.0001),
//        BAD (1 = also POST one op with a wrong signature and expect a 400), TIMEOUT_S (900)
// The KEY_VAR wallet only creates/funds accounts; the ops are authorised by the leanXMSS signatures alone.
import { resolve } from "node:path";
import { bytesToHex, encodeFunctionData, formatEther, getAddress, keccak256, parseEther, parseEventLogs, slice, toBytes, type Address, type Hex } from "viem";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { AGG_DIR, getClients, txLink } from "../src/chain.ts";
import { KeyStore } from "../src/sdk/keystore.ts";
import { createLeanXmssKeyStore, leanxmssGatePubkey, leanxmssKeygen, leanxmssLoadKey, leanxmssSign } from "../src/sdk/leanxmss.ts";
import { fromJson, readJson, writeJsonAtomic } from "../src/service/store.ts";
import { send, validityEntryAbi } from "../src/validity.ts";

const URL_ = (process.env.SERVICE_URL ?? "http://127.0.0.1:8548").replace(/\/$/, "");
const N = Number(process.env.OPS ?? 3);
const FUND = parseEther(process.env.FUND ?? "0.001");
const SEND = parseEther(process.env.SEND ?? "0.0001");
const RECIPIENT: Address = getAddress(process.env.RECIPIENT ?? slice(keccak256(toBytes("sigpress-recipient")), 12));
const info = (await (await fetch(`${URL_}/validity`)).json()) as { entry: Address; chainId: number; slot: number; shape: string; gate: Address };
const c = await getClients();
if (c.chainId !== info.chainId) throw new Error(`service on chain ${info.chainId}, wallet on ${c.chainId}`);
const explorer = c.chainId === 10143 ? "https://testnet.monadexplorer.com" : undefined;
console.log(`service ${URL_} (${info.shape}) entry ${info.entry} gate ${info.gate}; relayer ${c.account.address} (${formatEther(await c.publicClient.getBalance({ address: c.account.address }))} MON)`);

// Demo accounts: one leanXMSS key each (logSlots 10 = 1024 slots), remembered per entry.
const dir = resolve(AGG_DIR, "out/service", `validity-demo-${c.chainId}-${info.entry.toLowerCase()}`);
mkdirSync(dir, { recursive: true, mode: 0o700 });
const idx = resolve(dir, "accounts.json");
const known = readJson<{ accounts: { address: Address; key: string; state: string }[] }>(idx) ?? { accounts: [] };
while (known.accounts.length < N) {
  const k = known.accounts.length;
  const keyPath = resolve(dir, `user-${k}.key.json`);
  const statePath = resolve(dir, `user-${k}.state.json`);
  const key = existsSync(keyPath) ? leanxmssLoadKey(keyPath) : leanxmssKeygen(bytesToHex(randomBytes(32)), keyPath, { logSlots: 10 });
  if (!existsSync(statePath)) createLeanXmssKeyStore(statePath, key).close();
  const pk = leanxmssGatePubkey(key.publicKey);
  const salt = keccak256(toBytes(`demo-${k}`));
  const r = await send(c, info.entry, encodeFunctionData({ abi: validityEntryAbi, functionName: "createAccount", args: [pk, salt] }), FUND);
  const ev = parseEventLogs({ abi: validityEntryAbi, logs: r.receipt.logs, eventName: "AccountCreated" })[0]!;
  console.log(`  createAccount #${k} ${ev.args.account} (key ${pk.slice(0, 10)}…, funded ${formatEther(FUND)}) ${txLink(explorer, r.hash)}`);
  known.accounts.push({ address: ev.args.account, key: keyPath, state: statePath });
  writeJsonAtomic(idx, known);
}

const post = async (body: Record<string, unknown>) => {
  const r = await fetch(`${URL_}/ops`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
};
const { slot } = (await (await fetch(`${URL_}/validity`)).json()) as { slot: number };
console.log(`open slot ${slot}`);
const ids: string[] = [];
for (const [k, a] of known.accounts.slice(0, N).entries()) {
  const key = leanxmssLoadKey(a.key);
  const nonce = await c.publicClient.readContract({ address: info.entry, abi: validityEntryAbi, functionName: "nonceOf", args: [a.address] });
  const op = { account: a.address, nonce: nonce.toString(), target: RECIPIENT, value: SEND.toString(), data: "0x" as Hex };
  const m = await c.publicClient.readContract({ address: info.entry, abi: validityEntryAbi, functionName: "opHash", args: [a.address, nonce, RECIPIENT, SEND, "0x"] });
  const ks = KeyStore.open(a.state, { onWarn: () => {} });
  const sig = leanxmssSign(key, ks, m, { slot });
  ks.close();
  if (k === 0 && process.env.BAD === "1") {
    const bad = sig.signature.slice(0, 100) + (sig.signature[100] === "0" ? "1" : "0") + sig.signature.slice(101);
    const r = await post({ ...op, publicKey: key.publicKey, slot, signature: bad });
    console.log(`  tampered op -> HTTP ${r.status} ${r.body.error ?? ""}`);
    if (r.status !== 400) throw new Error("tampered op was not rejected");
  }
  const r = await post({ ...op, publicKey: key.publicKey, slot, signature: sig.signature });
  if (r.status >= 300) throw new Error(`POST /ops ${r.status}: ${r.body.error}`);
  console.log(`  op #${k} ${a.address} nonce ${nonce}: message ${m.slice(0, 12)}… signed at slot ${slot} -> ${r.status} ${r.body.status}`);
  ids.push(r.body.id);
}

const t0 = Date.now();
const deadline = t0 + Number(process.env.TIMEOUT_S ?? 900) * 1000;
let last = "";
for (;;) {
  const views = await Promise.all(ids.map(async (id) => fromJson<any>(await (await fetch(`${URL_}/ops/${id}`)).text())));
  const s = views.map((v) => v.status).join(",");
  if (s !== last) console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)} s] ${s}`);
  last = s;
  if (views.every((v) => v.status === "executed" || v.status === "failed")) {
    const b = views[0].batch;
    if (views.some((v) => v.status === "failed")) throw new Error(`ops failed: ${views.map((v) => v.error).join("; ")}`);
    console.log(`batch ${b.key} slot ${b.slot}: ${b.ops} ops + ${b.fillers} fillers, proved in ${b.proveSeconds} s`);
    console.log(`  gate.submit ${txLink(explorer, b.submitTx)} (${b.gasCharged?.submit} gas charged)`);
    console.log(`  ValidityEntry.execute ${txLink(explorer, b.executeTx)} (${b.gasCharged?.execute} gas charged)`);
    for (const v of views) console.log(`  ${v.account} nonce ${v.nonce}: ${v.status}${v.callSuccess === false ? " (call reverted)" : ""} at (side ${v.side}, index ${v.index})`);
    writeJsonAtomic(resolve(dir, `run-${Date.now()}.json`), { slot, ops: views, at: new Date().toISOString() });
    break;
  }
  if (Date.now() > deadline) throw new Error("timed out waiting for execution");
  await new Promise((r) => setTimeout(r, 3000));
}
