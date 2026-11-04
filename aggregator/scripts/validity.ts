// Validity-proof lane (binding v2): 2 x N leanXMSS signers, EACH over its own 32-byte message, proved into one Keccak
// terminal STARK and verified on Monad testnet by SigpressBindV2Gate in one tx. No registrar, no register step: the
// gate rebuilds the proof's statement from the raw pubkeys and messages in calldata.
//   pnpm validity                                 SDK keys sign their own op hashes, prove (~1-2 min), submit
//   SHAPE=2x1024 PROVE_ONLY=1 pnpm validity       pre-build a proof (e.g. for the stage's Beat 5)
//   PROOF_DIR=out/validity/<run> pnpm validity    submit a pre-built proof (no proving)
// Env: SHAPE=2x256|2x1024 (default 2x256; the deployed verifier/gate pair, see src/validity.ts),
//      SOURCE=sdk|test-keys (default sdk: fresh user keys through src/sdk/leanxmss.ts; test-keys: the prover makes
//      its own keys and messages), KEY_VAR (default PRIVATE_KEY_K12), PROVE_ONLY=1, RPC_URL, CONCURRENCY (default 8).
import { mkdirSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { formatEther, getAddress, keccak256, toHex } from "viem";
import { AGG_DIR, getClients, MONAD_EXPLORER, txLink } from "../src/chain.ts";
import { writeResults } from "../src/results.ts";
import {
  exportBatches,
  finishV2,
  gatePubkeyOf,
  loadShape,
  makeSdkKeys,
  parseShape,
  proveV2,
  readProof,
  signAll,
  submitProofV2,
  validityOpHash,
  VALIDITY_OUT,
} from "../src/validity.ts";

process.env.KEY_VAR ??= "PRIVATE_KEY_K12";
const log = (s: string) => console.log(`  ${s}`);
const shape = parseShape(process.env.SHAPE);
const source = (process.env.SOURCE ?? "sdk") as "sdk" | "test-keys";
if (source !== "sdk" && source !== "test-keys") throw new Error("SOURCE must be sdk or test-keys");
const proveOnly = process.env.PROVE_ONLY === "1";
const c = proveOnly ? undefined : await getClients();
const target = loadShape(shape, c?.chainId ?? 10143);
console.log(`validity lane (binding v2) · ${shape} · verifier ${target.verifier} · gate ${target.gate}`);

let proofDir: string;
if (process.env.PROOF_DIR) {
  proofDir = resolve(process.env.PROOF_DIR);
  finishV2(proofDir, target, "sdk"); // off-chain statement check + calldata (no-op if already generated)
  log(`using pre-built proof ${proofDir}`);
} else {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  proofDir = resolve(VALIDITY_OUT, `${ts}-v2-${shape}${source === "sdk" ? "-sdk" : ""}`);
  mkdirSync(proofDir, { recursive: true });
  let batches: { left: string; right: string } | undefined;
  let sdkInfo: { keygenMsTotal: number; signMsTotal: number; batchBytes: [number, number]; messages: string } | undefined;
  if (source === "sdk") {
    const n = target.perChild;
    const conc = Number(process.env.CONCURRENCY ?? 8);
    const slot = 3; // the aggregator picks one slot for the whole proof; fresh keys sign 2^4 slots
    log(`creating ${2 * n} fresh SDK keys (leanXMSS, logSlots 4) ...`);
    const t0 = performance.now();
    const { signers, keygenMs } = await makeSdkKeys(resolve(proofDir, "keys"), 2 * n, { prefix: "user", logSlots: 4, concurrency: conc });
    log(`keys in ${((performance.now() - t0) / 1000).toFixed(1)} s (CLI keygen total ${keygenMs} ms)`);
    // Each user signs ITS OWN op hash: ValidityEntry.opHash for a synthetic op of an account derived from its key
    // (the accounts are not deployed here; the service path, MODE=validity, uses real ValidityEntry accounts).
    const entry = target.entry ?? getAddress("0x0000000000000000000000000000000000000000");
    const items = signers.map((signer, i) => {
      const account = getAddress(`0x${keccak256(gatePubkeyOf(signer.key)).slice(26)}`);
      const message = validityOpHash({ chainId: c?.chainId ?? 10143, entry, account, nonce: 0n, target: account, value: 0n, data: toHex(`sigpress pnpm validity ${ts} #${i}`) });
      return { signer, message };
    });
    const t1 = performance.now();
    const sigs = await signAll(items, slot, conc);
    const signMs = Math.round(performance.now() - t1);
    log(`${sigs.length} users signed their own op hashes at slot ${slot} in ${(signMs / 1000).toFixed(1)} s (${new Set(items.map((x) => x.message)).size} distinct messages)`);
    const ex = exportBatches(proofDir, sigs.slice(0, n), sigs.slice(n));
    batches = ex;
    sdkInfo = { keygenMsTotal: keygenMs, signMsTotal: signMs, batchBytes: ex.bytes, messages: "ValidityEntry.opHash of a synthetic op per user (undeployed account derived from its key)" };
  }
  const meta = await proveV2({ outDir: proofDir, target, batches, log });
  if (sdkInfo) {
    meta.sdk = sdkInfo;
    writeFileSync(resolve(proofDir, "validity-proof.json"), JSON.stringify(meta, null, 2) + "\n");
  }
  log(`proved in ${meta.proveSeconds} s wall (leanVM proving ${meta.leanvmProvingSeconds} s, max RSS ${((meta.maxRssBytes ?? 0) / 1e9).toFixed(2)} GB), terminal proof ${meta.terminalProofBytes} B; statement recomputed off chain matches; distinct messages: ${meta.distinctMessages}`);
}
const { meta } = readProof(proofDir);
log(`proof ${relative(AGG_DIR, proofDir)} · ${meta.signatures} signatures · commitment ${meta.commitment}`);
if (proveOnly || !c) process.exit(0);

const explorer = c.chainId === 10143 ? MONAD_EXPLORER : undefined;
log(`sender ${c.account.address} · balance ${formatEther(await c.publicClient.getBalance({ address: c.account.address }))} MON · chain ${c.chainId}`);
const v = await submitProofV2(c, proofDir, target, log);
log(`submit ${txLink(explorer, v.txHash)}`);
log(`accepted=${v.accepted} · ${v.signatures} signatures, ${v.distinctMessages ? "all messages distinct" : "REPEATED messages"} · estimate ${v.gasEstimate.toLocaleString("en-US")} · charged ${v.gasCharged.toLocaleString("en-US")} gas (${v.gasPerSig.toLocaleString("en-US")} gas/sig) · calldata ${v.calldataBytes.toLocaleString("en-US")} B (${v.bytesPerSig} B/sig)`);
writeResults({ validity: { ...v, proofDir: relative(AGG_DIR, proofDir), sdk: meta.sdk, explorerTx: explorer ? txLink(explorer, v.txHash) : undefined } });
