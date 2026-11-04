// One naive post-quantum tx: WOTS signature verified on chain by NaiveLane.submit.
import { hexToBytes, keccak256, toBytes } from "viem";
import { getClients, loadDeployments, txLink } from "../src/chain.ts";
import { keygen, sign, verify } from "../src/wots.ts";
import { messageOf } from "../src/op.ts";
import { naiveLaneAbi } from "../src/abi.ts";
import { writeResults } from "../src/results.ts";

const d = loadDeployments();
const { chainId, publicClient, walletClient, account } = await getClients();
const explorer = chainId === 10143 ? d.explorer : undefined;

const seed = keccak256(toBytes("sigpress-naive"));
const key = keygen(seed, 0);
const next = keygen(seed, 1);
const m = messageOf(chainId, d.naiveLane, key.pkHash, next.pkHash, keccak256(toBytes("naive payload")));
const sig = sign(key.sk, m);
if (!verify(key.pkHash, m, sig)) throw new Error("local verify failed");

console.log(`account ${account.address}, chain ${chainId}, NaiveLane ${d.naiveLane}`);
const hash = await walletClient.writeContract({ address: d.naiveLane, abi: naiveLaneAbi, functionName: "submit", args: [key.pkHash, m, sig] });
console.log(`submitted ${txLink(explorer, hash)}`);
const receipt = await publicClient.waitForTransactionReceipt({ hash });
if (receipt.status !== "success") throw new Error(`tx reverted: ${hash}`);
const tx = await publicClient.getTransaction({ hash });
const calldataBytes = hexToBytes(tx.input).length;
console.log(`gasUsed ${receipt.gasUsed}, calldataBytes ${calldataBytes}`);
writeResults({ naive: { txHash: hash, gasUsed: Number(receipt.gasUsed), calldataBytes } });
