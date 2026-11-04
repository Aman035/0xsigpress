// Batch of N ops -> one submitBatch tx carrying only a 32-byte root.
import { hexToBytes } from "viem";
import { getClients, loadDeployments, txLink } from "../src/chain.ts";
import { aggregatorAbi } from "../src/abi.ts";
import { buildBatch } from "../src/batch.ts";
import { writeResults } from "../src/results.ts";

const N = Number(process.env.N ?? 256);
const d = loadDeployments();
const { chainId, publicClient, walletClient, account } = await getClients();
const explorer = chainId === 10143 ? d.explorer : undefined;

console.log(`account ${account.address}, chain ${chainId}, aggregator ${d.aggregator}; signing ${N} ops...`);
const t0 = Date.now();
const { tree, daFile, dataURI } = buildBatch({ n: N, chainId, aggregator: d.aggregator, seedTag: "sigpress-demo" });
console.log(`built batch in ${Date.now() - t0} ms, root ${tree.root}, DA file ${daFile}`);

const bond = await publicClient.readContract({ address: d.aggregator, abi: aggregatorAbi, functionName: "bond" });
const hash = await walletClient.writeContract({
  address: d.aggregator,
  abi: aggregatorAbi,
  functionName: "submitBatch",
  args: [tree.root, N, dataURI],
  value: bond,
});
console.log(`submitted ${txLink(explorer, hash)}`);
const receipt = await publicClient.waitForTransactionReceipt({ hash });
if (receipt.status !== "success") throw new Error(`tx reverted: ${hash}`);
const tx = await publicClient.getTransaction({ hash });
const inputBytes = hexToBytes(tx.input).length;
const bytesPerOp = inputBytes / N;
console.log(`gasUsed ${receipt.gasUsed}, input ${inputBytes} B, bytesPerOp ${bytesPerOp}`);
writeResults({ batch: { txHash: hash, gasUsed: Number(receipt.gasUsed), count: N, root: tree.root, bytesPerOp } });
