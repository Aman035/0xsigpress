// Validity-proof lane (K10-terminal): leanXMSS batches -> leanVM -> Keccak terminal STARK -> generated
// Solidity verifier + SigpressTerminalGate on Monad. This module drives the research prover in
// experiments/k10-terminal/ (vendored, not reused as product code) and submits its proof to the gate.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  bytesToHex,
  concat,
  encodeFunctionData,
  getAddress,
  hexToBytes,
  keccak256,
  pad,
  parseAbi,
  toBytes,
  toHex,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { AGG_DIR, type getClients } from "./chain.ts";

export const K10_DIR = resolve(AGG_DIR, "../experiments/k10-terminal");
export const VALIDITY_OUT = resolve(AGG_DIR, "out/validity");
export const PROVER_LOCK = "/private/tmp/claude-501/sigpress-prover.lock";
const SOL_DIR = resolve(K10_DIR, "vendor/sol-whir-p3");
const LEANVM_DIR = resolve(K10_DIR, "vendor/leanVM");
const GATE_ARTIFACT = resolve(K10_DIR, "gate/out/SigpressTerminalGate.sol/SigpressTerminalGate.json");
const GATES_FILE = resolve(AGG_DIR, "deployments-validity.json");

// The 2 x 4 verifier from the first K10 Monad run (README). Only accepts unpadded 2 x 4 proofs.
const VERIFIER_2X4 = getAddress("0x92a964b177f2d6726121829df3218b9e667f4e9b");

export const gateAbi = parseAbi([
  "function registrar() view returns (address)",
  "function verifier() view returns (address)",
  "function pairKey(bytes32 left, bytes32 right) pure returns (bytes32)",
  "function registeredRoot(bytes32 key) view returns (bytes32)",
  "function accepted(bytes32 key) view returns (bool)",
  "function register(bytes32 left, bytes32 right, uint256[8] applicationRoot)",
  "event BatchPairAccepted(bytes32 indexed leftBatchRoot, bytes32 indexed rightBatchRoot, bytes32 rootHash)",
]);

export interface Target {
  shape: "2x256" | "2x4";
  verifier: Address;
  maxPerChild: number;
  minLogRows?: string; // SIGPRESS_MIN_LOG_ROWS that pads a child to the verifier's fixed shape
  source: string;
}

/** Prefer the fixed-shape 2 x 256 verifier (deployed-2x256.json) when present, else the 2 x 4 one. */
export function loadTarget(): Target {
  const p = resolve(K10_DIR, "deployed-2x256.json");
  if (existsSync(p)) {
    const j = JSON.parse(readFileSync(p, "utf8"));
    const addr = typeof j.verifier === "string" ? j.verifier : j.verifier?.address;
    if (addr) return { shape: "2x256", verifier: getAddress(addr), maxPerChild: 256, minLogRows: "18,13,16", source: p };
  }
  return { shape: "2x4", verifier: VERIFIER_2X4, maxPerChild: 4, source: "experiments/k10-terminal/README.md" };
}

/** What `pnpm validity` saves next to a proof so it can be re-submitted later (PROOF_DIR). */
export interface ProofMeta {
  shape: string;
  verifier: Address;
  perChild: number;
  signatures: number;
  leftBatchRoot: Hex;
  rightBatchRoot: Hex;
  applicationRoot: string[]; // 8 KoalaBear words, decimal strings
  appRootOffchainMatch: boolean;
  proveSeconds?: number; // wall time of the prover process (keygen + sign + all proving + native checks)
  leanvmProvingSeconds?: number; // report.json total_leanvm_proving_ms
  maxRssBytes?: number;
  terminalProofBytes?: number; // native postcard proof size
  verifyCalldataBytes: number; // verifyC1V1 calldata.bin
  createdAt: string;
}

