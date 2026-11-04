// Build a batch of N signed ops and write the DA file.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { bytesToHex, hexToBytes, keccak256, toBytes, type Address, type Hex } from "viem";
import { keygen, sign } from "./wots.ts";
import { leafOf, messageOf } from "./op.ts";
import { MerkleTree } from "./merkle.ts";
import { AGG_DIR } from "./chain.ts";

export interface Op {
  pkHash: Hex;
  nextPkHash: Hex;
  payloadHash: Hex;
  m: Hex;
  sig: Hex;
  leaf: Hex;
}

export function buildBatch(opts: { n: number; chainId: number; aggregator: Address; seedTag: string; tamperIndex?: number }) {
  const ops: Op[] = [];
  for (let i = 0; i < opts.n; i++) {
    const seed = keccak256(toBytes(`${opts.seedTag}${i}`));
    const key = keygen(seed, 0);
    const next = keygen(seed, 1);
    const payloadHash = keccak256(toBytes(`payload ${opts.seedTag} ${i}`));
    const m = messageOf(opts.chainId, opts.aggregator, key.pkHash, next.pkHash, payloadHash);
    let sig = sign(key.sk, m);
    if (opts.tamperIndex === i) {
      const b = hexToBytes(sig);
      b[0]! ^= 0x01;
      sig = bytesToHex(b);
    }
    ops.push({ pkHash: key.pkHash, nextPkHash: next.pkHash, payloadHash, m, sig, leaf: leafOf(key.pkHash, m, sig) });
  }
  const tree = new MerkleTree(ops.map((o) => o.leaf));
  const outDir = resolve(AGG_DIR, "out");
  mkdirSync(outDir, { recursive: true });
  const daFile = resolve(outDir, `batch-${tree.root}.json`);
  writeFileSync(daFile, JSON.stringify({ root: tree.root, count: ops.length, chainId: opts.chainId, aggregator: opts.aggregator, ops }, null, 2));
  return { ops, tree, daFile, dataURI: `sigpress-da:batch-${tree.root}.json` };
}
