// Validity-proof lane, binding v2 (experiments/k10-terminal/binding-v2): leanXMSS signers, each over its OWN 32-byte
// message -> leanVM aggregation x2 -> lift -> Keccak terminal STARK -> generated Solidity verifier, checked on chain by
// SigpressBindV2Gate in one tx. No registrar: the gate recomputes the proof's statement from the raw pubkeys and
// messages in calldata (~3.2k gas per signer). This module drives the research prover (vendored, not product code),
// builds the gate calldata and submits it.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  bytesToHex,
  decodeErrorResult,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  hexToBytes,
  keccak256,
  parseAbi,
  parseAbiParameters,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { AGG_DIR, type getClients } from "./chain.ts";
import { createLeanXmssKeyStore, leanxmssExportBatch, leanxmssGatePubkey, leanxmssKeygenAsync, leanxmssSignAsync, leanxmssVerify, type LeanXmssKey, type LeanXmssSignature } from "./sdk/leanxmss.ts";
import { KeyStore } from "./sdk/keystore.ts";

export const K10_DIR = resolve(AGG_DIR, "../experiments/k10-terminal");
export const BIND_V2_DIR = resolve(K10_DIR, "binding-v2");
export const VALIDITY_OUT = resolve(AGG_DIR, "out/validity");
export const PROVER_LOCK = "/private/tmp/claude-501/sigpress-prover.lock";
const LEANVM_DIR = resolve(K10_DIR, "vendor/leanVM-binding-v2");
const SOL_DIR = resolve(K10_DIR, "vendor/sol-whir-p3-binding-v2");
const PROVER_BIN = resolve(LEANVM_DIR, "target/release/sigpress-bindv2-terminal");
const DEPLOYMENTS_FILE = resolve(AGG_DIR, "deployments-validity-v2.json");

export type Shape = "2x256" | "2x1024";
export const SHAPES: Shape[] = ["2x256", "2x1024"];

export interface ShapeTarget {
  shape: Shape;
  perChild: number;
  verifier: Address;
  gate: Address;
  /** ValidityEntry bound to this gate (service MODE=validity), if deployed. */
  entry?: Address;
  /** SIGPRESS_MIN_LOG_ROWS: child table sizes of the proof the verifier was generated from (execution, extension, poseidon16). */
  minLogRows: string;
  /** Label of the reference run's generated verifier (binding-v2/results/<label>). */
  label: string;
  /** Reference run dir (its statement.json carries the gate's constant words). */
  refRun: string;
}

/** Monad testnet deployments from the binding-v2 run (experiments/k10-terminal/binding-v2/README.md). */
const MONAD: Record<Shape, ShapeTarget> = {
  "2x256": {
    shape: "2x256",
    perChild: 256,
    verifier: getAddress("0xa43f61c3936dc4d22b471594f99a33eadc7c4abb"),
    gate: getAddress("0x38eeb174d437c038dd16ca91e682f24cdc71c697"),
    minLogRows: "18,14,16",
    label: "SigpressBindV2C1N256",
    refRun: resolve(BIND_V2_DIR, "runs/n256"),
  },
  "2x1024": {
    shape: "2x1024",
    perChild: 1024,
    verifier: getAddress("0xc6304db43e642c0bc43b55f13a3ebe21f336794f"),
    gate: getAddress("0x5648caea56baa011b6685ce091089b561621a661"),
    minLogRows: "20,16,18",
    label: "SigpressBindV2C1N1024",
    refRun: resolve(BIND_V2_DIR, "runs/n1024"),
  },
};

export function parseShape(s: string | undefined, fallback: Shape = "2x256"): Shape {
  const v = (s ?? fallback) as Shape;
  if (!SHAPES.includes(v)) throw new Error(`SHAPE must be one of ${SHAPES.join(", ")} (got ${s})`);
  return v;
}

