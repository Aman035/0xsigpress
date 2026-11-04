// Records the service persists. Op ids are the op's batch leaf (unique: it binds pkHash, m and the sig).
import type { Address, Hex } from "viem";

export type OpStatus = "pending" | "batched" | "finalized" | "executed" | "failed";
export type BatchStatus = "built" | "submitted" | "finalized" | "executed" | "slashed" | "failed";

/** A signed transaction whose hash is persisted before it is broadcast, so a restart can find or resend it. */
export interface SignedTx {
  hash: Hex;
  raw: Hex;
}

export interface OpRecord {
  id: Hex; // = leaf
  seq: number; // acceptance order
  accountIndex: number;
  account: Address;
  nonce: bigint;
  pkHash: Hex;
  nextPkHash: Hex;
  target: Address;
  value: bigint;
  data: Hex;
  m: Hex;
  sig: Hex;
  sigHash: Hex;
  status: OpStatus;
  acceptedAt: number; // ms
  queuedAt: number; // ms, reset when requeued
  batchKey?: string; // local key of the batch it is in
  via?: "bundle" | "direct";
  txHash?: Hex;
  callSuccess?: boolean; // the op's own call (a failing call does not revert the bundle)
  error?: string;
  /** Sent as a dead-op record: its account moved past it before the bundle ran, so it is skipped on chain. */
  dead?: boolean;
  directTx?: SignedTx;
}

export interface BatchRecord {
  key: string; // local key (b0, b1, ...); the same ops requeued give the same root, so the root is not unique
  root: Hex;
  id?: bigint; // on-chain OptimisticAggregator batch id, known after submit
  status: BatchStatus;
  opIds: Hex[];
  createdAt: number;
  deadline?: bigint; // block timestamp
  submitTx?: SignedTx;
  finalizeTx?: SignedTx;
  executeTx?: SignedTx;
  error?: string;
}

export interface ServiceState {
  version: 1;
  chainId: number;
  entry: Address;
  batches: Address;
  nextSeq: number;
  nextBatch: number;
  ops: Record<Hex, OpRecord>;
  batchList: Record<string, BatchRecord>;
}
