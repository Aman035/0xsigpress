import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, toBytes } from "viem";
import { KeyExhaustedError, KeyStore, KeyStoreLockedError } from "../src/sdk/keystore.ts";
import { xmssKeygen, xmssVerify } from "../src/sdk/xmss.ts";

const here = dirname(fileURLToPath(import.meta.url));
const seed = keccak256(toBytes("keystore-test"));
const m = keccak256(toBytes("m"));
const tmp = () => mkdtempSync(join(tmpdir(), "sigpress-ks-"));
const onDisk = (p: string): number => (JSON.parse(readFileSync(p, "utf8")) as { nextIndex: number }).nextIndex;
const quiet = { onWarn: () => {} };

test("keystore: index persisted on disk before each signature, no secrets in the file", () => {
  const dir = tmp();
  const key = xmssKeygen(seed, 4);
  const p = join(dir, "key.json");
  const ks = KeyStore.create(p, key, quiet);
  for (let i = 0; i < 5; i++) {
    const s = ks.sign(key, m);
    assert.equal(s.leafIndex, i);
    assert.equal(onDisk(p), i + 1);
    assert.equal(xmssVerify(key, m, s), true);
  }
  const raw = readFileSync(p, "utf8");
  assert.ok(!raw.includes(key.wotsSeed.slice(2)) && !raw.includes(seed.slice(2)));
  ks.close();
  rmSync(dir, { recursive: true });
});

test("keystore: crash while signing (after persist) burns the leaf, never reuses it", () => {
  const dir = tmp();
  const key = xmssKeygen(seed, 4);
  const p = join(dir, "key.json");
  let ks = KeyStore.create(p, key, quiet);
  ks.sign(key, m); // leaf 0
  let seen = -1;
  assert.throws(
    () =>
      ks.sign(key, (i) => {
        // The message builder runs after the index is reserved: the state on disk must already be past it.
        seen = i;
        assert.equal(onDisk(p), i + 1);
        throw new Error("simulated crash before the signature exists");
      }),
    /simulated crash/,
  );
  assert.equal(seen, 1);
  ks.close();
  ks = KeyStore.open(p, quiet);
  assert.equal(ks.sign(key, m).leafIndex, 2); // leaf 1 is burned
  ks.close();
  rmSync(dir, { recursive: true });
});

test("keystore: SIGKILL during a signing loop, restart, no index reuse (3 rounds)", async () => {
  const dir = tmp();
  const height = 6;
  const key = xmssKeygen(seed, height);
  const p = join(dir, "key.json");
  KeyStore.create(p, key, quiet).close();
  const released = new Set<number>();
  const child = resolve(here, "fixtures/keystore-child.ts");
  for (let round = 0; round < 3; round++) {
    const got = await new Promise<number[]>((done, fail) => {
      const proc = spawn(process.execPath, ["--import", "tsx", child, p, seed, String(height)], { cwd: resolve(here, ".."), stdio: ["ignore", "pipe", "pipe"] });
      const out: number[] = [];
      let buf = "";
      let err = "";
      let ready = false;
      const target = 2 + round * 3; // kill after a few released signatures, at a varying point
      proc.stdout.on("data", (d: Buffer) => {
        buf += d.toString();
        const lines = buf.split("\n");
        buf = lines.pop()!;
        for (const l of lines) {
          if (l === "ready") ready = true;
          else if (l) out.push(Number(l));
        }
        if (ready && out.length >= target) proc.kill("SIGKILL");
      });
      proc.stderr.on("data", (d: Buffer) => (err += d.toString()));
      proc.on("exit", (code, sig) => (sig === "SIGKILL" ? done(out) : fail(new Error(`child exited ${code}: ${err}`))));
    });
    assert.ok(got.length >= 2 + round * 3);
    for (const i of got) {
      assert.ok(!released.has(i), `index ${i} released twice`);
      released.add(i);
    }
    // Every released index is below the persisted nextIndex, and the stale lock is still there.
    assert.ok(Math.max(...released) < onDisk(p), `released ${Math.max(...released)} >= persisted ${onDisk(p)}`);
    assert.ok(existsSync(`${p}.lock`));
  }
  // Restart in this process: takes over the stale lock and continues past every released index.
  const ks = KeyStore.open(p, quiet);
  const s = ks.sign(key, m);
  assert.ok(s.leafIndex > Math.max(...released));
  assert.ok(!released.has(s.leafIndex));
  ks.close();
  rmSync(dir, { recursive: true });
});

test("keystore: refuses when exhausted, keeps a reserved leaf for migration, warns near the end", () => {
  const dir = tmp();
  const key = xmssKeygen(seed, 2); // 4 leaves
  const p = join(dir, "key.json");
  const warnings: number[] = [];
  const ks = KeyStore.create(p, key, { warnAt: 2, onWarn: (r) => warnings.push(r) });
  ks.sign(key, m);
  ks.sign(key, m);
  ks.sign(key, m); // 1 left: the reserved one
  assert.deepEqual(warnings, [2, 1]);
  assert.throws(() => ks.sign(key, m), KeyExhaustedError);
  assert.equal(onDisk(p), 3); // a refused sign does not burn a leaf
  assert.equal(ks.sign(key, m, { final: true }).leafIndex, 3);
  assert.throws(() => ks.sign(key, m, { final: true }), /exhausted/);
  assert.equal(ks.remaining, 0);
  ks.close();
  rmSync(dir, { recursive: true });
});

test("keystore: lock, wrong key, existing and corrupt files", () => {
  const dir = tmp();
  const key = xmssKeygen(seed, 2);
  const p = join(dir, "key.json");
  const ks = KeyStore.create(p, key, quiet);
  assert.throws(() => KeyStore.open(p, quiet), KeyStoreLockedError);
  assert.throws(() => KeyStore.create(p, key, quiet), /already exists/);
  assert.throws(() => ks.sign(xmssKeygen(keccak256(toBytes("other")), 2), m), /does not match/);
  assert.equal(onDisk(p), 0); // wrong key does not burn a leaf
  ks.close();
  assert.throws(() => ks.sign(key, m), /closed/);
  const again = KeyStore.open(p, quiet);
  again.close();
  writeFileSync(p, JSON.stringify({ version: 1, root: key.root, height: 2, nextIndex: 9 }));
  assert.throws(() => KeyStore.open(p, quiet), /corrupt/);
  assert.ok(!existsSync(`${p}.lock`)); // failed open releases the lock
  rmSync(dir, { recursive: true });
});
