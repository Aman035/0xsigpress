import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { bytesToHex, hexToBytes, keccak256, toBytes, type Hex } from "viem";
import { digits, keygen, sign, verify, SIG_BYTES } from "../src/wots.ts";

const seed = keccak256(toBytes("sigpress-test"));
const m = keccak256(toBytes("hello"));

test("sign/verify roundtrip", () => {
  const { sk, pkHash } = keygen(seed, 0);
  const sig = sign(sk, m);
  assert.equal(hexToBytes(sig).length, SIG_BYTES);
  assert.equal(verify(pkHash, m, sig), true);
});

test("flipped bit in sig fails", () => {
  const { sk, pkHash } = keygen(seed, 0);
  const b = hexToBytes(sign(sk, m));
  b[100]! ^= 0x01;
  assert.equal(verify(pkHash, m, bytesToHex(b)), false);
});

test("wrong message fails, wrong key fails", () => {
  const { sk, pkHash } = keygen(seed, 0);
  const sig = sign(sk, m);
  assert.equal(verify(pkHash, keccak256(toBytes("hellp")), sig), false);
  assert.equal(verify(keygen(seed, 1).pkHash, m, sig), false);
});

test("checksum digits", () => {
  const zero = `0x${"00".repeat(32)}` as Hex;
  const d0 = digits(zero);
  assert.equal(d0.length, 67);
  // c = 64 * 15 = 960 = 0x3c0
  assert.deepEqual(d0.slice(64), [3, 12, 0]);
  const ff = `0x${"ff".repeat(32)}` as Hex;
  assert.deepEqual(digits(ff).slice(64), [0, 0, 0]);
  const d = digits(("0xab" + "00".repeat(31)) as Hex);
  assert.equal(d[0], 0xa);
  assert.equal(d[1], 0xb);
  // c = 960 - 10 - 11 = 939 = 0x3ab
  assert.deepEqual(d.slice(64), [3, 0xa, 0xb]);
});

test("fixed vector", () => {
  const { sk, pkHash } = keygen(seed, 0);
  const sig = sign(sk, m);
  const vector = { seed, keyIndex: 0, m, pkHash, sigHash: keccak256(sig), sig };
  writeFileSync(new URL("./vector.json", import.meta.url), JSON.stringify(vector, null, 2) + "\n");
  console.log(`vector pkHash=${pkHash} keccak256(sig)=${vector.sigHash}`);
});
