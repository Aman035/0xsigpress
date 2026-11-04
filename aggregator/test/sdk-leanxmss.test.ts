import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, toBytes, type Hex } from "viem";
import {
  createLeanXmssKeyStore,
  LEANXMSS_PK_BYTES,
  LEANXMSS_SIG_BYTES,
  leanxmssBin,
  leanxmssExportBatch,
  leanxmssKeygen,
  leanxmssLoadKey,
  leanxmssProveBatch,
  leanxmssSign,
  leanxmssVerify,
  LeanXmssCliError,
} from "../src/sdk/leanxmss.ts";
import { KeyStore } from "../src/sdk/keystore.ts";

const here = dirname(fileURLToPath(import.meta.url));
const profile = resolve(here, "../../experiments/k10-terminal/profiles/sigpress_c1.json");
const haveBin = existsSync(leanxmssBin());
const skip = haveBin ? false : `leanXMSS CLI not built (${leanxmssBin()})`;
const tmp = () => mkdtempSync(join(tmpdir(), "sigpress-lx-"));
const quiet = { onWarn: () => {} };
const seedOf = (s: string): Hex => keccak256(toBytes(s));
const onDisk = (p: string): number => (JSON.parse(readFileSync(p, "utf8")) as { nextIndex: number }).nextIndex;
const bytesOf = (h: Hex): number => (h.length - 2) / 2;

