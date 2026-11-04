// What the batcher needs from the chain, behind an interface so the batcher can be unit-tested against a
// fake. ViemChain is the real one: SigpressEntry + its OptimisticAggregator over viem.
// Every write is signed first and handed back as {hash, raw}; the batcher persists it, then broadcasts.
import { BaseError, ContractFunctionRevertedError, decodeErrorResult, encodeFunctionData, keccak256, parseAbi, parseEventLogs, type Address, type Hex } from "viem";
import { aggregatorAbi } from "../abi.ts";
import { bundleCalldata, entryAbi, sigpressAccountAbi } from "../compact.ts";
import { getClients } from "../chain.ts";
import type { OpRecord, SignedTx } from "./types.ts";

export interface BatchInfo {
  root: Hex;
  deadline: bigint;
  count: number;
  slashed: boolean;
  finalized: boolean;
}

export interface ExecutedEvent {
  account: Address;
  nonce: bigint;
  success: boolean;
}

export interface TxOutcome {
  status: "success" | "reverted";
  gasUsed: bigint;
  submitted?: { id: bigint };
  executed?: ExecutedEvent[];
}

export type BundleOp = Pick<OpRecord, "accountIndex" | "target" | "value" | "data" | "nextPkHash" | "sigHash">;

export interface ChainAdapter {
  readonly chainId: number;
  readonly entry: Address;
  readonly batches: Address;
  readonly sender: Address;
  accountCount(): Promise<number>;
  accountOf(index: number): Promise<Address>;
  accountState(account: Address): Promise<{ pkHash: Hex; nonce: bigint }>;
  /** Account index from its address (AccountCreated logs); may be unsupported on RPCs with log-range limits. */
  findAccountIndex?(account: Address): Promise<number | undefined>;
  bond(): Promise<bigint>;
  timestamp(): Promise<bigint>;
  batchInfo(id: bigint): Promise<BatchInfo>;
  bundleExecuted(id: bigint): Promise<boolean>;
  /** undefined if executeBundle would succeed now, else the revert reason. */
  simulateBundle(id: bigint, ops: BundleOp[]): Promise<string | undefined>;
  signSubmit(root: Hex, count: number, dataURI: string): Promise<SignedTx>;
  signFinalize(id: bigint): Promise<SignedTx>;
  signBundle(id: bigint, ops: BundleOp[]): Promise<SignedTx>;
  signDirect(op: OpRecord): Promise<SignedTx>;
  /** Broadcast; must tolerate a tx that is already known or already mined. */
  broadcast(tx: SignedTx): Promise<void>;
  /** Receipt (waits up to timeoutMs), or undefined if the tx is not mined by then. */
  outcome(hash: Hex, timeoutMs?: number): Promise<TxOutcome | undefined>;
}

export function revertReason(e: unknown): string {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (r?.data?.errorName) return r.data.errorName;
    return e.shortMessage;
  }
  return String(e);
}

// SigpressAccount's single-op fallback (WOTS verified on chain).
const directAbi = parseAbi([
  "function executeDirect(bytes32 nextPkHash, address target, uint256 value, bytes data, bytes sig)",
  "error InvalidSignature()",
  "error InsufficientGas()",
]);
const errorsAbi = [...entryAbi, ...sigpressAccountAbi, ...directAbi];

