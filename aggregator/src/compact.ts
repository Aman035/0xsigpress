// Compact bundle format for SigpressEntry (K9 fix). One bundle = one whole OptimisticAggregator batch.
// Calldata = selector(executeBundle()) ‖ batchId uint32 ‖ count × op, op (big-endian, unpadded):
//   accountIndex uint32 ‖ target 20 B ‖ valueLen uint8 ‖ value (valueLen B) ‖ dataLen uint16 ‖ data ‖ nextPkHash 32 B ‖ sigHash 32 B
// Ops are signed exactly like PQAccount ops (account.ts signAccountOp) with `aggregator` = the SigpressEntry address.
// Dead-op record (216 B), for an op that can no longer run because its account moved past it (see SigpressEntry):
//   (accountIndex | 0x80000000) uint32 ‖ nonce 32 B ‖ pkHash 32 B ‖ target 20 B ‖ value 32 B ‖ dataHash 32 B ‖ nextPkHash 32 B ‖ sigHash 32 B
// It runs nothing and only rebuilds the op's leaf, so the rest of the batch can still execute.
import { concat, keccak256, numberToHex, parseAbi, size, toFunctionSelector, type Address, type Hex } from "viem";
import { signAccountOp, type AccountCall, type AccountOp } from "./account.ts";

export const EXECUTE_BUNDLE_SELECTOR = toFunctionSelector("executeBundle()");

export const entryAbi = parseAbi([
  "function executeBundle()",
  "function createAccounts(bytes32[] pkHashes) payable returns (uint256 first)",
  "function accountOf(uint256 index) view returns (address)",
  "function accountCount() view returns (uint256)",
  "function executed(uint256 batchId) view returns (bool)",
  "function batches() view returns (address)",
  "function accountImpl() view returns (address)",
  "event AccountCreated(uint256 indexed index, address indexed account, bytes32 pkHash)",
  "event BundleExecuted(uint256 indexed batchId, uint256 count)",
  "event OpSkipped(uint256 indexed batchId, uint256 position)",
  "error Reentrancy()",
  "error BatchNotAccepted()",
  "error AlreadyExecuted()",
  "error BadBundle()",
  "error UnknownAccount(uint256 index)",
  "error RootMismatch()",
  "error CreateFailed()",
  "error NoAccounts()",
  "error OpNotDead(uint256 position)",
]);

export const sigpressAccountAbi = parseAbi([
  "function pkHash() view returns (bytes32)",
  "function nonce() view returns (uint256)",
  "function entry() view returns (address)",
  "function OP_GAS_LIMIT() view returns (uint256)",
  "error InsufficientGas()",
  "event Executed(uint256 indexed nonce, bytes32 indexed pkHash, bytes32 nextPkHash, address target, uint256 value, bool success)",
]);

export interface CompactOp extends AccountOp {
  index: number;
}

/** Minimal big-endian value: 1 length byte, then that many bytes (0 → just 0x00). */
export function compactValue(v: bigint): Hex {
  if (v < 0n) throw new Error("negative value");
  if (v === 0n) return "0x00";
  let hex = v.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const len = hex.length / 2;
  if (len > 32) throw new Error("value > uint256");
  return `0x${len.toString(16).padStart(2, "0")}${hex}`;
}

/** Top bit of accountIndex marks a dead-op record. */
export const DEAD_FLAG = 0x80000000;
export const DEAD_RECORD_BYTES = 216;

export type LiveBundleOp = { index: number; target: Address; value: bigint; data: Hex; nextPkHash: Hex; sigHash: Hex };
/** An op whose account has moved past it (nonce > `nonce`, or nonce == `nonce` with a different key). */
export type DeadBundleOp = LiveBundleOp & { dead: true; nonce: bigint; pkHash: Hex };
export type BundleOp = LiveBundleOp | DeadBundleOp;

function checkIndex(index: number) {
  if (!Number.isInteger(index) || index < 0 || index >= DEAD_FLAG) throw new Error("account index out of uint31");
}

