// PQAccount op helpers: payloadHash, message, and a signed op ready for a batch or executeDirect.
import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import { keygen, sign } from "./wots.ts";
import { leafOf, messageOf } from "./op.ts";

export interface AccountCall {
  target: Address;
  value: bigint;
  data: Hex;
}

/** payloadHash = keccak256(abi.encode(address account, uint256 nonce, address target, uint256 value, bytes32 keccak256(data))) */
export function payloadHash(account: Address, nonce: bigint, call: AccountCall): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }],
      [account, nonce, call.target, call.value, keccak256(call.data)],
    ),
  );
}

export interface AccountOp extends AccountCall {
  account: Address;
  nonce: bigint;
  pkHash: Hex;
  nextPkHash: Hex;
  payloadHash: Hex;
  m: Hex;
  sig: Hex;
  sigHash: Hex;
  leaf: Hex;
}

/**
 * Sign an op for a PQAccount whose current key is keygen(seed, keyIndex); the op rotates to keygen(seed, keyIndex + 1).
 * `aggregator` is the OptimisticAggregator the account is bound to (used for both batch and direct paths).
 */
export function signAccountOp(opts: {
  seed: Hex;
  keyIndex: number;
  account: Address;
  nonce: bigint;
  chainId: number | bigint;
  aggregator: Address;
  call: AccountCall;
}): AccountOp {
  const key = keygen(opts.seed, opts.keyIndex);
  const next = keygen(opts.seed, opts.keyIndex + 1);
  const ph = payloadHash(opts.account, opts.nonce, opts.call);
  const m = messageOf(opts.chainId, opts.aggregator, key.pkHash, next.pkHash, ph);
  const sig = sign(key.sk, m);
  return {
    ...opts.call,
    account: opts.account,
    nonce: opts.nonce,
    pkHash: key.pkHash,
    nextPkHash: next.pkHash,
    payloadHash: ph,
    m,
    sig,
    sigHash: keccak256(sig),
    leaf: leafOf(key.pkHash, m, sig),
  };
}
