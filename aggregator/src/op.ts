// Operation message and leaf per spec.
import { concat, encodeAbiParameters, keccak256, type Address, type Hex } from "viem";

/** m = keccak256(abi.encode(uint256 chainId, address aggregator, bytes32 pkHash, bytes32 nextPkHash, bytes32 payloadHash)) */
export function messageOf(chainId: bigint | number, aggregator: Address, pkHash: Hex, nextPkHash: Hex, payloadHash: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
      [BigInt(chainId), aggregator, pkHash, nextPkHash, payloadHash],
    ),
  );
}

/** leaf = keccak256(abi.encodePacked(pkHash, m, keccak256(sig))) */
export function leafOf(pkHash: Hex, m: Hex, sig: Hex): Hex {
  return keccak256(concat([pkHash, m, keccak256(sig)]));
}