export function encodeOp(op: LiveBundleOp): Hex {
  const dlen = size(op.data);
  if (dlen > 0xffff) throw new Error("op data > 65535 bytes");
  checkIndex(op.index);
  return concat([
    numberToHex(op.index, { size: 4 }),
    op.target,
    compactValue(op.value),
    numberToHex(dlen, { size: 2 }),
    op.data,
    op.nextPkHash,
    op.sigHash,
  ]);
}

/** Dead-op record (216 B): rebuilds the op's leaf on chain without running it. */
export function encodeDeadOp(op: DeadBundleOp): Hex {
  checkIndex(op.index);
  if (op.value < 0n || op.value >= 2n ** 256n) throw new Error("value out of uint256");
  return concat([
    numberToHex(op.index + DEAD_FLAG, { size: 4 }),
    numberToHex(op.nonce, { size: 32 }),
    op.pkHash,
    op.target,
    numberToHex(op.value, { size: 32 }),
    keccak256(op.data),
    op.nextPkHash,
    op.sigHash,
  ]);
}

const isDead = (op: BundleOp): op is DeadBundleOp => "dead" in op && op.dead === true;

/** Bundle bytes (without the selector). Ops marked `dead: true` are encoded as dead-op records. */
export function encodeBundle(batchId: bigint | number, ops: BundleOp[]): Hex {
  const id = BigInt(batchId);
  if (id > 0xffffffffn) throw new Error("batchId out of uint32");
  return concat([numberToHex(id, { size: 4 }), ...ops.map((o) => (isDead(o) ? encodeDeadOp(o) : encodeOp(o)))]);
}

/** Full calldata for SigpressEntry.executeBundle(). */
export function bundleCalldata(batchId: bigint | number, ops: BundleOp[]): Hex {
  return concat([EXECUTE_BUNDLE_SELECTOR, encodeBundle(batchId, ops)]);
}

/** Inverse of encodeBundle (for tests and DA tooling). */
export function decodeBundle(bundle: Hex) {
  const b = bundle.slice(2);
  let p = 0;
  const take = (n: number): Hex => {
    if (p + n * 2 > b.length) throw new Error("truncated bundle");
    const out = `0x${b.slice(p, p + n * 2)}` as Hex;
    p += n * 2;
    return out;
  };
  const batchId = BigInt(take(4));
  const ops: DecodedOp[] = [];
  while (p < b.length) {
    const tag = Number(BigInt(take(4)));
    if (tag >= DEAD_FLAG) {
      const nonce = BigInt(take(32));
      const pkHash = take(32);
      const target = take(20) as Address;
      const value = BigInt(take(32));
      const dataHash = take(32);
      const nextPkHash = take(32);
      const sigHash = take(32);
      ops.push({ dead: true, index: tag - DEAD_FLAG, nonce, pkHash, target, value, dataHash, nextPkHash, sigHash });
      continue;
    }
    const index = tag;
    const target = take(20) as Address;
    const vlen = Number(BigInt(take(1)));
    const value = vlen === 0 ? 0n : BigInt(take(vlen));
    const dlen = Number(BigInt(take(2)));
    const data = dlen === 0 ? ("0x" as Hex) : take(dlen);
    const nextPkHash = take(32);
    const sigHash = take(32);
    ops.push({ dead: false, index, target, value, data, dataHash: keccak256(data), nextPkHash, sigHash });
  }
  return { batchId, ops };
}

export interface DecodedOp {
  dead: boolean;
  index: number;
  target: Address;
  value: bigint;
  /** Present for live ops only (a dead record carries just its hash). */
  data?: Hex;
  dataHash: Hex;
  nextPkHash: Hex;
  sigHash: Hex;
  /** Dead records only. */
  nonce?: bigint;
  pkHash?: Hex;
}

/** Sign an op for SigpressAccount `index` at `account` whose current key is keygen(seed, keyIndex). */
export function signCompactOp(opts: {
  seed: Hex;
  keyIndex: number;
  index: number;
  account: Address;
  nonce: bigint;
  chainId: number | bigint;
  entry: Address;
  call: AccountCall;
}): CompactOp {
  const op = signAccountOp({ ...opts, aggregator: opts.entry });
  return { ...op, index: opts.index };
}
