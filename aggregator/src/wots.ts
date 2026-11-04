// WOTS (w = 16, n = 32, Keccak-256), exactly per docs/hackathon-plan.md "Shared spec".
import { bytesToHex, concatBytes, hexToBytes, keccak256, type Hex } from "viem";

export const W = 16;
export const N = 32;
export const LEN1 = 64;
export const LEN2 = 3;
export const LEN = LEN1 + LEN2; // 67
export const SIG_BYTES = LEN * N; // 2144

const k = (b: Uint8Array): Uint8Array => keccak256(b, "bytes");

export function chain(x: Uint8Array, steps: number): Uint8Array {
  let y = x;
  for (let s = 0; s < steps; s++) y = k(y);
  return y;
}

/** 64 nibbles of m (high nibble of byte 0 first) + 3 checksum digits. */
export function digits(m: Hex): number[] {
  const b = hexToBytes(m);
  if (b.length !== 32) throw new Error("message must be 32 bytes");
  const d: number[] = [];
  for (const byte of b) d.push(byte >> 4, byte & 0xf);
  let c = 0;
  for (const x of d) c += 15 - x;
  d.push((c >> 8) & 0xf, (c >> 4) & 0xf, c & 0xf);
  return d;
}

/** sk_i = keccak256(abi.encodePacked(bytes32 seed, uint32 keyIndex, uint8 i)). */
function skBytes(seed: Hex, keyIndex: number): Uint8Array[] {
  const s = hexToBytes(seed);
  if (s.length !== 32) throw new Error("seed must be 32 bytes");
  const buf = new Uint8Array(37);
  buf.set(s, 0);
  new DataView(buf.buffer).setUint32(32, keyIndex >>> 0, false);
  const out: Uint8Array[] = [];
  for (let i = 0; i < LEN; i++) {
    buf[36] = i;
    out.push(k(buf));
  }
  return out;
}

export function keygen(seed: Hex, keyIndex: number): { sk: Hex[]; pk: Hex[]; pkHash: Hex } {
  const sk = skBytes(seed, keyIndex);
  const pk = sk.map((x) => chain(x, W - 1));
  return {
    sk: sk.map((x) => bytesToHex(x)),
    pk: pk.map((x) => bytesToHex(x)),
    pkHash: keccak256(concatBytes(pk)),
  };
}

export function sign(sk: Hex[], m: Hex): Hex {
  if (sk.length !== LEN) throw new Error("sk must have 67 elements");
  const d = digits(m);
  return bytesToHex(concatBytes(sk.map((x, i) => chain(hexToBytes(x), d[i]!))));
}

export function verify(pkHash: Hex, m: Hex, sig: Hex): boolean {
  const s = hexToBytes(sig);
  if (s.length !== SIG_BYTES) return false;
  const d = digits(m);
  const parts: Uint8Array[] = [];
  for (let i = 0; i < LEN; i++) parts.push(chain(s.subarray(i * N, (i + 1) * N), W - 1 - d[i]!));
  return keccak256(concatBytes(parts)).toLowerCase() === pkHash.toLowerCase();
}
