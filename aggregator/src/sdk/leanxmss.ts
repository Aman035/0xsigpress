// leanXMSS signer for validity proofs: a thin wrapper over the Rust CLI in experiments/k11-leanxmss/signer.
//
// Scheme: leanXMSS over KoalaBear with Poseidon1, exactly the `xmss` crate of Client-Side-Proving/leanVM
// `recursive-verifier` @ fb0909d (Apache-2.0). This is the scheme the leanVM aggregation program (and so the K10
// terminal STARK chain) verifies. It is NOT the Keccak WOTS/XMSS of xmss.ts / XMSS.sol: different hash, field,
// encoding and key format. A key from one scheme can't sign for the other.
//
//   public key  32 B (SSZ: Merkle root 4 FE + public parameter 4 FE, KoalaBear little-endian u32s)
//   signature   1,208 B (SSZ: 42 chain tips, 6 FE randomness, 32-level Merkle path)
//   a key signs 2^logSlots slots starting at activationSlot; the tree itself always has 2^32 leaves
//
// State: the same KeyStore (keystore.ts) as XMSS. root = the 32-byte public key, height = logSlots, keystore index i
// = slot activationSlot + i. sign() persists nextIndex = i + 1 (KeyStore.reserveIndex) BEFORE the CLI computes the
// signature; the CLI re-checks that our process holds the state lock and that i was the index just reserved, and
// keeps its own last-(index, message) ledger next to the state file.
//
// Binary: env SIGPRESS_LEANXMSS_BIN, default <repo>/experiments/k11-leanxmss/signer/target/release/sigpress-leanxmss
// (build: cd experiments/k11-leanxmss/signer && cargo build --release -j 4; needs experiments/k10-terminal/vendor).
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hex } from "viem";
import { KeyStore, type KeyStoreOptions } from "./keystore.ts";

export const LEANXMSS_SCHEME = "leanxmss-koalabear-poseidon1/leanVM-recursive-verifier-fb0909d";
export const LEANXMSS_PK_BYTES = 32;
export const LEANXMSS_SIG_BYTES = 1208;
export const LEANXMSS_MAX_LOG_SLOTS = 24;

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_LEANXMSS_BIN = resolve(here, "../../../experiments/k11-leanxmss/signer/target/release/sigpress-leanxmss");

export function leanxmssBin(): string {
  return process.env.SIGPRESS_LEANXMSS_BIN || DEFAULT_LEANXMSS_BIN;
}

export class LeanXmssCliError extends Error {
  constructor(
    msg: string,
    readonly status: number | null,
  ) {
    super(msg);
    this.name = "LeanXmssCliError";
  }
}

/** Run the CLI; return parsed stdout JSON. `okStatuses` lists exit codes that still carry a JSON answer. */
function cli<T>(args: string[], okStatuses: number[] = [0]): { status: number; out: T } {
  try {
    const stdout = execFileSync(leanxmssBin(), args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 });
    return { status: 0, out: JSON.parse(stdout) as T };
  } catch (e) {
    const err = e as { status?: number | null; stdout?: string; stderr?: string; code?: string };
    if (err.code === "ENOENT") throw new LeanXmssCliError(`leanXMSS CLI not found at ${leanxmssBin()} (set SIGPRESS_LEANXMSS_BIN)`, null);
    if (typeof err.status === "number" && okStatuses.includes(err.status) && err.stdout) {
      return { status: err.status, out: JSON.parse(err.stdout) as T };
    }
    throw new LeanXmssCliError((err.stderr ?? String(e)).trim(), err.status ?? null);
  }
}

export interface LeanXmssKey {
  /** Path of the key file. It contains the secret seed (mode 0600). */
  keyPath: string;
  publicKey: Hex;
  activationSlot: number;
  logSlots: number;
}

export interface LeanXmssSignature {
  scheme: string;
  publicKey: Hex;
  slot: number;
  /** KeyStore index = slot - activationSlot. */
  index: number;
  message: Hex;
  signature: Hex;
}

/** Deterministic keygen from a 32-byte secret seed. Refuses to overwrite an existing key file. */
export function leanxmssKeygen(
  seed: Hex,
  keyPath: string,
  opts: { logSlots?: number; activationSlot?: number } = {},
): LeanXmssKey & { keygenMs: number } {
  const logSlots = opts.logSlots ?? 10;
  const activationSlot = opts.activationSlot ?? 0;
  const { out } = cli<{ publicKey: Hex; keygenMs: number }>([
    "keygen",
    "--seed",
    seed,
    "--out",
    keyPath,
    "--log-slots",
    String(logSlots),
    "--activation-slot",
    String(activationSlot),
  ]);
  return { keyPath, publicKey: out.publicKey, activationSlot, logSlots, keygenMs: out.keygenMs };
}