export async function viemChain(opts: { entry: Address; rpc?: string; privateKey?: Hex; keyVar?: string; gasMult?: number }): Promise<ChainAdapter> {
  const { chainId, account, publicClient, walletClient } = await getClients(opts);
  const entry = opts.entry;
  const batches = (await publicClient.readContract({ address: entry, abi: entryAbi, functionName: "batches" })) as Address;
  const mult = BigInt(Math.round((opts.gasMult ?? Number(process.env.GAS_MULT ?? 1.25)) * 1000));

  // Monad charges the gas limit, so the limit is estimate × mult (default 1.25), not a fixed ceiling.
  async function sign(to: Address, data: Hex, value = 0n): Promise<SignedTx> {
    const est = await publicClient.estimateGas({ account, to, data, value });
    const nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" });
    const req = await walletClient.prepareTransactionRequest({ account, to, data, value, gas: (est * mult) / 1000n, nonce, chain: walletClient.chain });
    const raw = await walletClient.signTransaction(req as any);
    return { hash: keccak256(raw), raw };
  }

  const bond = async () => (await publicClient.readContract({ address: batches, abi: aggregatorAbi, functionName: "bond" })) as bigint;
  return {
    chainId,
    entry,
    batches,
    sender: account.address,
    async accountCount() {
      return Number(await publicClient.readContract({ address: entry, abi: entryAbi, functionName: "accountCount" }));
    },
    async accountOf(index) {
      return (await publicClient.readContract({ address: entry, abi: entryAbi, functionName: "accountOf", args: [BigInt(index)] })) as Address;
    },
    async accountState(a) {
      const [pkHash, nonce] = await Promise.all([
        publicClient.readContract({ address: a, abi: sigpressAccountAbi, functionName: "pkHash" }),
        publicClient.readContract({ address: a, abi: sigpressAccountAbi, functionName: "nonce" }),
      ]);
      return { pkHash: pkHash as Hex, nonce: nonce as bigint };
    },
    async findAccountIndex(a) {
      try {
        const logs = await publicClient.getLogs({
          address: entry,
          event: entryAbi.find((x) => x.type === "event" && x.name === "AccountCreated") as any,
          args: { account: a } as any,
          fromBlock: BigInt(process.env.ENTRY_FROM_BLOCK ?? 0),
          toBlock: "latest",
        });
        const l = logs[0] as any;
        return l ? Number(l.args.index) : undefined;
      } catch {
        return undefined;
      }
    },
    bond,
    async timestamp() {
      return (await publicClient.getBlock({ blockTag: "latest" })).timestamp;
    },
    async batchInfo(id) {
      const [root, , deadline, count, slashed, finalized] = (await publicClient.readContract({ address: batches, abi: aggregatorAbi, functionName: "batches", args: [id] })) as readonly [Hex, Address, bigint, number, boolean, boolean];
      return { root, deadline, count: Number(count), slashed, finalized };
    },
    async bundleExecuted(id) {
      return (await publicClient.readContract({ address: entry, abi: entryAbi, functionName: "executed", args: [id] })) as boolean;
    },
    async simulateBundle(id, ops) {
      try {
        await publicClient.call({ account, to: entry, data: bundleCalldata(id, ops.map((o) => ({ ...o, index: o.accountIndex }))) });
        return undefined;
      } catch (e) {
        if (e instanceof BaseError) {
          const raw = (e.walk((x: any) => typeof x?.data === "string") as any)?.data as Hex | undefined;
          if (raw) {
            try {
              return decodeErrorResult({ abi: errorsAbi, data: raw }).errorName;
            } catch {}
          }
        }
        return revertReason(e);
      }
    },
    async signSubmit(root, count, dataURI) {
      const value = await bond();
      return sign(batches, encodeFunctionData({ abi: aggregatorAbi, functionName: "submitBatch", args: [root, count, dataURI] }), value);
    },
    async signFinalize(id) {
      return sign(batches, encodeFunctionData({ abi: aggregatorAbi, functionName: "finalize", args: [id] }));
    },
    async signBundle(id, ops) {
      return sign(entry, bundleCalldata(id, ops.map((o) => ({ ...o, index: o.accountIndex }))));
    },
    async signDirect(op) {
      return sign(op.account, encodeFunctionData({ abi: directAbi, functionName: "executeDirect", args: [op.nextPkHash, op.target, op.value, op.data, op.sig] }));
    },
    async broadcast(tx) {
      try {
        await publicClient.sendRawTransaction({ serializedTransaction: tx.raw });
      } catch (e) {
        // Resending after a restart: the node may already have it, or it may already be mined.
        const known = await publicClient.getTransactionReceipt({ hash: tx.hash }).catch(() => undefined);
        if (known) return;
        const msg = String((e as Error).message ?? e).toLowerCase();
        if (msg.includes("already known") || msg.includes("already imported") || msg.includes("known transaction")) return;
        throw e;
      }
    },
    async outcome(hash, timeoutMs = 60_000) {
      let r;
      try {
        r = await publicClient.waitForTransactionReceipt({ hash, timeout: timeoutMs, pollingInterval: 500 });
      } catch {
        return undefined;
      }
      const out: TxOutcome = { status: r.status, gasUsed: r.gasUsed };
      const sub = parseEventLogs({ abi: aggregatorAbi, logs: r.logs, eventName: "BatchSubmitted" })[0];
      if (sub) out.submitted = { id: sub.args.id };
      const ex = parseEventLogs({ abi: sigpressAccountAbi, logs: r.logs, eventName: "Executed" });
      if (ex.length) out.executed = ex.map((l) => ({ account: l.address as Address, nonce: l.args.nonce, success: l.args.success }));
      return out;
    },
  };
}
