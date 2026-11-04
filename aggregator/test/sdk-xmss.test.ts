import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, toBytes, type Hex } from "viem";
import { keygen } from "../src/wots.ts";
import { wotsSeedOf, xmssKeygen, xmssSigBytes, xmssSignUnsafe, xmssVerify } from "../src/sdk/xmss.ts";

const seed = keccak256(toBytes("x"));
const m = keccak256(toBytes("m"));
const key = xmssKeygen(seed, 4);

test("xmss: deterministic keygen; root vector shared with Solidity XMSSHelper", () => {
  assert.equal(xmssKeygen(seed, 4).root, key.root);
  // Same vector is asserted in contracts/test/xmss/XMSS.t.sol (test_rootMatchesTsVector).
  assert.equal(key.root, "0xebe1a9d135175043167aa1d10a73043c61e392f92494becbdc74e860328c7483");
  assert.notEqual(xmssKeygen(keccak256(toBytes("y")), 4).root, key.root);
  assert.notEqual(xmssKeygen(seed, 3).root, key.root);
  // Leaves are domain-separated from the per-op rotating keys of PQAccount (keygen(seed, i)).
  assert.notEqual(key.leaves[0], keygen(seed, 0).pkHash);
  assert.equal(key.leaves[0], keygen(wotsSeedOf(seed), 0).pkHash);
});

test("xmss: sign/verify at every leaf of h = 4", () => {
  for (let i = 0; i < 16; i++) {
    const s = xmssSignUnsafe(key, i, m);
    assert.equal(s.leafIndex, i);
    assert.equal(s.authPath.length, 4);
    assert.equal(xmssVerify(key, m, s), true, `leaf ${i}`);
  }
  assert.equal(xmssSigBytes(10), 2528);
});

test("xmss: rejects wrong message, path, index, leafPk, sig", () => {
  const s = xmssSignUnsafe(key, 5, m);
  const flip = (h: Hex): Hex => `0x${h.slice(2, -1)}${((parseInt(h.slice(-1), 16) ^ 1) & 0xf).toString(16)}`;
  assert.equal(xmssVerify(key, keccak256(toBytes("other")), s), false);
  assert.equal(xmssVerify(key, m, { ...s, authPath: [s.authPath[0]!, flip(s.authPath[1]!), ...s.authPath.slice(2)] }), false);
  assert.equal(xmssVerify(key, m, { ...s, authPath: s.authPath.slice(1) }), false);
  assert.equal(xmssVerify(key, m, { ...s, leafIndex: 4 }), false);
  assert.equal(xmssVerify(key, m, { ...s, leafIndex: 5 + 16 }), false);
  assert.equal(xmssVerify(key, m, { ...s, leafPk: key.leaves[6]! }), false);
  assert.equal(xmssVerify(key, m, { ...s, wotsSig: flip(s.wotsSig) }), false);
  assert.equal(xmssVerify(key, m, { ...s, wotsSig: s.wotsSig.slice(0, -2) as Hex }), false);
});

test("xmss: height bounds and leaf cache", () => {
  assert.throws(() => xmssKeygen(seed, 0));
  assert.throws(() => xmssKeygen(seed, 21));
  assert.throws(() => xmssSignUnsafe(key, 16, m));
  const cached = xmssKeygen(seed, 4, { leaves: key.leaves, expectedRoot: key.root });
  assert.equal(cached.root, key.root);
  assert.throws(() => xmssKeygen(seed, 4, { leaves: key.leaves.slice(1) }));
  assert.throws(() => xmssKeygen(keccak256(toBytes("y")), 4, { leaves: key.leaves }), /does not match seed/);
  assert.throws(() => xmssKeygen(seed, 4, { expectedRoot: keccak256(toBytes("nope")) }), /root mismatch/);
});
