import { test } from "node:test";
import assert from "node:assert/strict";
import { concat, encodeAbiParameters, encodePacked, keccak256, parseAbiParameters, size, toBytes, type Address, type Hex } from "viem";
import { bundleCalldata, compactValue, DEAD_FLAG, DEAD_RECORD_BYTES, decodeBundle, encodeBundle, encodeDeadOp, encodeOp, EXECUTE_BUNDLE_SELECTOR, signCompactOp } from "../src/compact.ts";
import { messageOf } from "../src/op.ts";
import { payloadHash } from "../src/account.ts";

const entry = "0x00000000000000000000000000000000000000ee" as Address;
const account = "0x00000000000000000000000000000000000000aa" as Address;
const target = "0x000000000000000000000000000000000000bEEF" as Address;

test("compactValue", () => {
  assert.equal(compactValue(0n), "0x00");
  assert.equal(compactValue(1n), "0x0101");
  assert.equal(compactValue(256n), "0x020100");
  assert.equal(compactValue(10n ** 14n), "0x065af3107a4000");
  assert.equal(size(compactValue(2n ** 256n - 1n)), 33);
});

test("plain transfer op is 97 bytes; bundle round-trips", () => {
  const seed = keccak256(toBytes("c"));
  const op = signCompactOp({ seed, keyIndex: 2, index: 7, account, nonce: 2n, chainId: 10143, entry, call: { target, value: 10n ** 14n, data: "0x" } });
  assert.equal(op.m, messageOf(10143, entry, op.pkHash, op.nextPkHash, payloadHash(account, 2n, op)));
  assert.equal(size(encodeOp(op)), 97);
  const withData = { ...op, data: "0xa9059cbb" as Hex, value: 0n };
  const b = encodeBundle(5, [op, withData]);
  assert.equal(size(b), 4 + 97 + (97 - 6 + 4));
  const d = decodeBundle(b);
  assert.equal(d.batchId, 5n);
  assert.equal(d.ops.length, 2);
  assert.equal(d.ops[0]!.value, 10n ** 14n);
  assert.equal(d.ops[1]!.data, "0xa9059cbb");
  assert.equal(d.ops[0]!.sigHash, op.sigHash);
  assert.equal(d.ops[1]!.target.toLowerCase(), target.toLowerCase());
  assert.equal(bundleCalldata(5, [op]).slice(0, 10), EXECUTE_BUNDLE_SELECTOR);
});

test("dead-op record is 216 bytes, matches the Solidity layout and round-trips", () => {
  const seed = keccak256(toBytes("d"));
  const op = signCompactOp({ seed, keyIndex: 3, index: 9, account, nonce: 3n, chainId: 10143, entry, call: { target, value: 10n ** 14n, data: "0xa9059cbb" } });
  const dead = { ...op, dead: true as const, nonce: 3n };
  const rec = encodeDeadOp(dead);
  assert.equal(size(rec), DEAD_RECORD_BYTES);
  assert.equal(
    rec.toLowerCase(),
    encodePacked(
      ["uint32", "uint256", "bytes32", "address", "uint256", "bytes32", "bytes32", "bytes32"],
      [9 + DEAD_FLAG, 3n, op.pkHash, target, 10n ** 14n, keccak256("0xa9059cbb"), op.nextPkHash, op.sigHash],
    ).toLowerCase(),
  );
  const d = decodeBundle(encodeBundle(1, [op, dead]));
  assert.equal(d.ops.length, 2);
  assert.equal(d.ops[0]!.dead, false);
  const r = d.ops[1]!;
  assert.equal(r.dead, true);
  assert.equal(r.index, 9);
  assert.equal(r.nonce, 3n);
  assert.equal(r.pkHash, op.pkHash);
  assert.equal(r.dataHash, keccak256("0xa9059cbb"));
  // the record carries everything needed to rebuild the committed leaf
  const ph = keccak256(encodeAbiParameters(parseAbiParameters("address, uint256, address, uint256, bytes32"), [account, r.nonce!, r.target, r.value, r.dataHash]));
  const m = messageOf(10143, entry, r.pkHash!, r.nextPkHash, ph);
  assert.equal(keccak256(concat([r.pkHash!, m, r.sigHash])), op.leaf);
});

test("account indexes with the dead-op flag bit are rejected", () => {
  const z = `0x${"00".repeat(32)}` as Hex;
  assert.throws(() => encodeOp({ index: DEAD_FLAG, target, value: 0n, data: "0x", nextPkHash: z, sigHash: z }));
});