/** Read the public part of an existing key file. */
export function leanxmssLoadKey(keyPath: string): LeanXmssKey {
  const { out } = cli<{ publicKey: Hex; activationSlot: number; logSlots: number; scheme: string }>(["pubkey", "--key", keyPath]);
  if (out.scheme !== LEANXMSS_SCHEME) throw new Error(`${keyPath}: unexpected scheme ${out.scheme}`);
  return { keyPath, publicKey: out.publicKey, activationSlot: out.activationSlot, logSlots: out.logSlots };
}

/** Fresh KeyStore state for a leanXMSS key (root = public key, height = logSlots). */
export function createLeanXmssKeyStore(statePath: string, key: LeanXmssKey, opts: KeyStoreOptions = {}): KeyStore {
  return KeyStore.create(statePath, { root: key.publicKey, height: key.logSlots }, opts);
}

/**
 * Stateful sign of a 32-byte message. Without `slot`: the next unused slot. With `slot`: that slot, burning any
 * unused slots before it (each burn is a durable state write); refuses a slot at or below one already used.
 * Every all-signers-same-(message, slot) batch needs the same slot from every signer, so an aggregator picks it.
 * `final` allows the KeyStore's reserved last leaf (for a migration op).
 */
export function leanxmssSign(key: LeanXmssKey, ks: KeyStore, m: Hex, opts: { slot?: number; final?: boolean } = {}): LeanXmssSignature {
  if (ks.root.toLowerCase() !== key.publicKey.toLowerCase() || ks.height !== key.logSlots) {
    throw new Error("key does not match this key state (root/height)");
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(m)) throw new Error("message must be 32 bytes hex");
  let target: number | undefined;
  if (opts.slot !== undefined) {
    target = opts.slot - key.activationSlot;
    if (!Number.isInteger(target) || target < 0 || target >= ks.capacity) throw new Error(`slot ${opts.slot} outside this key's range`);
    if (target < ks.nextIndex) throw new Error(`slot ${opts.slot} already used or skipped (next free slot ${key.activationSlot + ks.nextIndex})`);
    while (ks.nextIndex < target) ks.reserveIndex({ final: opts.final }); // burn the gap
  }
  const i = ks.reserveIndex({ final: opts.final }); // persisted BEFORE any signature exists
  if (target !== undefined && i !== target) throw new Error("internal: reserved index does not match the requested slot");
  const { out } = cli<LeanXmssSignature>([
    "sign",
    "--key",
    key.keyPath,
    "--state",
    ks.path,
    "--index",
    String(i),
    "--msg",
    m,
    "--reserved",
  ]);
  return out;
}

export function leanxmssVerify(publicKey: Hex, slot: number, m: Hex, signature: Hex): boolean {
  const { out } = cli<{ valid: boolean }>(
    ["verify", "--pubkey", publicKey, "--slot", String(slot), "--msg", m, "--sig", signature],
    [1],
  );
  return out.valid === true;
}

/**
 * Write a batch file for the provers: every signature must be over the same (message, slot). The CLI verifies each
 * one, rejects duplicate signers and sorts by public key.
 */
export function leanxmssExportBatch(
  sigs: LeanXmssSignature[],
  outPath: string,
): { signers: number; message: Hex; slot: number; bytes: number } {
  if (sigs.length === 0) throw new Error("empty batch");
  const { message, slot } = sigs[0]!;
  const dir = mkdtempSync(join(tmpdir(), "sigpress-lx-batch-"));
  try {
    const args = ["export-batch", "--msg", message, "--slot", String(slot), "--out", outPath];
    sigs.forEach((s, k) => {
      const p = join(dir, `sig${k}.json`);
      writeFileSync(p, JSON.stringify(s));
      args.push("--sig", p);
    });
    return cli<{ signers: number; message: Hex; slot: number; bytes: number }>(args).out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface ProveBatchReport {
  accepted: boolean;
  mode: "k10-direct-profile" | "leanvm-default-aggregate";
  signers: number;
  distinctSigners: number;
  proveMs: number;
  verifyMs: number;
  proofBytes?: number;
  publicInput?: number[];
  aggregateBytesWithoutPubkeys?: number;
}

/**
 * Prove a batch with the vendored leanVM aggregation program and verify the proof natively (research helper).
 * Heavy (hundreds of MB to GBs of RAM): callers on a shared machine must serialize prover runs.
 * `profile`: a K10 profile JSON (its `direct` WHIR profile is used, as in the K10 chain).
 * Throws LeanXmssCliError if the program rejects the batch (no proof can be produced).
 */
export function leanxmssProveBatch(batchPath: string, opts: { profile?: string; noPrecheck?: boolean } = {}): ProveBatchReport {
  const args = ["prove-batch", "--batch", batchPath];
  if (opts.profile) args.push("--profile", opts.profile);
  if (opts.noPrecheck) args.push("--no-precheck");
  return cli<ProveBatchReport>(args).out;
}
