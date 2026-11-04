// Merkle tree per spec: pad leaves with bytes32(0) to a power of two; parent = keccak256(left ‖ right).
// Proof = sibling list bottom-up; bit i of index = 1 means the node is the right child at level i.
import { concat, keccak256, type Hex } from "viem";

export const ZERO: Hex = `0x${"00".repeat(32)}`;

const hashPair = (l: Hex, r: Hex): Hex => keccak256(concat([l, r]));

export class MerkleTree {
  readonly levels: Hex[][];
  readonly count: number;

  constructor(leaves: Hex[]) {
    if (leaves.length === 0) throw new Error("no leaves");
    this.count = leaves.length;
    let size = 1;
    while (size < leaves.length) size *= 2;
    const base = [...leaves];
    while (base.length < size) base.push(ZERO);
    this.levels = [base];
    let cur = base;
    while (cur.length > 1) {
      const next: Hex[] = [];
      for (let i = 0; i < cur.length; i += 2) next.push(hashPair(cur[i]!, cur[i + 1]!));
      this.levels.push(next);
      cur = next;
    }
  }

  get root(): Hex {
    return this.levels[this.levels.length - 1]![0]!;
  }

  proof(index: number): Hex[] {
    if (index < 0 || index >= this.levels[0]!.length) throw new Error("index out of range");
    const out: Hex[] = [];
    let i = index;
    for (let lvl = 0; lvl < this.levels.length - 1; lvl++) {
      out.push(this.levels[lvl]![i ^ 1]!);
      i >>= 1;
    }
    return out;
  }
}

export function verifyProof(root: Hex, leaf: Hex, index: number, proof: Hex[]): boolean {
  let h = leaf;
  let i = index;
  for (const sib of proof) {
    h = i & 1 ? hashPair(sib, h) : hashPair(h, sib);
    i >>= 1;
  }
  return i === 0 && h.toLowerCase() === root.toLowerCase();
}
