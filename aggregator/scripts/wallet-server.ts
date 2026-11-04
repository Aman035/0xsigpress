// Interactive wallet demo server. Serves web/wallet.html and signs + relays transfers to a running
// aggregator service, so the browser is pure UI and the real WOTS signing stays in Node (the SDK).
//
//   KEY_VAR=PRIVATE_KEY_K13 pnpm service        # terminal 1: the aggregator service (http://127.0.0.1:8547)
//   KEY_VAR=PRIVATE_KEY_K13 pnpm wallet          # terminal 2: this, then open http://127.0.0.1:8550
//
// env: SERVICE_URL (http://127.0.0.1:8547), PORT (8550), HOST (127.0.0.1), KEY_VAR (relayer that creates and
//      funds the demo accounts), ACCOUNTS (3), ACCOUNT_SEED (sigpress-wallet), FUND (0.002 per account),
//      RECIPIENT (derived), RPC_URL.
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { formatEther, getAddress, keccak256, parseEther, parseEventLogs, slice, toBytes, bytesToHex, hexToBytes, type Address, type Hex } from "viem";
import { AGG_DIR, getClients, txLink } from "../src/chain.ts";
import { entryAbi, sigpressAccountAbi, signCompactOp } from "../src/compact.ts";
import { keygen } from "../src/wots.ts";
import { readJson, writeJsonAtomic } from "../src/service/store.ts";

const SERVICE = (process.env.SERVICE_URL ?? "http://127.0.0.1:8547").replace(/\/$/, "");
const PORT = Number(process.env.PORT ?? 8550);
const HOST = process.env.HOST ?? "127.0.0.1";
const N = Number(process.env.ACCOUNTS ?? 1);
const TAG = process.env.ACCOUNT_SEED ?? "sigpress-wallet";
const FUND = parseEther(process.env.FUND ?? "0.002");
const RECIPIENT: Address = getAddress(process.env.RECIPIENT ?? slice(keccak256(toBytes("sigpress-wallet-recipient")), 12));
const WEB = resolve(AGG_DIR, "../web");

type Health = { entry: Address; chainId: number; aggregator?: Address };
const seedOf = (i: number) => keccak256(toBytes(`${TAG}-${i}`));

async function svc(path: string, init?: RequestInit) {
  const r = await fetch(`${SERVICE}${path}`, init);
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body: body as any };
}