type DeploymentsFile = Record<string, { verifier: Address; gate: Address; entry?: Address; hasher?: Address }>;
const deploymentsPath = () => (process.env.VALIDITY_DEPLOYMENTS ? resolve(process.env.VALIDITY_DEPLOYMENTS) : DEPLOYMENTS_FILE);
function readDeployments(): DeploymentsFile {
  const p = deploymentsPath();
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as DeploymentsFile) : {};
}

/** Verifier + gate (+ entry) for a shape on a chain: deployments-validity-v2.json `<chainId>:<shape>`, else Monad's. */
export function loadShape(shape: Shape, chainId = 10143): ShapeTarget {
  const base = MONAD[shape];
  const d = readDeployments()[`${chainId}:${shape}`];
  if (d) return { ...base, verifier: getAddress(d.verifier), gate: getAddress(d.gate), entry: d.entry && getAddress(d.entry) };
  if (chainId !== 10143) throw new Error(`no ${shape} validity deployment for chain ${chainId} in ${deploymentsPath()}`);
  return base;
}

export function saveShapeDeployment(chainId: number, shape: Shape, d: { verifier: Address; gate: Address; entry?: Address; hasher?: Address }) {
  const all = readDeployments();
  all[`${chainId}:${shape}`] = { ...all[`${chainId}:${shape}`], ...d };
  writeFileSync(deploymentsPath(), JSON.stringify(all, null, 2) + "\n");
}

// ---------------------------------------------------------------- ABIs

const PROOF = "(bytes transcript, bytes openings, uint256[8] applicationRoot, uint256[] sparkPoint, uint256 sparkValue, uint256[] liftPoint, uint256 liftValue, uint256 rootValue)";
export const verifierAbi = parseAbi([`function verifyC1V1(${PROOF} proof) view returns (bool)`]);
export const gateV2Abi = parseAbi([
  `function submit(${PROOF} proof, uint32 slot, (bytes32[] pubkeys, bytes32[] messages, bytes32 commitment) left, (bytes32[] pubkeys, bytes32[] messages, bytes32 commitment) right) returns (bytes32 commitment)`,
  "function accepted(bytes32 commitment) view returns (bool)",
  "function verifier() view returns (address)",
  "event BatchAccepted(bytes32 indexed commitment, uint32 slot, uint256 leftSigners, uint256 rightSigners)",
  "error NonCanonical()",
  "error BadLengths()",
  "error RootMismatch()",
  "error ProofRejected()",
  "error HasherFailed()",
  "error AlreadyAccepted()",
]);
export const validityEntryAbi = parseAbi([
  "struct Signers { bytes32[] pubkeys; bytes32[] messages; }",
  "struct Op { address account; uint256 nonce; address target; uint256 value; bytes data; uint8 side; uint32 index; }",
  "function gate() view returns (address)",
  "function keyOf(address account) view returns (bytes32)",
  "function nonceOf(address account) view returns (uint256)",
  "function opHash(address account, uint256 nonce, address target, uint256 value, bytes data) view returns (bytes32)",
  "function commitmentOf(uint32 slot, Signers left, Signers right) pure returns (bytes32)",
  "function createAccount(bytes32 pubkey, bytes32 salt) payable returns (address)",
  "function accountAddress(bytes32 pubkey, bytes32 salt) view returns (address)",
  "function registerKey(bytes32 pubkey)",
  "function execute(uint32 slot, Signers left, Signers right, Op[] ops) returns (bytes32)",
  "event AccountCreated(address indexed account, bytes32 pubkey, bytes32 salt)",
  "event OpExecuted(bytes32 indexed commitment, address indexed account, uint256 nonce, bool success)",
  "error ZeroKey()",
  "error KeyAlreadySet()",
  "error NotAccepted()",
  "error BadIndex()",
  "error NoKey()",
  "error NotAccount()",
  "error WrongPubkey()",
  "error WrongMessage()",
  "error BadNonce()",
  "error InsufficientGas()",
]);

// ---------------------------------------------------------------- statement and calldata

