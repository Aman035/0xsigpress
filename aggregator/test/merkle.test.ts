import { test } from "node:test";
import assert from "node:assert/strict";
import { concat, keccak256, toBytes, type Hex } from "viem";
import { MerkleTree, verifyProof, ZERO } from "../src/merkle.ts";
import { leafOf, messageOf } from "../src/op.ts";

const leaves = (n: number): Hex[] => Array.from({ length: n }, (_, i) => keccak256(toBytes(`leaf${i}`)));

for (const n of [1, 3, 4, 7]) {
  test(`merkle proofs size ${n}`, () => {
    const ls = leaves(n);
    const t = new MerkleTree(ls);
    for (let i = 0; i < n; i++) {
      const p = t.proof(i);
      assert.equal(verifyProof(t.root, ls[i]!, i, p), true);
      assert.equal(verifyProof(t.root, ls[(i + 1) % n]!, i, p) && n > 1, false);
      if (p.length > 0) assert.equal(verifyProof(t.root, ls[i]!, i ^ 1, p), false);
    }
  });
}

test("merkle structure", () => {
  const ls = leaves(3);
  const t = new MerkleTree(ls);
  const h = (a: Hex, b: Hex) => keccak256(concat([a, b]));
  assert.equal(t.root, h(h(ls[0]!, ls[1]!), h(ls[2]!, ZERO)));
  assert.equal(new MerkleTree([ls[0]!]).root, ls[0]);
});

test("messageOf / leafOf deterministic", () => {
  const pk = keccak256(toBytes("pk"));
  const m = messageOf(10143n, "0x0000000000000000000000000000000000000001", pk, pk, pk);
  assert.match(m, /^0x[0-9a-f]{64}$/);
  const leaf = leafOf(pk, m, "0x1234");
  assert.equal(leaf, keccak256(concat([pk, m, keccak256("0x1234")])));
});
