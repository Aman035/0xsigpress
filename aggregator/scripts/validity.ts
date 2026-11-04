// Validity-proof lane: prove two fresh leanXMSS batches into one Keccak terminal STARK (research prover in
// experiments/k10-terminal/), then verify it on Monad testnet through SigpressTerminalGate in one tx.
//   pnpm validity                         prove fresh (~50-70 s, ~6 GB, holds the shared prover lock) + submit
//   PROOF_DIR=out/validity/<run> pnpm validity   submit a pre-built proof (no proving)
// Env: KEY_VAR (default PRIVATE_KEY_K12), PER_CHILD (signers per batch; default = verifier max: 256 or 4),
//      PROVE_ONLY=1 (skip the chain), RPC_URL,
//      SOURCE=sdk: create fresh user keys with the TS SDK (src/sdk/leanxmss.ts), sign + export two batches and
//      prove them with the K11 runner (default PER_CHILD 16); results go under `validitySdk`.
// Uses the fixed-shape 2 x 256 verifier from experiments/k10-terminal/deployed-2x256.json if present
// (smaller batches are padded to its shape), else the 2 x 4 verifier from the K10 README.
import { mkdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { formatEther, keccak256, toBytes } from "viem";
import { AGG_DIR, getClients, MONAD_EXPLORER, txLink } from "../src/chain.ts";
import { writeResults } from "../src/results.ts";
import { finish, loadTarget, NOT_BOUND, prove, signSdkBatches, submitProof, VALIDITY_OUT, type ProofMeta } from "../src/validity.ts";
import { existsSync, readFileSync } from "node:fs";

process.env.KEY_VAR ??= "PRIVATE_KEY_K12";
const log = (s: string) => console.log(`  ${s}`);
const SDK = process.env.SOURCE === "sdk";
if (process.env.SOURCE && !SDK) throw new Error("SOURCE must be unset or 'sdk'");
const target = loadTarget();
console.log(`validity lane · ${target.shape} verifier ${target.verifier} (from ${target.source})`);

let proofDir: string;
if (process.env.PROOF_DIR) {
  proofDir = resolve(process.env.PROOF_DIR);
  if (!existsSync(resolve(proofDir, "native/root-fixture.json"))) throw new Error(`${proofDir} has no native/root-fixture.json`);
  finish(proofDir, target); // off-chain app-root check + calldata (no-op for calldata if already generated)
  log(`using pre-built proof ${proofDir}`);
} else {
  const perChild = Number(process.env.PER_CHILD ?? (SDK ? 16 : target.maxPerChild));
  if (!Number.isInteger(perChild) || perChild < 1 || perChild > target.maxPerChild) throw new Error(`PER_CHILD must be 1..${target.maxPerChild} for the ${target.shape} verifier`);
  if (target.shape === "2x4" && perChild !== 4) throw new Error("the 2 x 4 verifier only accepts exactly 4 signers per child (unpadded)");
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  proofDir = resolve(VALIDITY_OUT, `${ts}-${target.shape}-n${perChild}${SDK ? "-sdk" : ""}`);
  mkdirSync(proofDir, { recursive: true });
  // Fresh 32-byte batch roots: each child batch's signers all sign its root.
  const left = keccak256(toBytes(`sigpress-validity-${ts}-left`));
  const right = keccak256(toBytes(`sigpress-validity-${ts}-right`));
  log(`left root ${left}\n  right root ${right}`);
  const sdk = SDK ? signSdkBatches({ dir: proofDir, perChild, left, right, log }) : undefined;
  log(`proving 2 x ${perChild} ${SDK ? "SDK-signed " : ""}leanXMSS signatures -> leanVM -> lift -> Keccak terminal (${proofDir})`);
  const meta = prove({ outDir: proofDir, perChild, left, right, target, log, sdk });
  log(`proved in ${meta.proveSeconds} s wall (leanVM proving ${meta.leanvmProvingSeconds} s, max RSS ${((meta.maxRssBytes ?? 0) / 1e9).toFixed(2)} GB), terminal proof ${meta.terminalProofBytes} B, application root matches off chain`);
}
if (process.env.PROVE_ONLY === "1") process.exit(0);

const c = await getClients();
const explorer = c.chainId === 10143 ? MONAD_EXPLORER : undefined;
log(`sender ${c.account.address} · balance ${formatEther(await c.publicClient.getBalance({ address: c.account.address }))} MON · chain ${c.chainId}`);
const v = await submitProof(c, proofDir, target, log);
log(`tampered proof (bit flipped at byte ${v.tamper.flippedByte}) eth_call: reverts ${v.tamper.reason}`);
log(`submit ${txLink(explorer, v.txHash)}`);
log(`accepted=${v.accepted} · ${v.signatures} signatures · estimate ${v.gasEstimate.toLocaleString("en-US")} · charged ${v.gasCharged.toLocaleString("en-US")} gas (${v.gasPerSignature.toLocaleString("en-US")} gas/sig) · calldata ${v.calldataBytes.toLocaleString("en-US")} B (${v.bytesPerSignature} B/sig)`);
const meta = JSON.parse(readFileSync(resolve(proofDir, "validity-proof.json"), "utf8")) as ProofMeta;
if (SDK && meta.source !== "sdk") throw new Error(`${proofDir} is not an SDK-signed proof (source ${meta.source ?? "test-keys"})`);
if (meta.source === "sdk") {
  const notBound = NOT_BOUND.map((s) => (s.startsWith("KoalaBear") ? "KoalaBear/Poseidon leanXMSS user keys from the TS SDK (src/sdk/leanxmss.ts), not our WOTS.sol accounts" : s));
  writeResults({ validitySdk: { ...v, notBound, source: "sdk", sdk: meta.sdk && { ...meta.sdk, left: relative(AGG_DIR, meta.sdk.left), right: relative(AGG_DIR, meta.sdk.right) }, leanvmProvingSeconds: meta.leanvmProvingSeconds, maxRssBytes: meta.maxRssBytes, proofDir: relative(AGG_DIR, proofDir) } });
} else {
  writeResults({ validity: { ...v, proofDir: relative(AGG_DIR, proofDir) } });
}
