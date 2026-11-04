import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { bytesToHex, getAddress, type Hex } from "viem";
import { BIND_V2_DIR, batchCommitment, decodeRevert, loadShape, submitCalldataV2, validityOpHash, type Statement } from "../src/validity.ts";

const run = (n: string) => resolve(BIND_V2_DIR, "runs", n);
const cd = (label: string) => resolve(BIND_V2_DIR, "results", label, "calldata.bin");
const have = existsSync(resolve(run("n4"), "statement.json")) && existsSync(cd("SigpressBindV2C1N4"));
const skip = have ? false : "binding-v2 run n4 not present";

test("validity v2: TS gate.submit calldata equals binding-v2/tools/submit_calldata.py", { skip }, () => {
  const st = JSON.parse(readFileSync(resolve(run("n4"), "statement.json"), "utf8")) as Statement;
  const vcd = bytesToHex(new Uint8Array(readFileSync(cd("SigpressBindV2C1N4"))));
  for (const m of ["", "swap-batches", "wrong-message", "wrong-slot"] as const) {
    const py = execFileSync("python3", ["-I", resolve(BIND_V2_DIR, "tools/submit_calldata.py"), cd("SigpressBindV2C1N4"), resolve(run("n4"), "statement.json"), ...(m ? [m] : [])], { encoding: "utf8" }).trim();
    assert.equal(submitCalldataV2(vcd, st, m), py, `mutation '${m}'`);
  }
  assert.notEqual(submitCalldataV2(vcd, st, "tampered-proof"), submitCalldataV2(vcd, st));
});

test("validity v2: batchCommitment matches the commitment the Monad gate accepted (2 x 256 run)", { skip: existsSync(resolve(run("n256"), "statement.json")) ? false : "no n256 run" }, () => {
  const st = JSON.parse(readFileSync(resolve(run("n256"), "statement.json"), "utf8")) as Statement;
  const c = batchCommitment(st.slot, st.left, st.right);
  // binding-v2/results/monad-n256.jsonl: accepted(0x956440c0…f4dd) = true
  assert.ok(c.startsWith("0x956440c0") && c.endsWith("f4dd"), c);
});

test("validity v2: shapes, op hash and revert decoding", () => {
  assert.equal(loadShape("2x1024").gate, getAddress("0x5648caea56baa011b6685ce091089b561621a661"));
  assert.equal(loadShape("2x256").perChild, 256);
  const o = { chainId: 10143, entry: getAddress("0x00000000000000000000000000000000000000e1"), account: getAddress("0x00000000000000000000000000000000000000a1"), nonce: 0n, target: getAddress("0x00000000000000000000000000000000000000b1"), value: 1n, data: "0x" as Hex };
  assert.notEqual(validityOpHash(o), validityOpHash({ ...o, nonce: 1n }));
  assert.equal(decodeRevert("0x5ade0455"), "RootMismatch");
  assert.equal(decodeRevert("0x1aa8064c"), "AlreadyAccepted");
  assert.equal(decodeRevert("0x08c379a00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000b4d45524b4c455f524f4f54000000000000000000000000000000000000000000"), "MERKLE_ROOT");
});