// Shared 16 GB machine: one prover at a time (mkdir lock, released on failure).
const PROVER_LOCK = process.env.SIGPRESS_PROVER_LOCK ?? "/private/tmp/claude-501/sigpress-prover.lock";
async function withProverLock<T>(fn: () => T): Promise<T> {
  for (;;) {
    try {
      mkdirSync(PROVER_LOCK);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
  try {
    return fn();
  } finally {
    rmdirSync(PROVER_LOCK);
  }
}

test("leanxmss: keygen is deterministic, sign/verify round trip, index on disk before each signature", { skip }, () => {
  const dir = tmp();
  const key = leanxmssKeygen(seedOf("lx-1"), join(dir, "k.json"), { logSlots: 4 });
  const again = leanxmssKeygen(seedOf("lx-1"), join(dir, "k2.json"), { logSlots: 4 });
  assert.equal(key.publicKey, again.publicKey);
  assert.equal(bytesOf(key.publicKey), LEANXMSS_PK_BYTES);
  assert.deepEqual(leanxmssLoadKey(key.keyPath), { keyPath: key.keyPath, publicKey: key.publicKey, activationSlot: 0, logSlots: 4 });
  // The key file holds the seed; the state file must not.
  assert.equal(readFileSync(key.keyPath, "utf8").includes(seedOf("lx-1").slice(2)), true);
  const statePath = join(dir, "state.json");
  const ks = createLeanXmssKeyStore(statePath, key, quiet);
  for (let i = 0; i < 3; i++) {
    const m = seedOf(`msg-${i}`);
    const s = leanxmssSign(key, ks, m);
    assert.equal(s.index, i);
    assert.equal(s.slot, i);
    assert.equal(onDisk(statePath), i + 1);
    assert.equal(bytesOf(s.signature), LEANXMSS_SIG_BYTES);
    assert.equal(leanxmssVerify(key.publicKey, s.slot, m, s.signature), true);
    assert.equal(leanxmssVerify(key.publicKey, s.slot, seedOf("other"), s.signature), false, "wrong message");
    assert.equal(leanxmssVerify(key.publicKey, s.slot + 1, m, s.signature), false, "wrong slot");
    assert.equal(leanxmssVerify(again.publicKey.replace(/.$/, (c) => (c === "0" ? "1" : "0")) as Hex, s.slot, m, s.signature), false, "wrong key");
  }
  assert.equal(readFileSync(statePath, "utf8").includes(seedOf("lx-1").slice(2)), false);
  ks.close();
  rmSync(dir, { recursive: true });
});

test("leanxmss: refuses slot reuse (TS and CLI), burns skipped slots, CLI --reserved needs our lock", { skip }, () => {
  const dir = tmp();
  const key = leanxmssKeygen(seedOf("lx-2"), join(dir, "k.json"), { logSlots: 4 });
  const statePath = join(dir, "state.json");
  const ks = createLeanXmssKeyStore(statePath, key, quiet);
  const m = seedOf("m");
  const s5 = leanxmssSign(key, ks, m, { slot: 5 });
  assert.equal(s5.slot, 5);
  assert.equal(onDisk(statePath), 6, "slots 0-4 burned, 5 used");
  assert.throws(() => leanxmssSign(key, ks, seedOf("m2"), { slot: 5 }), /already used/);
  assert.throws(() => leanxmssSign(key, ks, m, { slot: 3 }), /already used/);
  const bin = leanxmssBin();
  const run = (args: string[]) => execFileSync(bin, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  // Standalone CLI sign while our process holds the lock: refused.
  assert.throws(() => run(["sign", "--key", key.keyPath, "--state", statePath, "--index", "9", "--msg", m]), /locked by running process/);
  // --reserved for an index we did not just reserve: refused.
  assert.throws(() => run(["sign", "--key", key.keyPath, "--state", statePath, "--index", "9", "--msg", m, "--reserved"]), /not the one just reserved|must hold/);
  // execFileSync's child is ours, so the lock check passes; same index, different message: the ledger refuses.
  assert.throws(() => run(["sign", "--key", key.keyPath, "--state", statePath, "--index", "5", "--msg", seedOf("m3"), "--reserved"]), /would reuse a one-time key/);
  ks.close();
  // Lock released: standalone CLI works, but still refuses old indices.
  assert.throws(() => run(["sign", "--key", key.keyPath, "--state", statePath, "--index", "5", "--msg", seedOf("m4")]), /already used/);
  const s7 = JSON.parse(run(["sign", "--key", key.keyPath, "--state", statePath, "--index", "7", "--msg", m])) as { slot: number; signature: Hex };
  assert.equal(s7.slot, 7);
  assert.equal(onDisk(statePath), 8);
  assert.equal(leanxmssVerify(key.publicKey, 7, m, s7.signature), true);
  // The TS keystore picks up the CLI's state.
  const ks2 = KeyStore.open(statePath, quiet);
  assert.equal(ks2.nextIndex, 8);
  assert.equal(leanxmssSign(key, ks2, m).slot, 8);
  ks2.close();
  rmSync(dir, { recursive: true });
});

test("leanxmss: exported batch is accepted by the vendored leanVM aggregation prover/verifier", { skip }, async () => {
  const dir = tmp();
  const batchRoot = seedOf("sigpress-k11-batch");
  const slot = 7;
  const sigs = [0, 1, 2, 3].map((k) => {
    const key = leanxmssKeygen(seedOf(`lx-batch-${k}`), join(dir, `k${k}.json`), { logSlots: 4 });
    const ks = createLeanXmssKeyStore(join(dir, `s${k}.json`), key, quiet);
    const s = leanxmssSign(key, ks, batchRoot, { slot });
    ks.close();
    return s;
  });
  const batchPath = join(dir, "batch.json");
  const info = leanxmssExportBatch(sigs, batchPath);
  assert.equal(info.signers, 4);
  assert.equal(info.slot, slot);
  // Mixed (message, slot) is refused at export.
  assert.throws(() => leanxmssExportBatch([...sigs.slice(0, 3), { ...sigs[3]!, slot: 8 }], join(dir, "bad.json")), /different \(message, slot\)/);
  // A tampered signature, with the native pre-check off, must make the leanVM program itself fail.
  const tampered = JSON.parse(readFileSync(batchPath, "utf8")) as { signers: { signature: string }[] };
  const b = tampered.signers[1]!.signature;
  tampered.signers[1]!.signature = b.slice(0, 2) + (b[2] === "0" ? "1" : "0") + b.slice(3);
  const tamperedPath = join(dir, "tampered.json");
  writeFileSync(tamperedPath, JSON.stringify(tampered));

  const opts = existsSync(profile) ? { profile } : {};
  const [report, rejected] = await withProverLock(() => {
    const r = leanxmssProveBatch(batchPath, opts);
    let err: unknown;
    try {
      leanxmssProveBatch(tamperedPath, { ...opts, noPrecheck: true });
    } catch (e) {
      err = e;
    }
    return [r, err] as const;
  });
  assert.equal(report.accepted, true);
  assert.equal(report.distinctSigners, 4);
  assert.ok(rejected instanceof LeanXmssCliError, "tampered batch must not prove");
  rmSync(dir, { recursive: true });
});