export interface Side {
  pubkeys: Hex[]; // gate encoding (big-endian limbs)
  messages: Hex[];
  commitment: Hex; // prover's D
}
export interface Statement {
  slot: number;
  const_words: number[];
  left: Side;
  right: Side;
  application_root: number[];
}

/** Same as SigpressBindV2Gate.batchCommitment / ValidityEntry.commitmentOf. */
export function batchCommitment(slot: number, left: Pick<Side, "pubkeys" | "messages">, right: Pick<Side, "pubkeys" | "messages">): Hex {
  return keccak256(encodeAbiParameters(parseAbiParameters("uint32, bytes32[], bytes32[], bytes32[], bytes32[]"), [slot, left.pubkeys, left.messages, right.pubkeys, right.messages]));
}

/** ValidityEntry.opHash: the 32-byte message an account's leanXMSS key signs for one op. */
export function validityOpHash(o: { chainId: number; entry: Address; account: Address; nonce: bigint; target: Address; value: bigint; data: Hex }): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("bytes32, uint256, address, address, uint256, address, uint256, bytes32"), [
      keccak256(new TextEncoder().encode("sigpress-validity-op-v1")),
      BigInt(o.chainId),
      o.entry,
      o.account,
      o.nonce,
      o.target,
      o.value,
      keccak256(o.data),
    ]),
  );
}

export type Mutation = "" | "swap-batches" | "wrong-message" | "wrong-signer" | "wrong-slot" | "wrong-commitment" | "tampered-proof";

/** gate.submit(proof, slot, left, right) calldata from the generator's verifyC1V1 calldata.bin + statement. */
export function submitCalldataV2(verifyCalldata: Hex, st: Statement, mutation: Mutation = ""): Hex {
  let vcd = verifyCalldata;
  if (mutation === "tampered-proof") {
    const b = hexToBytes(vcd);
    b[60_000]! ^= 0x01; // the spot the K10 and binding-v2 runs used: inside the proof's openings
    vcd = bytesToHex(b);
  }
  const { args } = decodeFunctionData({ abi: verifierAbi, data: vcd });
  let { slot, left, right } = st;
  if (mutation === "swap-batches") [left, right] = [right, left];
  if (mutation === "wrong-message") left = { ...left, messages: [`0x${"11".repeat(32)}`, ...left.messages.slice(1)] };
  if (mutation === "wrong-signer") left = { ...left, pubkeys: [flipLowBit(left.pubkeys[0]!), ...left.pubkeys.slice(1)] };
  if (mutation === "wrong-slot") slot += 1;
  if (mutation === "wrong-commitment") left = { ...left, commitment: flipLowBit(left.commitment) };
  return encodeFunctionData({ abi: gateV2Abi, functionName: "submit", args: [args[0], slot, left, right] });
}
const flipLowBit = (h: Hex): Hex => `0x${(BigInt(h) ^ 2n).toString(16).padStart(64, "0")}` as Hex; // bit 1: stays < p

// ---------------------------------------------------------------- SDK signing

export interface SdkSigner {
  key: LeanXmssKey;
  statePath: string;
}

/** Run `fn` over items with at most `limit` in flight. */
export async function pool<T, R>(items: T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!, i);
      }
    }),
  );
  return out;
}

/** Fresh SDK keys (random seeds), each with its own KeyStore state file under dir. Key files contain seeds. */
/** Keys `${prefix}-${k}` for k in [skip, count). */
export async function makeSdkKeys(dir: string, count: number, opts: { prefix: string; logSlots?: number; concurrency?: number; skip?: number }): Promise<{ signers: SdkSigner[]; keygenMs: number }> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let keygenMs = 0;
  const ks = [...Array(Math.max(0, count - (opts.skip ?? 0))).keys()].map((k) => k + (opts.skip ?? 0));
  const signers = await pool(ks, opts.concurrency ?? 8, async (k) => {
    const keyPath = resolve(dir, `${opts.prefix}-${k}.key.json`);
    const key = await leanxmssKeygenAsync(bytesToHex(randomBytes(32)), keyPath, { logSlots: opts.logSlots ?? 10 });
    keygenMs += key.keygenMs;
    const statePath = resolve(dir, `${opts.prefix}-${k}.state.json`);
    createLeanXmssKeyStore(statePath, key).close();
    return { key, statePath };
  });
  return { signers, keygenMs: Math.round(keygenMs) };
}