async function main() {
  const health = (await (await fetch(`${SERVICE}/health`)).json()) as Health;
  const entry = getAddress(health.entry);
  const { chainId, publicClient, walletClient, account } = await getClients();
  if (chainId !== health.chainId) throw new Error(`service on chain ${health.chainId}, relayer on ${chainId}`);
  const explorer = chainId === 10143 ? "https://testnet.monadexplorer.com" : "";
  const aggregator = health.aggregator ? getAddress(health.aggregator) : undefined;

  // --- provision N funded demo accounts (idempotent; indices remembered per entry+tag) ---
  const idxFile = resolve(AGG_DIR, "out/service", `wallet-accounts-${chainId}-${entry.toLowerCase()}-${TAG}.json`);
  const known = readJson<{ indices: number[] }>(idxFile) ?? { indices: [] };
  if (known.indices.length < N) {
    const from = known.indices.length;
    const pks = Array.from({ length: N - from }, (_, j) => keygen(seedOf(from + j), 0).pkHash);
    const h = await walletClient.writeContract({ address: entry, abi: entryAbi, functionName: "createAccounts", args: [pks], value: FUND * BigInt(pks.length) });
    const r = await publicClient.waitForTransactionReceipt({ hash: h });
    if (r.status !== "success") throw new Error(`createAccounts reverted ${h}`);
    for (const ev of parseEventLogs({ abi: entryAbi, logs: r.logs, eventName: "AccountCreated" })) known.indices.push(Number(ev.args.index));
    writeJsonAtomic(idxFile, known);
    console.log(`created ${pks.length} demo account(s): ${txLink(explorer, h)}`);
  }
  const indices = known.indices.slice(0, N);
  const addrOf = async (index: number) => getAddress(await publicClient.readContract({ address: entry, abi: entryAbi, functionName: "accountOf", args: [BigInt(index)] }) as Address);
  const addresses = await Promise.all(indices.map(addrOf));

  const bal = (a: Address) => publicClient.getBalance({ address: a });
  const stateAccounts = async () => Promise.all(indices.map(async (index, i) => {
    const address = addresses[i]!;
    const [balance, nonce] = await Promise.all([bal(address), publicClient.readContract({ address, abi: sigpressAccountAbi, functionName: "nonce" }) as Promise<bigint>]);
    return { index, address, balanceWei: balance.toString(), balance: formatEther(balance), nonce: nonce.toString() };
  }));

  async function sign(index: number, to: Address, amountWei: bigint, tamper: boolean) {
    const address = addresses[indices.indexOf(index)]!;
    const nonce = await publicClient.readContract({ address, abi: sigpressAccountAbi, functionName: "nonce" }) as bigint;
    const op = signCompactOp({ seed: seedOf(indices.indexOf(index)), keyIndex: Number(nonce), index, account: address, nonce, chainId, entry, call: { target: to, value: amountWei, data: "0x" } });
    let sig = op.sig;
    if (tamper) { const b = hexToBytes(op.sig); b[7]! ^= 1; sig = bytesToHex(b); }
    const body = { index, account: address, target: op.target, value: op.value.toString(), data: op.data, nextPkHash: op.nextPkHash, sig };
    const res = await svc("/ops", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { op, sig, res, address, nonce };
  }

  // merge the service op view with its batch's tx links
  async function opView(id: string) {
    const { status, body } = await svc(`/ops/${encodeURIComponent(id)}`);
    if (status >= 400) return { status, body };
    let batch: any = body.batch ?? null;
    if (batch?.id != null) {
      const b = await svc(`/batches/${batch.id}`);
      if (b.status < 400) batch = { ...batch, ...b.body };
    }
    return { status, body: { ...body, batch, explorer } };
  }

  // --- http ---
  const send = (res: ServerResponse, code: number, obj: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  const readBody = (req: IncomingMessage) => new Promise<any>((ok) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => ok(s ? JSON.parse(s) : {})); });

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
      const p = url.pathname;
      if (req.method === "GET" && (p === "/" || p === "/index.html")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(readFileSync(resolve(WEB, "wallet.html")));
      }
      if (req.method === "GET" && p === "/api/state") {
        return send(res, 200, { serviceUrl: SERVICE, entry, aggregator, chainId, explorer, relayer: account.address, recipient: RECIPIENT, recipientBalance: formatEther(await bal(RECIPIENT)), accounts: await stateAccounts() });
      }
      if (req.method === "POST" && p === "/api/send") {
        const { fromIndex, to, amount } = await readBody(req);
        const dest = to ? getAddress(to) : RECIPIENT;
        const { op, res: r } = await sign(Number(fromIndex), dest, parseEther(String(amount ?? "0.0001")), false);
        if (r.status >= 300) return send(res, r.status, { error: r.body.error ?? "rejected" });
        return send(res, 200, { id: r.body.id, status: r.body.status, to: dest,
          sign: { pkHash: op.pkHash, message: op.m, nextPkHash: op.nextPkHash, sig: op.sig, sigHash: op.sigHash, leaf: op.leaf, nonce: op.nonce.toString(), sigBytes: (op.sig.length - 2) / 2 } });
      }
      if (req.method === "POST" && p === "/api/forge") {
        const { fromIndex } = await readBody(req);
        const { res: r } = await sign(Number(fromIndex), RECIPIENT, parseEther("0.0001"), true);
        return send(res, 200, { httpStatus: r.status, rejected: r.status >= 400, error: r.body.error ?? null, id: r.body.id ?? null });
      }
      if (req.method === "GET" && p.startsWith("/api/op/")) {
        const { status, body } = await opView(decodeURIComponent(p.slice("/api/op/".length)));
        return send(res, status, body);
      }
      send(res, 404, { error: "not found" });
    } catch (e: any) { send(res, 500, { error: String(e?.message ?? e) }); }
  });

  server.listen(PORT, HOST, async () => {
    const accs = await stateAccounts();
    console.log(`\nSigpress wallet demo on http://${HOST}:${PORT}`);
    console.log(`  service   ${SERVICE} (entry ${entry}, chain ${chainId})`);
    console.log(`  relayer   ${account.address}`);
    console.log(`  accounts  ${accs.map((a) => `#${a.index}=${a.balance} MON`).join("  ")}`);
    console.log(`  recipient ${RECIPIENT}\n  open the URL and send a post-quantum transfer.`);
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
