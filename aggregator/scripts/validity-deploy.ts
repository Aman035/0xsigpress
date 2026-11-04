// Deploy a ValidityEntry for a shape's SigpressBindV2Gate (service MODE=validity) and record it in
// deployments-validity-v2.json. On a chain other than Monad testnet (e.g. anvil started with
// `--code-size-limit 131072`) it first deploys the whole stack from the research artifacts: Poseidon1Hasher, the
// generated verifier for the shape and the gate (constant words from the reference run's statement.json).
//   SHAPE=2x256 KEY_VAR=PRIVATE_KEY_K14 pnpm validity:deploy
// Needs: cd contracts && forge build (ValidityEntry), and the binding-v2 / sol-whir-p3-binding-v2 build outputs.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { encodeAbiParameters, getAddress, parseAbiParameters, type Address, type Hex } from "viem";
import { AGG_DIR, getClients, MONAD_EXPLORER, txLink } from "../src/chain.ts";
import { BIND_V2_DIR, K10_DIR, loadShape, parseShape, saveShapeDeployment, send, type Statement } from "../src/validity.ts";

const shape = parseShape(process.env.SHAPE);
const c = await getClients();
const explorer = c.chainId === 10143 ? MONAD_EXPLORER : undefined;
const art = (p: string): Hex => {
  if (!existsSync(p)) throw new Error(`missing artifact ${p}`);
  return JSON.parse(readFileSync(p, "utf8")).bytecode.object as Hex;
};
const deploy = async (name: string, code: Hex): Promise<Address> => {
  const r = await send(c, undefined, code);
  console.log(`  ${name} ${r.receipt.contractAddress} (${r.receipt.gasUsed} gas charged) ${txLink(explorer, r.hash)}`);
  return getAddress(r.receipt.contractAddress!);
};

let gate: Address, verifier: Address, hasher: Address | undefined;
const base = c.chainId === 10143 ? loadShape(shape) : undefined;
if (base && !process.env.FULL_STACK) {
  ({ gate, verifier } = base);
  console.log(`${shape}: using the deployed gate ${gate} (verifier ${verifier})`);
} else {
  const label = shape === "2x256" ? "SigpressBindV2C1N256" : "SigpressBindV2C1N1024";
  const ref = shape === "2x256" ? "runs/n256" : "runs/n1024";
  const name = `LeanVmTwoCommitmentTerminal_${label}`;
  hasher = await deploy("Poseidon1Hasher", art(resolve(BIND_V2_DIR, "out/Poseidon1Hasher.sol/Poseidon1Hasher.json")));
  verifier = await deploy(name, art(resolve(K10_DIR, `vendor/sol-whir-p3-binding-v2/out/${name}.sol/${name}.json`)));
  const st = JSON.parse(readFileSync(resolve(BIND_V2_DIR, ref, "statement.json"), "utf8")) as Statement;
  const args = encodeAbiParameters(parseAbiParameters("address, address, uint256[]"), [verifier, hasher, st.const_words.map(BigInt)]);
  gate = await deploy("SigpressBindV2Gate", `${art(resolve(BIND_V2_DIR, "out/SigpressBindV2Gate.sol/SigpressBindV2Gate.json"))}${args.slice(2)}` as Hex);
}
const entryArgs = encodeAbiParameters(parseAbiParameters("address"), [gate]);
const entry = await deploy("ValidityEntry", `${art(resolve(AGG_DIR, "../contracts/out/ValidityEntry.sol/ValidityEntry.json"))}${entryArgs.slice(2)}` as Hex);
saveShapeDeployment(c.chainId, shape, { verifier, gate, entry, ...(hasher ? { hasher } : {}) });
console.log(`recorded ${c.chainId}:${shape} -> ${process.env.VALIDITY_DEPLOYMENTS ?? "deployments-validity-v2.json"}`);
