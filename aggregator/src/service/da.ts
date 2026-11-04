// Data-availability document for one OptimisticAggregator batch, and the check a challenger runs on it.
// A batch commits only to leaves keccak256(pkHash ‖ m ‖ keccak256(sig)); nobody can challenge a bad leaf
// without the signature itself, so whoever posts a batch must publish this document (GET /da/:root).
// Leaves carry the full op too, so anyone can rebuild the executeBundle calldata from it (liveness).
import { isHex, type Address, type Hex } from "viem";
import { leafOf } from "../op.ts";
import { MerkleTree } from "../merkle.ts";
import { verify } from "../wots.ts";

export interface DALeaf {
  index: number;
  pkHash: Hex;
  m: Hex;
  sig: Hex;
  // Optional op fields (SigpressEntry bundles); not needed to challenge.
  accountIndex?: number;
  account?: Address;
  nonce?: string;
  target?: Address;
  value?: string;
  data?: Hex;
  nextPkHash?: Hex;
}

export interface DADoc {
  version: 1;
  root: Hex;
  count: number;
  chainId: number;
  aggregator: Address;
  entry?: Address;
  leaves: DALeaf[];
}

export type DACheck =
  | { ok: false; reason: string }
  | { ok: true; tree: MerkleTree; firstBad: number | undefined; checked: number };

const isB32 = (v: unknown): v is Hex => typeof v === "string" && isHex(v) && v.length === 66;

/**
 * Check a DA document against what the chain says about the batch: the leaves must rebuild exactly `root`
 * with exactly `count` leaves (otherwise the data is effectively unavailable). Then verify every WOTS
 * signature and report the first invalid one, which is what `challenge` needs.
 */
export function checkDA(doc: unknown, expected: { root: Hex; count: number }): DACheck {
  const d = doc as Partial<DADoc> | undefined;
  if (!d || typeof d !== "object" || !Array.isArray(d.leaves)) return { ok: false, reason: "not a DA document (no leaves[])" };
  if (d.leaves.length !== expected.count) return { ok: false, reason: `DA has ${d.leaves.length} leaves, batch count is ${expected.count}` };
  const leaves: Hex[] = [];
  for (let i = 0; i < d.leaves.length; i++) {
    const l = d.leaves[i]!;
    if (!l || !isB32(l.pkHash) || !isB32(l.m) || typeof l.sig !== "string" || !isHex(l.sig)) return { ok: false, reason: `leaf ${i} malformed` };
    leaves.push(leafOf(l.pkHash, l.m, l.sig));
  }
  if (leaves.length === 0) return { ok: false, reason: "empty batch" };
  const tree = new MerkleTree(leaves);
  if (tree.root.toLowerCase() !== expected.root.toLowerCase()) return { ok: false, reason: `DA leaves rebuild root ${tree.root}, chain has ${expected.root}` };
  let firstBad: number | undefined;
  for (let i = 0; i < d.leaves.length; i++) {
    const l = d.leaves[i]!;
    if (!verify(l.pkHash, l.m, l.sig)) {
      firstBad = i;
      break;
    }
  }
  return { ok: true, tree, firstBad, checked: firstBad === undefined ? d.leaves.length : firstBad + 1 };
}
