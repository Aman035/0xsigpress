import { test } from "node:test";
import assert from "node:assert/strict";
import { concat, keccak256, toBytes, type Address } from "viem";
import { payloadHash, signAccountOp } from "../src/account.ts";
import { keygen, verify } from "../src/wots.ts";
import { messageOf } from "../src/op.ts";

const account = "0x00000000000000000000000000000000000000aa" as Address;
const aggregator = "0x00000000000000000000000000000000000000bb" as Address;
const call = { target: "0x000000000000000000000000000000000000bEEF" as Address, value: 10n ** 14n, data: "0x" as const };

test("signAccountOp: valid sig, rotation, leaf", () => {
  const seed = keccak256(toBytes("acct"));
  const op = signAccountOp({ seed, keyIndex: 3, account, nonce: 3n, chainId: 10143, aggregator, call });
  assert.equal(op.pkHash, keygen(seed, 3).pkHash);
  assert.equal(op.nextPkHash, keygen(seed, 4).pkHash);
  assert.equal(op.payloadHash, payloadHash(account, 3n, call));
  assert.equal(op.m, messageOf(10143, aggregator, op.pkHash, op.nextPkHash, op.payloadHash));
  assert.equal(verify(op.pkHash, op.m, op.sig), true);
  assert.equal(op.leaf, keccak256(concat([op.pkHash, op.m, op.sigHash])));
  assert.notEqual(payloadHash(account, 4n, call), op.payloadHash);
});