/** Each signer signs its own message at `slot` (KeyStore state persisted before each signature). */
export async function signAll(items: { signer: SdkSigner; message: Hex }[], slot: number, concurrency = 8): Promise<LeanXmssSignature[]> {
  return pool(items, concurrency, async ({ signer, message }) => {
    const ks = KeyStore.open(signer.statePath, { onWarn: () => {} });
    try {
      return await leanxmssSignAsync(signer.key, ks, message, { slot });
    } finally {
      ks.close();
    }
  });
}

/** Write the two per-signer batch files the binding-v2 prover reads. */
export function exportBatches(dir: string, left: LeanXmssSignature[], right: LeanXmssSignature[]): { left: string; right: string; bytes: [number, number] } {
  const l = resolve(dir, "batch-left.json");
  const r = resolve(dir, "batch-right.json");
  const el = leanxmssExportBatch(left, l, { perSigner: true });
  const er = leanxmssExportBatch(right, r, { perSigner: true });
  if (el.signers !== left.length || er.signers !== right.length) throw new Error("export-batch dropped signers");
  return { left: l, right: r, bytes: [el.bytes, er.bytes] };
}

// ---------------------------------------------------------------- proving

export interface ProofMeta {
  version: 2;
  shape: Shape;
  perChild: number;
  signatures: number;
  slot: number;
  commitment: Hex; // gate's accepted[] key
  distinctMessages: boolean;
  applicationRoot: string[];
  statementMatchesProver: boolean;
  source: "sdk" | "test-keys";
  proveSeconds?: number; // wall time of the prover process (lock wait excluded)
  leanvmProvingSeconds?: number;
  maxRssBytes?: number;
  terminalProofBytes?: number;
  verifyCalldataBytes: number;
  sdk?: { keygenMsTotal: number; signMsTotal: number; batchBytes: [number, number]; messages: string };
  createdAt: string;
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const sh = (cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) => {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, encoding: "utf8", maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.status}): ${r.stderr || r.stdout}`);
  return r.stdout;
};

/**
 * Prove 2 x perChild signers into outDir (report.json, native/, proving.log), holding the shared prover lock.
 * batches: the two per-signer batch files (SDK); without them the prover makes its own test keys and messages.
 * Async (the prover runs in a child process), so a service keeps serving HTTP meanwhile.
 */
export async function proveV2(opts: { outDir: string; target: ShapeTarget; batches?: { left: string; right: string }; slot?: number; log: (s: string) => void }): Promise<ProofMeta> {
  const { outDir, target, batches, log } = opts;
  if (!existsSync(PROVER_BIN)) throw new Error(`prover binary missing: ${PROVER_BIN} (see experiments/k10-terminal/binding-v2/README.md Commands)`);
  mkdirSync(outDir, { recursive: true });
  const env = [
    "LEANVM_PROVING_TIMEOUT_SECONDS=0",
    `LEANVM_TERMINAL_EXPORT=${q(resolve(outDir, "native"))}`,
    `SIGPRESS_MIN_LOG_ROWS=${target.minLogRows}`, // pin the child shape to the deployed verifier's
    ...(batches ? [`SIGPRESS_BATCH_LEFT=${q(batches.left)}`, `SIGPRESS_BATCH_RIGHT=${q(batches.right)}`] : []),
    ...(opts.slot !== undefined ? [`SIGPRESS_SLOT=${opts.slot}`] : []),
    ...(batches ? [] : [`SIGPRESS_MSG_LABEL=${q(`sigpress-validity-${Date.now()}`)}`]),
  ].join(" ");
  const cmd = `${env} /usr/bin/time -l ${q(PROVER_BIN)} ${target.perChild} ${q(resolve(outDir, "report.json"))} ${q(resolve(K10_DIR, "profiles/sigpress_c1.json"))}`;
  // Shared 16 GB machine: one prover at a time. The trap releases the lock on success, failure or Ctrl-C.
  const script = `until mkdir ${PROVER_LOCK} 2>/dev/null; do sleep 10; done; trap 'rmdir ${PROVER_LOCK} 2>/dev/null' EXIT INT TERM; echo locked; cd ${q(LEANVM_DIR)} && ${cmd} > ${q(resolve(outDir, "proving.log"))} 2>&1`;
  log(`waiting for prover lock ${PROVER_LOCK} ...`);
  const status = await new Promise<number | null>((res) => {
    const p = spawn("bash", ["-c", script], { stdio: ["ignore", "pipe", "inherit"] });
    p.stdout.on("data", (d: Buffer) => d.toString().includes("locked") && log(`lock held; proving 2 x ${target.perChild} (${outDir})`));
    p.on("close", res);
  });
  if (status !== 0) throw new Error(`prover failed (exit ${status}); see ${resolve(outDir, "proving.log")}`);
  const logTxt = readFileSync(resolve(outDir, "proving.log"), "utf8");
  const rss = /(\d+)\s+maximum resident set size/.exec(logTxt);
  const wall = /([\d.]+) real/.exec(logTxt);
  const meta = finishV2(outDir, target, batches ? "sdk" : "test-keys");
  if (wall) meta.proveSeconds = Math.round(Number(wall[1]) * 10) / 10;
  if (rss) meta.maxRssBytes = Number(rss[1]);
  writeMeta(outDir, meta);
  return meta;
}

function writeMeta(dir: string, meta: ProofMeta) {
  writeFileSync(resolve(dir, "validity-proof.json"), JSON.stringify(meta, null, 2) + "\n");
}

export function readProof(dir: string): { meta: ProofMeta; statement: Statement; verifyCalldata: Hex } {
  const meta = JSON.parse(readFileSync(resolve(dir, "validity-proof.json"), "utf8")) as ProofMeta;
  if (meta.version !== 2) throw new Error(`${dir} is not a binding-v2 proof (run pnpm validity again)`);
  const statement = JSON.parse(readFileSync(resolve(dir, "statement.json"), "utf8")) as Statement;
  return { meta, statement, verifyCalldata: bytesToHex(new Uint8Array(readFileSync(resolve(dir, "calldata.bin")))) };
}

/**
 * From a run dir with report.json + native/root-fixture.json: recompute the gate statement off chain
 * (binding-v2/tools/statement.py: D, r, v, child digests, application root must all match the prover) and generate the
 * verifyC1V1 calldata with the sol-whir-p3 generator (unique label; generated files removed afterwards).
 */
export function finishV2(runDir: string, target: ShapeTarget, source: ProofMeta["source"]): ProofMeta {
  const chk = JSON.parse(sh("python3", ["-I", resolve(BIND_V2_DIR, "tools/statement.py"), runDir, "--export"]));
  if (!chk.statement_matches_prover) throw new Error("statement recomputed off chain does not match the prover");
  const st = JSON.parse(readFileSync(resolve(runDir, "statement.json"), "utf8")) as Statement;
  const ref = JSON.parse(readFileSync(resolve(target.refRun, "statement.json"), "utf8")) as Statement;
  if (JSON.stringify(st.const_words) !== JSON.stringify(ref.const_words)) throw new Error("program constants differ from the deployed gate's");
  if (!existsSync(resolve(runDir, "calldata.bin"))) {
    const label = `SigpressV2Val${Date.now()}`;
    sh("python3", ["script/generate_leanvm_two_commitment_terminal_fixture.py", resolve(runDir, "native/root-fixture.json"), label], {
      cwd: SOL_DIR,
      env: { SIGPRESS_NO_PROVENANCE: "1", PYTHONPATH: resolve(K10_DIR, "tools") },
    });
    const contract = `LeanVmTwoCommitmentTerminal_${label}`;
    const data = resolve(SOL_DIR, "testdata/leanvm_terminal", label);
    copyFileSync(resolve(data, "calldata.bin"), resolve(runDir, "calldata.bin"));
    copyFileSync(resolve(data, "manifest.json"), resolve(runDir, "solidity-manifest.json"));
    for (const p of [data, resolve(SOL_DIR, "src/leanvm/generated", `${contract}.sol`), resolve(SOL_DIR, "test", `${contract}.t.sol`), resolve(SOL_DIR, "script", `${contract}.s.sol`)])
      rmSync(p, { recursive: true, force: true });
  }
  const report = JSON.parse(readFileSync(resolve(runDir, "report.json"), "utf8"));
  const fixture = JSON.parse(readFileSync(resolve(runDir, "native/root-fixture.json"), "utf8"));
  const prev = existsSync(resolve(runDir, "validity-proof.json")) ? (JSON.parse(readFileSync(resolve(runDir, "validity-proof.json"), "utf8")) as Partial<ProofMeta>) : {};
  const perChild = Number(report.applications?.[0]?.signers);
  if (perChild !== target.perChild || st.left.pubkeys.length !== perChild || st.right.pubkeys.length !== perChild) throw new Error(`proof is 2 x ${perChild}, verifier is ${target.shape}`);
  const msgs = [...st.left.messages, ...st.right.messages].map((m) => m.toLowerCase());
  const meta: ProofMeta = {
    ...prev,
    version: 2,
    shape: target.shape,
    perChild,
    signatures: 2 * perChild,
    slot: st.slot,
    commitment: batchCommitment(st.slot, st.left, st.right),
    distinctMessages: new Set(msgs).size === msgs.length,
    applicationRoot: st.application_root.map(String),
    statementMatchesProver: true,
    source: prev.source ?? source,
    leanvmProvingSeconds: report.total_leanvm_proving_ms ? Math.round(report.total_leanvm_proving_ms / 100) / 10 : prev.leanvmProvingSeconds,
    terminalProofBytes: Number(fixture.proof_bytes) || prev.terminalProofBytes,
    verifyCalldataBytes: statSync(resolve(runDir, "calldata.bin")).size,
    createdAt: prev.createdAt ?? new Date().toISOString(),
  };
  writeMeta(runDir, meta);
  return meta;
}

/** Latest saved v2 proof for a shape (optionally only ones not yet accepted, via the isFresh check). */
export async function latestProofDir(shape: Shape, isFresh?: (meta: ProofMeta) => Promise<boolean>): Promise<string | undefined> {
  if (!existsSync(VALIDITY_OUT)) return undefined;
  const dirs = readdirSync(VALIDITY_OUT)
    .map((d) => resolve(VALIDITY_OUT, d))
    .filter((d) => ["validity-proof.json", "calldata.bin", "statement.json"].every((f) => existsSync(resolve(d, f))))
    .sort()
    .reverse();
  for (const d of dirs) {
    const meta = JSON.parse(readFileSync(resolve(d, "validity-proof.json"), "utf8")) as ProofMeta;
    if (meta.version !== 2 || meta.shape !== shape) continue;
    if (!isFresh || (await isFresh(meta))) return d;
  }
  return undefined;
}

// ---------------------------------------------------------------- chain

type Clients = Awaited<ReturnType<typeof getClients>>;

/** Gas limit = estimate + 5% (Monad charges the limit). Retries the estimate on RPC rate limits. */
export async function send(c: Clients, to: Address | undefined, data: Hex, value?: bigint) {
  let est: bigint | undefined;
  for (let i = 0; ; i++) {
    try {
      est = await c.publicClient.estimateGas({ account: c.account, to, data, value });
      break;
    } catch (e) {
      if (i >= 5 || !/429|rate limit/i.test(String((e as Error).message))) throw e;
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
  const gas = (est * 105n) / 100n;
  const hash = await c.walletClient.sendTransaction({ account: c.account, chain: c.chain, to, data, gas, value });
  const receipt = await c.publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== "success") throw new Error(`tx ${hash} reverted`);
  return { hash, est, gas, receipt };
}

const ERROR_ABIS = [...gateV2Abi, ...validityEntryAbi].filter((x) => x.type === "error");

/**
 * eth_call over raw JSON-RPC: Monad's RPC puts revert data only in the raw error object, so read it there and
 * decode it (gate / entry custom errors, or Error(string) from the verifier, e.g. MERKLE_ROOT).
 */
export async function rawCall(rpc: string, from: Address, to: Address, data: Hex): Promise<{ reverted: boolean; reason: string; data?: Hex }> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ from, to, data, gas: "0x1c9c380" }, "latest"] });
  for (let i = 0; ; i++) {
    let r: Response;
    let text: string;
    try {
      r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body });
      text = await r.text();
    } catch (e) {
      if (i >= 6) throw e; // public RPC drops connections (ECONNRESET) under load: retry
      await new Promise((res) => setTimeout(res, 5000));
      continue;
    }
    if ((r.status === 429 || /rate limit/i.test(text)) && i < 6) {
      await new Promise((res) => setTimeout(res, 5000));
      continue;
    }
    const j = JSON.parse(text) as { result?: Hex; error?: { message?: string; data?: Hex | { data?: Hex } } };
    if (!j.error) return { reverted: false, reason: "ok", data: j.result };
    const d = (typeof j.error.data === "string" ? j.error.data : j.error.data?.data) as Hex | undefined;
    return { reverted: true, reason: decodeRevert(d) ?? j.error.message ?? "reverted", data: d };
  }
}

export function decodeRevert(d: Hex | undefined): string | undefined {
  if (!d || d === "0x") return undefined;
  if (d.startsWith("0x08c379a0")) {
    try {
      return decodeErrorResult({ abi: parseAbi(["error Error(string)"]), data: d }).args[0] as string;
    } catch {
      return d;
    }
  }
  try {
    return decodeErrorResult({ abi: ERROR_ABIS, data: d }).errorName;
  } catch {
    return d.slice(0, 10);
  }
}

export interface NegativeCheck {
  name: Mutation | "replay";
  reverted: boolean;
  reason: string;
}

export interface ValidityResult {
  txHash: Hash;
  gasEstimate: number;
  gasCharged: number;
  calldataBytes: number;
  signatures: number;
  perChild: number;
  gasPerSig: number;
  bytesPerSig: number;
  proveSeconds?: number;
  leanvmProvingSeconds?: number;
  maxRssBytes?: number;
  proofBytes?: number;
  verifyCalldataBytes: number;
  gate: Address;
  verifier: Address;
  shape: Shape;
  slot: number;
  commitment: Hex;
  distinctMessages: boolean;
  source: ProofMeta["source"];
  accepted: boolean;
  negatives: NegativeCheck[];
  provedAt: string;
  at: string;
  notBound: string[];
}

export const NOT_BOUND = [
  "account <-> pubkey: the gate binds pubkeys and messages, not Ethereum accounts (ValidityEntry adds a self-set account -> pubkey registry)",
  "one verifier per batch shape (2 x 256, 2 x 1024); smaller batches are padded with filler signers",
  "the polynomial-binding soundness argument (Schwartz-Zippel over F_p^5, keccak challenge) is ours and not externally reviewed",
  "one slot per proof, exactly two batches; KoalaBear/Poseidon leanXMSS keys, not our WOTS.sol accounts",
  "security = the leanVM authors' 100-bit component targets; full-chain composition not analysed",
];

export const PRE_NEGATIVES: Mutation[] = ["tampered-proof", "wrong-message", "wrong-signer", "swap-batches", "wrong-slot"];

/**
 * Submit a v2 proof dir to its gate. Before sending: eth_call the verifier (must return true), eth_call the
 * unmodified submit (must not revert) and each negative mutation (must revert). After: eth_call the same submit
 * again (must revert AlreadyAccepted) and read accepted(commitment).
 */
export async function submitProofV2(c: Clients, proofDir: string, target: ShapeTarget, log: (s: string) => void, opts: { negatives?: Mutation[] } = {}): Promise<ValidityResult> {
  const { meta, statement, verifyCalldata } = readProof(proofDir);
  if (meta.shape !== target.shape) throw new Error(`proof is ${meta.shape}, target ${target.shape}`);
  const { publicClient, account, rpc } = c;
  const ok = await rawCall(rpc, account.address, target.verifier, verifyCalldata);
  if (ok.reverted || !ok.data || BigInt(ok.data) !== 1n) throw new Error(`verifier ${target.verifier} rejects this proof (${ok.reason})`);
  log(`eth_call verifyC1V1 on the ${target.shape} verifier ${target.verifier}: true`);
  if (await publicClient.readContract({ address: target.gate, abi: gateV2Abi, functionName: "accepted", args: [meta.commitment] }))
    throw new Error(`gate ${target.gate} already accepted this batch (${meta.commitment}); prove a fresh one`);
  const data = submitCalldataV2(verifyCalldata, statement);
  const pre = await rawCall(rpc, account.address, target.gate, data);
  if (pre.reverted) throw new Error(`gate.submit eth_call reverts (${pre.reason}); not sending`);
  const negatives: NegativeCheck[] = [];
  for (const m of opts.negatives ?? PRE_NEGATIVES) {
    const r = await rawCall(rpc, account.address, target.gate, submitCalldataV2(verifyCalldata, statement, m));
    negatives.push({ name: m, reverted: r.reverted, reason: r.reason });
    log(`eth_call submit with ${m}: ${r.reverted ? `reverts ${r.reason}` : "DID NOT REVERT"}`);
    if (!r.reverted) throw new Error(`${m} was accepted by eth_call; refusing to continue`);
  }
  const r = await send(c, target.gate, data);
  const replay = await rawCall(rpc, account.address, target.gate, data);
  negatives.push({ name: "replay", reverted: replay.reverted, reason: replay.reason });
  log(`eth_call the same submit again: ${replay.reverted ? `reverts ${replay.reason}` : "DID NOT REVERT"}`);
  const accepted = await publicClient.readContract({ address: target.gate, abi: gateV2Abi, functionName: "accepted", args: [meta.commitment] });
  const calldataBytes = hexToBytes((await publicClient.getTransaction({ hash: r.hash })).input).length;
  const gasCharged = Number(r.receipt.gasUsed);
  return {
    txHash: r.hash,
    gasEstimate: Number(r.est),
    gasCharged,
    calldataBytes,
    signatures: meta.signatures,
    perChild: meta.perChild,
    gasPerSig: Math.round(gasCharged / meta.signatures),
    bytesPerSig: Math.round((calldataBytes / meta.signatures) * 10) / 10,
    proveSeconds: meta.proveSeconds,
    leanvmProvingSeconds: meta.leanvmProvingSeconds,
    maxRssBytes: meta.maxRssBytes,
    proofBytes: meta.terminalProofBytes,
    verifyCalldataBytes: meta.verifyCalldataBytes,
    gate: target.gate,
    verifier: target.verifier,
    shape: target.shape,
    slot: meta.slot,
    commitment: meta.commitment,
    distinctMessages: meta.distinctMessages,
    source: meta.source,
    accepted,
    negatives,
    provedAt: meta.createdAt,
    at: new Date().toISOString(),
    notBound: NOT_BOUND,
  };
}

/** Gate-encoded pubkey of an SDK signature (what the statement / registry hold). */
export const gatePubkeyOf = (s: Pick<LeanXmssSignature, "publicKey">) => leanxmssGatePubkey(s.publicKey);
export { leanxmssVerify };
