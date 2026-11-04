// Batch with one bad signature -> challenger finds it off chain -> challenge -> slashed.
import { parseEventLogs } from "viem";
import { getClients, loadDeployments, txLink } from "../src/chain.ts";
import { aggregatorAbi } from "../src/abi.ts";
import { buildBatch } from "../src/batch.ts";
import { verify } from "../src/wots.ts";
import { leafOf } from "../src/op.ts";
import { verifyProof } from "../src/merkle.ts";
import { writeResults } from "../src/results.ts";

const N = Number(process.env.N ?? 256);
const BAD = Number(process.env.BAD_INDEX ?? 7);
const d = loadDeployments();
const { chainId, publicClient, walletClient, account } = await getClients();
const explorer = chainId === 10143 ? d.explorer : undefined;

// --- dishonest aggregator ---
console.log(`account ${account.address}, chain ${chainId}; building batch of ${N} with bad sig at ${BAD}...`);
const { tree, dataURI, ops } = buildBatch({ n: N, chainId, aggregator: d.aggregator, seedTag: "sigpress-tamper", tamperIndex: BAD });
const bond = await publicClient.readContract({ address: d.aggregator, abi: aggregatorAbi, functionName: "bond" });
const submitTx = await walletClient.writeContract({
  address: d.aggregator,
  abi: aggregatorAbi,
  functionName: "submitBatch",
  args: [tree.root, N, dataURI],
  value: bond,
});
console.log(`submitBatch ${txLink(explorer, submitTx)}`);
const subReceipt = await publicClient.waitForTransactionReceipt({ hash: submitTx });
if (subReceipt.status !== "success") throw new Error(`submit reverted: ${submitTx}`);
const ev = parseEventLogs({ abi: aggregatorAbi, logs: subReceipt.logs, eventName: "BatchSubmitted" })[0];
if (!ev) throw new Error("no BatchSubmitted event");
const id = ev.args.id;
console.log(`batch id ${id}, root ${ev.args.root}`);

// --- challenger: re-check every signature from the DA data ---
const bad = ops.findIndex((o) => !verify(o.pkHash, o.m, o.sig));
if (bad < 0) throw new Error("challenger found no bad signature");
const op = ops[bad]!;
const proof = tree.proof(bad);
if (!verifyProof(tree.root, leafOf(op.pkHash, op.m, op.sig), bad, proof)) throw new Error("bad local proof");
console.log(`challenger: signature ${bad} is invalid; challenging`);
const challengeTx = await walletClient.writeContract({
  address: d.aggregator,
  abi: aggregatorAbi,
  functionName: "challenge",
  args: [id, op.pkHash, op.m, op.sig, BigInt(bad), proof],
});
console.log(`challenge ${txLink(explorer, challengeTx)}`);
const chReceipt = await publicClient.waitForTransactionReceipt({ hash: challengeTx });
if (chReceipt.status !== "success") throw new Error(`challenge reverted: ${challengeTx}`);
const slashedEv = parseEventLogs({ abi: aggregatorAbi, logs: chReceipt.logs, eventName: "BatchSlashed" });
const b = await publicClient.readContract({ address: d.aggregator, abi: aggregatorAbi, functionName: "batches", args: [id] });
const slashed = b[4] && slashedEv.length > 0;
console.log(`slashed: ${slashed} (challenge gasUsed ${chReceipt.gasUsed})`);
writeResults({ tamper: { submitTx, challengeTx, slashed } });
