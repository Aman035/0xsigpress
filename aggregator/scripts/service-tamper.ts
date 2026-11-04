// Play a dishonest aggregator against a running watchtower: post a batch with one tampered WOTS signature
// straight to the OptimisticAggregator, serve its DA document on a local port, and wait until the batch is
// slashed (or its window closes). With WITHHOLD=1 no DA is served at all (the DA risk case).
//   KEY_VAR=PRIVATE_KEY_K13 pnpm service:tamper
//   env: AGGREGATOR (default: the service deployments' OptimisticAggregator), LEAVES (4), BAD_INDEX (2),
//        DA_PORT (8548), WITHHOLD (0), RECORD (1 = append to deployments-service.json)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { bytesToHex, hexToBytes, keccak256, parseEventLogs, toBytes, type Address } from "viem";
import { aggregatorAbi } from "../src/abi.ts";
import { AGG_DIR, getClients, txLink } from "../src/chain.ts";
import { MerkleTree } from "../src/merkle.ts";
import { leafOf, messageOf } from "../src/op.ts";
import { keygen, sign } from "../src/wots.ts";
import { serviceDeployments } from "../src/service/server.ts";

const dep = serviceDeployments();
const d = JSON.parse(readFileSync(dep.path, "utf8")) as { batches: Address; entry: Address };
const aggregator = (process.env.AGGREGATOR as Address | undefined) ?? d.batches;
const N = Number(process.env.LEAVES ?? 4);
const BAD = Number(process.env.BAD_INDEX ?? 2);
const PORT = Number(process.env.DA_PORT ?? 8548);
const WITHHOLD = process.env.WITHHOLD === "1";
const { chainId, publicClient, walletClient, account } = await getClients();
const explorer = chainId === 10143 ? "https://testnet.monadexplorer.com" : undefined;

const tag = `sigpress-service-tamper-${Date.now()}`;
const leaves = Array.from({ length: N }, (_, i) => {
  const seed = keccak256(toBytes(`${tag}-${i}`));
  const k = keygen(seed, 0);
  const m = messageOf(chainId, d.entry, k.pkHash, keygen(seed, 1).pkHash, keccak256(toBytes(`${tag} payload ${i}`)));
  let sig = sign(k.sk, m);
  if (i === BAD) {
    const b = hexToBytes(sig);
    b[0]! ^= 1;
    sig = bytesToHex(b);
  }
  return { index: i, pkHash: k.pkHash, m, sig };
});
const tree = new MerkleTree(leaves.map((l) => leafOf(l.pkHash, l.m, l.sig)));
const doc = { version: 1, root: tree.root, count: N, chainId, aggregator, leaves };
const server = createServer((_, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(doc));
});
if (!WITHHOLD) await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));
const dataURI = WITHHOLD ? "ipfs://withheld" : `http://127.0.0.1:${PORT}/da/${tree.root}`;

const bond = await publicClient.readContract({ address: aggregator, abi: aggregatorAbi, functionName: "bond" });
const submitTx = await walletClient.writeContract({ address: aggregator, abi: aggregatorAbi, functionName: "submitBatch", args: [tree.root, N, dataURI], value: bond });
console.log(`submitBatch (bad sig at ${BAD}${WITHHOLD ? ", DA withheld" : ""}) ${txLink(explorer, submitTx)}`);
const r = await publicClient.waitForTransactionReceipt({ hash: submitTx });
const id = parseEventLogs({ abi: aggregatorAbi, logs: r.logs, eventName: "BatchSubmitted" })[0]!.args.id;
const [, , deadline] = await publicClient.readContract({ address: aggregator, abi: aggregatorAbi, functionName: "batches", args: [id] });
console.log(`batch ${id} from ${account.address}, deadline ${deadline}; waiting for a watchtower...`);

let slashed = false;
let challengeTx: string | undefined;
for (;;) {
  const b = await publicClient.readContract({ address: aggregator, abi: aggregatorAbi, functionName: "batches", args: [id] });
  if (b[4]) {
    slashed = true;
    break;
  }
  const { timestamp } = await publicClient.getBlock({ blockTag: "latest" });
  if (timestamp >= deadline) break;
  await new Promise((res) => setTimeout(res, 3000));
}
if (slashed) {
  const latest = await publicClient.getBlockNumber();
  for (let from = r.blockNumber; from <= latest && !challengeTx; from += 100n) {
    const to = from + 99n < latest ? from + 99n : latest;
    const logs = await publicClient.getLogs({ address: aggregator, fromBlock: from, toBlock: to });
    challengeTx = parseEventLogs({ abi: aggregatorAbi, logs, eventName: "BatchSlashed" }).find((l) => l.args.id === id)?.transactionHash;
  }
}
console.log(slashed ? `batch ${id} SLASHED${challengeTx ? ` by ${txLink(explorer, challengeTx as any)}` : ""}` : `batch ${id} was NOT slashed before its window closed`);
server.close();
if (process.env.RECORD === "1") {
  const p = resolve(AGG_DIR, "deployments-service.json");
  const j = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
  j.tamperRuns = j.tamperRuns ?? [];
  j.tamperRuns.push({ at: new Date().toISOString(), batchId: Number(id), leaves: N, badIndex: BAD, withheld: WITHHOLD, submitTx, slashed, challengeTx });
  writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
}
