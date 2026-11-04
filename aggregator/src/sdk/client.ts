// SigpressClient: a small viem-based client for XMSSAccount (contracts/src/xmss/XMSSAccount.sol).
// createAccount -> signOp (crash-safe, via KeyStore) -> submitDirect, or put op.leaf in an
// OptimisticAggregator batch (buildBatch) and run it with submitFromBatch once the batch is final.
// The outer transaction is still sent (and ECDSA-signed) by `walletClient`, i.e. a relayer/bundler;
// the account only acts on the hash-based signature.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  concat,
  encodeAbiParameters,
  keccak256,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type Transport,
  type WalletClient,
} from "viem";
import { payloadHash, type AccountCall } from "../account.ts";
import { MerkleTree } from "../merkle.ts";
import { xmssAccountAbi } from "./abi.ts";
import type { KeyStore } from "./keystore.ts";
import type { XMSSKey, XMSSPublicKey, XMSSSignature } from "./xmss.ts";

export type { AccountCall } from "../account.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ARTIFACT = resolve(here, "../../../contracts/out/XMSSAccount.sol/XMSSAccount.json");

/** Creation bytecode from the Foundry artifact (run `forge build` in contracts/ first). */
export function loadXMSSAccountBytecode(artifactPath: string = DEFAULT_ARTIFACT): Hex {
  const j = JSON.parse(readFileSync(artifactPath, "utf8")) as { bytecode: { object: Hex } };
  return j.bytecode.object;
}

/** m = keccak256(abi.encode(uint256 chainId, address account, bytes32 root, uint256 leafIndex, bytes32 payloadHash)) */
export function xmssMessageOf(chainId: bigint | number, account: Address, root: Hex, leafIndex: number | bigint, ph: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "bytes32" }, { type: "uint256" }, { type: "bytes32" }],
      [BigInt(chainId), account, root, BigInt(leafIndex), ph],
    ),
  );
}

/** A signed XMSSAccount op. `pkHash`, `m`, `sigHash`, `leaf` are the OptimisticAggregator batch fields. */
export interface XMSSOp extends AccountCall {
  account: Address;
  chainId: bigint;
  nonce: bigint;
  root: Hex;
  payloadHash: Hex;
  m: Hex;
  sig: XMSSSignature;
  /** = sig.leafPk, the WOTS key the aggregator's challenge checks against. */
  pkHash: Hex;
  sigHash: Hex;
  leaf: Hex;
}

export interface BatchPosition {
  batchId: bigint;
  index: number;
  proof: Hex[];
}

/** Merkle tree over op leaves, as OptimisticAggregator.submitBatch expects (pad to a power of two with 0). */
export function buildBatch(ops: Pick<XMSSOp, "leaf">[]): { tree: MerkleTree; root: Hex; proofs: Hex[][] } {
  const tree = new MerkleTree(ops.map((o) => o.leaf));
  return { tree, root: tree.root, proofs: ops.map((_, i) => tree.proof(i)) };
}

export class SigpressClient {
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient<Transport, Chain, Account>;
  readonly aggregator: Address;
  private bytecode?: Hex;

  constructor(opts: {
    publicClient: PublicClient;
    walletClient: WalletClient<Transport, Chain, Account>;
    /** OptimisticAggregator new accounts are bound to (any address if you only use submitDirect). */
    aggregator: Address;
    /** XMSSAccount creation bytecode; defaults to the local Foundry artifact. */
    bytecode?: Hex;
  }) {
    this.publicClient = opts.publicClient;
    this.walletClient = opts.walletClient;
    this.aggregator = opts.aggregator;
    this.bytecode = opts.bytecode;
  }

  private async confirm(hash: Hex): Promise<TransactionReceipt> {
    const r = await this.publicClient.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`tx reverted: ${hash}`);
    return r;
  }

  /** Deploy an XMSSAccount owned by `pub`; optionally fund it. Returns its address. */
  async createAccount(pub: XMSSPublicKey, opts: { fund?: bigint } = {}): Promise<Address> {
    this.bytecode ??= loadXMSSAccountBytecode();
    const hash = await this.walletClient.deployContract({
      abi: xmssAccountAbi,
      bytecode: this.bytecode,
      args: [this.aggregator, pub.root, BigInt(pub.height)],
    });
    const r = await this.confirm(hash);
    if (!r.contractAddress) throw new Error("no contract address in receipt");
    if (opts.fund) await this.confirm(await this.walletClient.sendTransaction({ to: r.contractAddress, value: opts.fund }));
    return r.contractAddress;
  }

  /**
   * Sign one op. The leaf index is taken from (and durably persisted to) `keystore` before the signature
   * is computed. Reads nonce and chain ID from chain unless given.
   */
  async signOp(opts: { account: Address; key: XMSSKey; keystore: KeyStore; call: AccountCall; nonce?: bigint; final?: boolean }): Promise<XMSSOp> {
    const [nonce, chainId, root] = await Promise.all([
      opts.nonce ?? this.publicClient.readContract({ address: opts.account, abi: xmssAccountAbi, functionName: "nonce" }),
      this.publicClient.getChainId().then(BigInt),
      this.publicClient.readContract({ address: opts.account, abi: xmssAccountAbi, functionName: "root" }),
    ]);
    if (root.toLowerCase() !== opts.key.root.toLowerCase()) throw new Error(`account ${opts.account} is not owned by this key`);
    const ph = payloadHash(opts.account, nonce, opts.call);
    let m: Hex = "0x";
    const sig = opts.keystore.sign(opts.key, (i) => (m = xmssMessageOf(chainId, opts.account, root, i, ph)), { final: opts.final });
    const sigHash = keccak256(sig.wotsSig);
    return {
      ...opts.call,
      account: opts.account,
      chainId,
      nonce,
      root,
      payloadHash: ph,
      m,
      sig,
      pkHash: sig.leafPk,
      sigHash,
      leaf: keccak256(concat([sig.leafPk, m, sigHash])),
    };
  }

  /** Run the op with its signature verified on chain (single-op path). */
  async submitDirect(op: XMSSOp): Promise<TransactionReceipt> {
    const hash = await this.walletClient.writeContract({
      address: op.account,
      abi: xmssAccountAbi,
      functionName: "executeDirect",
      args: [BigInt(op.sig.leafIndex), op.sig.leafPk, op.target, op.value, op.data, op.sig.wotsSig, op.sig.authPath],
    });
    return this.confirm(hash);
  }

  /** Run the op from a finalized, unslashed OptimisticAggregator batch that contains op.leaf. */
  async submitFromBatch(op: XMSSOp, pos: BatchPosition): Promise<TransactionReceipt> {
    const hash = await this.walletClient.writeContract({
      address: op.account,
      abi: xmssAccountAbi,
      functionName: "executeFromBatch",
      args: [pos.batchId, BigInt(op.sig.leafIndex), op.sig.leafPk, op.sig.authPath, op.target, op.value, op.data, BigInt(pos.index), pos.proof, op.sigHash],
    });
    return this.confirm(hash);
  }

  async nonce(account: Address): Promise<bigint> {
    return this.publicClient.readContract({ address: account, abi: xmssAccountAbi, functionName: "nonce" });
  }

  async isUsed(account: Address, leafIndex: number): Promise<boolean> {
    return this.publicClient.readContract({ address: account, abi: xmssAccountAbi, functionName: "isUsed", args: [BigInt(leafIndex)] });
  }
}