const sh = (cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) => {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, encoding: "utf8", maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.status}): ${r.stderr || r.stdout}`);
  return r.stdout;
};

/**
 * Prove two fresh leanXMSS batches (perChild signers each, each batch signs its own 32-byte root) and
 * write the terminal proof + Solidity calldata into outDir. Holds the shared prover lock while proving.
 */
export function prove(opts: { outDir: string; perChild: number; left: Hex; right: Hex; target: Target; log: (s: string) => void }): ProofMeta {
  const { outDir, perChild, left, right, target, log } = opts;
  const bin = resolve(LEANVM_DIR, "target/release/sigpress-xmss-terminal");
  if (!existsSync(bin)) throw new Error(`prover binary missing: ${bin} (see experiments/k10-terminal/README.md Commands)`);
  const env = [
    "LEANVM_PROVING_TIMEOUT_SECONDS=0",
    `LEANVM_TERMINAL_EXPORT=${q(resolve(outDir, "native"))}`,
    `SIGPRESS_LEFT_ROOT=${left}`,
    `SIGPRESS_RIGHT_ROOT=${right}`,
    ...(target.minLogRows ? [`SIGPRESS_MIN_LOG_ROWS=${target.minLogRows}`] : []),
  ].join(" ");
  const cmd = `${env} /usr/bin/time -l ${q(bin)} ${perChild} ${q(resolve(outDir, "report.json"))} ${q(resolve(K10_DIR, "profiles/sigpress_c1.json"))}`;
  // Shared 16 GB machine: one prover at a time. The trap releases the lock on success, failure or Ctrl-C.
  const script = `until mkdir ${PROVER_LOCK} 2>/dev/null; do sleep 10; done; trap 'rmdir ${PROVER_LOCK} 2>/dev/null' EXIT INT TERM; cd ${q(LEANVM_DIR)} && ${cmd} > ${q(resolve(outDir, "proving.log"))} 2>&1`;
  log(`waiting for prover lock ${PROVER_LOCK} ...`);
  const t0 = performance.now();
  const r = spawnSync("bash", ["-c", script], { stdio: "inherit" });
  const proveSeconds = (performance.now() - t0) / 1000;
  if (r.status !== 0) throw new Error(`prover failed (exit ${r.status}); see ${resolve(outDir, "proving.log")}`);
  const logTxt = readFileSync(resolve(outDir, "proving.log"), "utf8");
  const rss = /(\d+)\s+maximum resident set size/.exec(logTxt);
  const wall = /([\d.]+) real/.exec(logTxt);
  const meta = finish(outDir, target);
  meta.proveSeconds = Math.round((wall ? Number(wall[1]) : proveSeconds) * 10) / 10;
  if (rss) meta.maxRssBytes = Number(rss[1]);
  writeFileSync(resolve(outDir, "validity-proof.json"), JSON.stringify(meta, null, 2) + "\n");
  return meta;
}

/**
 * From a run dir with report.json + native/root-fixture.json: check the application root off chain
 * (tools/app_root.py) and generate the verifyC1V1 calldata with the sol-whir-p3 generator (unique label,
 * outputs moved into the run dir and the vendor copies removed).
 */
export function finish(runDir: string, target: Target): ProofMeta {
  const app = JSON.parse(sh("python3", ["-I", resolve(K10_DIR, "tools/app_root.py"), runDir]));
  if (!app.match) throw new Error("application root recomputed off chain does not match the proof");
  if (!existsSync(resolve(runDir, "calldata.bin"))) {
    const label = `SigpressVal${Date.now()}`;
    sh("python3", ["script/generate_leanvm_two_commitment_terminal_fixture.py", resolve(runDir, "native/root-fixture.json"), label], {
      cwd: SOL_DIR,
      env: { SIGPRESS_NO_PROVENANCE: "1", PYTHONPATH: resolve(K10_DIR, "tools") },
    });
    const contract = `LeanVmTwoCommitmentTerminal_${label}`;
    const data = resolve(SOL_DIR, "testdata/leanvm_terminal", label);
    copyFileSync(resolve(data, "calldata.bin"), resolve(runDir, "calldata.bin"));
    copyFileSync(resolve(data, "manifest.json"), resolve(runDir, "solidity-manifest.json"));
    copyFileSync(resolve(SOL_DIR, "src/leanvm/generated", `${contract}.sol`), resolve(runDir, "generated-verifier.sol.txt"));
    for (const p of [data, resolve(SOL_DIR, "src/leanvm/generated", `${contract}.sol`), resolve(SOL_DIR, "test", `${contract}.t.sol`), resolve(SOL_DIR, "script", `${contract}.s.sol`)])
      rmSync(p, { recursive: true, force: true });
  }
  const report = JSON.parse(readFileSync(resolve(runDir, "report.json"), "utf8"));
  const fixture = JSON.parse(readFileSync(resolve(runDir, "native/root-fixture.json"), "utf8"));
  const perChild = Number(report.applications?.[0]?.signers);
  const prev = existsSync(resolve(runDir, "validity-proof.json")) ? (JSON.parse(readFileSync(resolve(runDir, "validity-proof.json"), "utf8")) as Partial<ProofMeta>) : {};
  const meta: ProofMeta = {
    ...prev,
    shape: target.shape,
    verifier: target.verifier,
    perChild,
    signatures: report.applications.reduce((s: number, a: { signers: number }) => s + Number(a.signers), 0),
    leftBatchRoot: app.left_batch_root,
    rightBatchRoot: app.right_batch_root,
    applicationRoot: app.proof_application_root.map((v: number) => String(v)),
    appRootOffchainMatch: true,
    leanvmProvingSeconds: report.total_leanvm_proving_ms ? Math.round(report.total_leanvm_proving_ms / 100) / 10 : prev.leanvmProvingSeconds,
    terminalProofBytes: Number(fixture.proof_bytes) || prev.terminalProofBytes,
    verifyCalldataBytes: statSync(resolve(runDir, "calldata.bin")).size,
    createdAt: prev.createdAt ?? new Date().toISOString(),
  };
  writeFileSync(resolve(runDir, "validity-proof.json"), JSON.stringify(meta, null, 2) + "\n");
  return meta;
}

/** Latest proof saved by `pnpm validity` (optionally for a given verifier). */
export function latestProofDir(verifier?: Address): string | undefined {
  if (!existsSync(VALIDITY_OUT)) return undefined;
  const dirs = readdirSync(VALIDITY_OUT)
    .map((d) => resolve(VALIDITY_OUT, d))
    .filter((d) => existsSync(resolve(d, "validity-proof.json")) && existsSync(resolve(d, "calldata.bin")))
    .sort()
    .reverse();
  const match = verifier ? dirs.find((d) => getAddress(JSON.parse(readFileSync(resolve(d, "validity-proof.json"), "utf8")).verifier) === verifier) : undefined;
  return match ?? dirs[0];
}

/** gate.submit(proof, left, right) calldata from verifyC1V1 calldata (selector ++ word(0x20) ++ proof tuple). */
export function submitCalldata(verifyCalldata: Uint8Array, left: Hex, right: Hex): Hex {
  if (BigInt(bytesToHex(verifyCalldata.slice(4, 36))) !== 0x20n) throw new Error("unexpected calldata.bin layout");
  const sel = keccak256(toBytes("submit((bytes,bytes,uint256[8],uint256[],uint256,uint256[],uint256,uint256),bytes32,bytes32)")).slice(0, 10) as Hex;
  return concat([sel, pad(toHex(0x60), { size: 32 }), left, right, bytesToHex(verifyCalldata.slice(36))]);
}

type Clients = Awaited<ReturnType<typeof getClients>>;

/** Gas limit = estimate + 5% (Monad charges the limit). */
async function send(c: Clients, to: Address | undefined, data: Hex) {
  const est = await c.publicClient.estimateGas({ account: c.account, to, data });
  const gas = (est * 105n) / 100n;
  const hash = await c.walletClient.sendTransaction({ account: c.account, chain: c.chain, to, data, gas });
  const r = await c.publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (r.status !== "success") throw new Error(`tx ${hash} reverted`);
  return { hash, est, gas, receipt: r };
}

/** A gate whose registrar is this account, for this verifier: reuse from deployments-validity.json or deploy. */
export async function ensureGate(c: Clients, verifier: Address, log: (s: string) => void): Promise<{ gate: Address; deployTx?: Hash }> {
  const all = existsSync(GATES_FILE) ? (JSON.parse(readFileSync(GATES_FILE, "utf8")) as Record<string, { gate: Address; registrar: Address; deployTx: Hash; chainId: number }>) : {};
  const key = `${c.chainId}:${verifier}`;
  const known = all[key];
  if (known && getAddress(known.registrar) === getAddress(c.account.address)) {
    const code = await c.publicClient.getCode({ address: known.gate });
    if (code && code !== "0x") return { gate: known.gate };
  }
  const art = JSON.parse(readFileSync(GATE_ARTIFACT, "utf8"));
  const data = concat([art.bytecode.object as Hex, pad(verifier, { size: 32 })]);
  log(`deploying SigpressTerminalGate(verifier=${verifier}) with registrar ${c.account.address} ...`);
  const r = await send(c, undefined, data);
  const gate = getAddress(r.receipt.contractAddress!);
  all[key] = { gate, registrar: getAddress(c.account.address), deployTx: r.hash, chainId: c.chainId };
  writeFileSync(GATES_FILE, JSON.stringify(all, null, 2) + "\n");
  return { gate, deployTx: r.hash };
}

function revertReason(e: unknown): string {
  const msg = String((e as Error)?.message ?? e);
  const m = /reverted with the following reason:\s*\n?\s*([^\n]+)/.exec(msg) ?? /reason:\s*([^\n]+)/.exec(msg) ?? /\b([A-Z][A-Z_]{3,})\b/.exec(msg);
  return (m?.[1] ?? (e as { shortMessage?: string }).shortMessage ?? "reverted").trim().replace(/\.$/, "");
}

export interface ValidityResult {
  txHash: Hash;
  gasEstimate: number;
  gasCharged: number;
  calldataBytes: number;
  signatures: number;
  perChild: number;
  gasPerSignature: number;
  bytesPerSignature: number;
  proofBytes?: number;
  verifyCalldataBytes: number;
  proveSeconds?: number;
  verifier: Address;
  gate: Address;
  shape: string;
  leftBatchRoot: Hex;
  rightBatchRoot: Hex;
  registerTx?: Hash;
  gateDeployTx?: Hash;
  accepted: boolean;
  tamper: { flippedByte: number; reverted: boolean; reason: string };
  provedAt: string;
  replay: boolean;
  at: string;
  notBound: string[];
}

export const NOT_BOUND = [
  "batch root -> applicationRoot is registered by a trusted registrar (recomputed off chain, not by the contract)",
  "signer set is inside the proof's digest; the contract never sees the public keys",
  "one shared 32-byte message per child batch, not per-user ops; exactly two children",
  "KoalaBear/Poseidon leanXMSS with deterministic test keys, not our WOTS.sol accounts",
  "security = the authors' 100-bit component targets; full-chain composition not analysed",
];

/**
 * Register (if needed) and submit a proof dir to a gate for its verifier. Pre-checks with eth_call so a
 * bad proof never costs a 12M-gas reverted tx. Also runs a tampered-proof eth_call that must revert.
 */
export async function submitProof(c: Clients, proofDir: string, target: Target, log: (s: string) => void): Promise<ValidityResult> {
  const meta = JSON.parse(readFileSync(resolve(proofDir, "validity-proof.json"), "utf8")) as ProofMeta;
  const verifyCd = new Uint8Array(readFileSync(resolve(proofDir, "calldata.bin")));
  const { publicClient } = c;

  const ok = await publicClient.call({ to: target.verifier, data: bytesToHex(verifyCd) }).catch((e) => {
    throw new Error(`verifier ${target.verifier} (${target.shape}) rejects this proof (${revertReason(e)}); proof shape ${meta.shape}`);
  });
  if (!ok.data || BigInt(ok.data) !== 1n) throw new Error(`verifyC1V1 returned ${ok.data}`);
  log(`eth_call verifyC1V1 on ${target.shape} verifier ${target.verifier}: true`);

  const { gate, deployTx } = await ensureGate(c, target.verifier, log);
  const key = await publicClient.readContract({ address: gate, abi: gateAbi, functionName: "pairKey", args: [meta.leftBatchRoot, meta.rightBatchRoot] });
  const appRoot = meta.applicationRoot.map((v) => BigInt(v)) as unknown as readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
  const registered = await publicClient.readContract({ address: gate, abi: gateAbi, functionName: "registeredRoot", args: [key] });
  let registerTx: Hash | undefined;
  if (BigInt(registered) === 0n) {
    const r = await send(c, gate, encodeFunctionData({ abi: gateAbi, functionName: "register", args: [meta.leftBatchRoot, meta.rightBatchRoot, appRoot] }));
    registerTx = r.hash;
    log(`register(left, right, applicationRoot) ${r.hash}`);
  }

  const data = submitCalldata(verifyCd, meta.leftBatchRoot, meta.rightBatchRoot);
  await publicClient.call({ account: c.account, to: gate, data }).catch((e) => {
    throw new Error(`gate.submit eth_call reverts (${revertReason(e)}); not sending`);
  });

  // Tampered proof: flip one bit inside the proof bytes (same spot as the K10 run). Must revert.
  const flippedByte = 60_000;
  const bad = hexToBytes(data);
  bad[flippedByte] ^= 0x01;
  let reverted = false;
  let reason = "did not revert";
  try {
    await publicClient.call({ account: c.account, to: gate, data: bytesToHex(bad) });
  } catch (e) {
    reverted = true;
    reason = revertReason(e);
  }
  if (!reverted) throw new Error("tampered proof was accepted by eth_call; refusing to continue");

  const wasAccepted = await publicClient.readContract({ address: gate, abi: gateAbi, functionName: "accepted", args: [key] });
  const r = await send(c, gate, data);
  const accepted = await publicClient.readContract({ address: gate, abi: gateAbi, functionName: "accepted", args: [key] });
  const calldataBytes = hexToBytes((await publicClient.getTransaction({ hash: r.hash })).input).length;
  const gasCharged = Number(r.receipt.gasUsed);
  return {
    txHash: r.hash,
    gasEstimate: Number(r.est),
    gasCharged,
    calldataBytes,
    signatures: meta.signatures,
    perChild: meta.perChild,
    gasPerSignature: Math.round(gasCharged / meta.signatures),
    bytesPerSignature: Math.round((calldataBytes / meta.signatures) * 10) / 10,
    proofBytes: meta.terminalProofBytes,
    verifyCalldataBytes: meta.verifyCalldataBytes,
    proveSeconds: meta.proveSeconds,
    verifier: target.verifier,
    gate,
    shape: target.shape,
    leftBatchRoot: meta.leftBatchRoot,
    rightBatchRoot: meta.rightBatchRoot,
    registerTx,
    gateDeployTx: deployTx,
    accepted,
    tamper: { flippedByte, reverted, reason },
    provedAt: meta.createdAt,
    replay: wasAccepted,
    at: new Date().toISOString(),
    notBound: NOT_BOUND,
  };
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
