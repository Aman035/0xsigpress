// Revealer: the honest aggregator's side of the SR-R1 data-availability game. Anyone may call
// requestReveal(batchId, index) on a batch during its window; the signature must then be posted on chain with
// reveal(...) within revealWindow, or anyone can slash the batch (half the bond to the requester). This loop
// follows RevealRequested on the OptimisticAggregator and answers every open request on a batch it has the
// DA document for (by root). reveal is permissionless, so it can run with any funded key; a key other than
// the batcher's avoids nonce races with the batcher's own txs.
import { parseEventLogs, type Address, type Hex } from "viem";
import { aggregatorAbi } from "../abi.ts";
import { getClients } from "../chain.ts";
import { MerkleTree } from "../merkle.ts";
import { leafOf } from "../op.ts";
import { revertReason } from "./chain.ts";
import type { DADoc } from "./da.ts";

export type RevealerEvent =
  | { type: "revealed"; id: bigint; index: number; txHash: Hex }
  | { type: "reveal-error"; id: bigint; index: number; reason: string };

export interface RevealerOptions {
  aggregator: Address;
  /** The DA document for a batch root, if this service posted it. */
  getDA: (root: Hex) => DADoc | undefined;
  rpc?: string;
  privateKey?: Hex;
  keyVar?: string;
  fromBlock?: bigint;
  pollMs?: number;
  logChunk?: number;
  onEvent?: (e: RevealerEvent) => void;
  log?: (msg: string) => void;
}

export async function startRevealer(opts: RevealerOptions) {
  const { publicClient, walletClient, account } = await getClients({ rpc: opts.rpc, privateKey: opts.privateKey, keyVar: opts.keyVar });
  const log = opts.log ?? ((m: string) => console.log(`[revealer ${new Date().toISOString()}] ${m}`));
  const chunk = BigInt(opts.logChunk ?? 100);
  const pending = new Map<string, { id: bigint; index: number }>();
  let next: bigint | undefined = opts.fromBlock;

  async function scan() {
    const latest = await publicClient.getBlockNumber();
    let from = next ?? (latest > 1000n ? latest - 1000n : 0n);
    while (from <= latest) {
      const to = from + chunk - 1n < latest ? from + chunk - 1n : latest;
      const logs = await publicClient.getLogs({ address: opts.aggregator, fromBlock: from, toBlock: to });
      for (const ev of parseEventLogs({ abi: aggregatorAbi, logs, eventName: "RevealRequested" })) {
        pending.set(`${ev.args.id}:${ev.args.index}`, { id: ev.args.id, index: Number(ev.args.index) });
      }
      from = to + 1n;
      next = from;
    }
  }

  async function answer(id: bigint, index: number) {
    const [, , open] = await publicClient.readContract({ address: opts.aggregator, abi: aggregatorAbi, functionName: "reveals", args: [id, BigInt(index)] });
    if (!open) return true;
    const [root, , , , slashed] = await publicClient.readContract({ address: opts.aggregator, abi: aggregatorAbi, functionName: "batches", args: [id] });
    if (slashed) return true;
    const doc = opts.getDA(root);
    if (!doc) return true; // not our batch (or data lost): nothing we can do
    const leaves = doc.leaves.map((l) => leafOf(l.pkHash, l.m, l.sig));
    const l = doc.leaves[index];
    if (!l) return true;
    const args = [id, BigInt(index), l.pkHash, l.m, l.sig, new MerkleTree(leaves).proof(index)] as const;
    await publicClient.simulateContract({ account, address: opts.aggregator, abi: aggregatorAbi, functionName: "reveal", args });
    const hash = await walletClient.writeContract({ address: opts.aggregator, abi: aggregatorAbi, functionName: "reveal", args });
    const r = await publicClient.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`reveal tx reverted ${hash}`);
    log(`batch ${id}: revealed leaf ${index} (${hash})`);
    opts.onEvent?.({ type: "revealed", id, index, txHash: hash });
    return true;
  }

  async function poll() {
    await scan();
    for (const [k, p] of pending) {
      try {
        if (await answer(p.id, p.index)) pending.delete(k);
      } catch (e) {
        const reason = revertReason(e);
        if (reason === "RevealExpired" || reason === "NoRevealRequest" || reason === "AlreadySlashed") pending.delete(k);
        log(`batch ${p.id}: reveal of leaf ${p.index} failed: ${reason}`);
        opts.onEvent?.({ type: "reveal-error", id: p.id, index: p.index, reason });
      }
    }
  }

  let stopped = false;
  let running: Promise<void> = Promise.resolve();
  const loop = (async () => {
    log(`answering reveal requests on ${opts.aggregator} as ${account.address}`);
    while (!stopped) {
      running = poll().catch((e) => log(`poll: ${(e as Error).message.split("\n")[0]}`));
      await running;
      await new Promise((r) => setTimeout(r, opts.pollMs ?? 1000));
    }
  })();
  return {
    poll,
    async stop() {
      stopped = true;
      await running;
      await loop;
    },
  };
}
