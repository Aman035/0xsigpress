// XMSS-style multi-use key: a Merkle tree over 2^height WOTS one-time keys.
// Matches contracts/src/xmss/XMSS.sol and contracts/test/xmss/XMSSHelper.sol.
//   wotsSeed = keccak256(abi.encodePacked("sigpress.xmss.v1", seed))
//   leaf i   = keygen(wotsSeed, i).pkHash            (WOTS per the shared spec, src/wots.ts)
//   root     = Merkle root over the 2^height leaves  (parent = keccak256(left || right), src/merkle.ts)
//   sig      = (leafIndex, leafPk, wotsSig 2,144 B, authPath height x 32 B)
// Stateful: every leaf may sign ONE message. Use KeyStore (keystore.ts) to pick leaves, never sign() directly
// with an index you chose yourself.
import { concat, keccak256, stringToHex, type Hex } from "viem";
import { keygen, sign as wotsSign, verify as wotsVerify, SIG_BYTES } from "../wots.ts";
import { MerkleTree, verifyProof } from "../merkle.ts";

export const XMSS_DOMAIN = "sigpress.xmss.v1";
export const DEFAULT_HEIGHT = 10;
export const MAX_HEIGHT = 20; // off-chain keygen limit (2^20 WOTS keygens is already ~1e9 hashes); chain allows 32

export interface XMSSPublicKey {
  root: Hex;
  height: number;
}

export interface XMSSSignature {
  leafIndex: number;
  leafPk: Hex;
  wotsSig: Hex;
  authPath: Hex[];
}

export interface XMSSKey extends XMSSPublicKey {
  /** All 2^height leaf public keys (public data). */
  readonly leaves: Hex[];
  readonly tree: MerkleTree;
  /** Secret: derive one-time keys from it. Never log or persist next to the key state. */
  readonly wotsSeed: Hex;
}

export function wotsSeedOf(seed: Hex): Hex {
  return keccak256(concat([stringToHex(XMSS_DOMAIN), seed]));
}

function checkHeight(height: number): void {
  if (!Number.isInteger(height) || height < 1 || height > MAX_HEIGHT) throw new Error(`height must be an integer in [1, ${MAX_HEIGHT}]`);
}

/**
 * Deterministic keygen from a 32-byte secret seed. Cost: 2^height WOTS keygens (~1,072 Keccak each).
 * Pass `leaves` (from a previous keygen, e.g. a cache) to skip recomputing them; the first and last are
 * re-derived as a spot check, and the root is checked against `expectedRoot` if given.
 */
export function xmssKeygen(seed: Hex, height: number = DEFAULT_HEIGHT, opts: { leaves?: Hex[]; expectedRoot?: Hex } = {}): XMSSKey {
  checkHeight(height);
  const wotsSeed = wotsSeedOf(seed);
  const n = 2 ** height;
  let leaves: Hex[];
  if (opts.leaves) {
    if (opts.leaves.length !== n) throw new Error(`expected ${n} cached leaves, got ${opts.leaves.length}`);
    // Spot-check the cache against the seed (first and last leaf) so a cache from another seed fails loudly.
    for (const i of [0, n - 1]) {
      if (opts.leaves[i]!.toLowerCase() !== keygen(wotsSeed, i).pkHash.toLowerCase()) throw new Error("leaf cache does not match seed");
    }
    leaves = opts.leaves;
  } else {
    leaves = [];
    for (let i = 0; i < n; i++) leaves.push(keygen(wotsSeed, i).pkHash);
  }
  const tree = new MerkleTree(leaves);
  if (opts.expectedRoot && tree.root.toLowerCase() !== opts.expectedRoot.toLowerCase()) {
    throw new Error("XMSS root mismatch: wrong seed, height or leaf cache");
  }
  return { root: tree.root, height, leaves, tree, wotsSeed };
}

/**
 * Low-level sign with leaf `index`. Does NOT track state: signing two messages with one index breaks
 * the one-time key. Use KeyStore.sign() instead.
 */
export function xmssSignUnsafe(key: XMSSKey, index: number, m: Hex): XMSSSignature {
  if (!Number.isInteger(index) || index < 0 || index >= 2 ** key.height) throw new Error(`leaf index ${index} out of range`);
  const wk = keygen(key.wotsSeed, index);
  return { leafIndex: index, leafPk: wk.pkHash, wotsSig: wotsSign(wk.sk, m), authPath: key.tree.proof(index) };
}

export function xmssVerify(pub: XMSSPublicKey, m: Hex, sig: XMSSSignature): boolean {
  if (sig.authPath.length !== pub.height) return false;
  if (!Number.isInteger(sig.leafIndex) || sig.leafIndex < 0 || sig.leafIndex >= 2 ** pub.height) return false;
  if ((sig.wotsSig.length - 2) / 2 !== SIG_BYTES) return false;
  if (!verifyProof(pub.root, sig.leafPk, sig.leafIndex, sig.authPath)) return false;
  return wotsVerify(sig.leafPk, m, sig.wotsSig);
}

/** Bytes a signature takes in calldata-like terms: index word + leafPk + WOTS + path. */
export function xmssSigBytes(height: number): number {
  return 32 + 32 + SIG_BYTES + 32 * height;
}
