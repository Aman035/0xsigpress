// viem clients for Monad testnet (or an RPC_URL override such as anvil).
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import dotenv from "dotenv";
import { createPublicClient, createWalletClient, defineChain, http, type Address, type Chain, type Hash, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const here = dirname(fileURLToPath(import.meta.url));
export const AGG_DIR = resolve(here, "..");
dotenv.config({ path: resolve(AGG_DIR, "../.env") });

export const MONAD_TESTNET_RPC = "https://testnet-rpc.monad.xyz";
export const MONAD_EXPLORER = "https://testnet.monadexplorer.com";

export interface Deployments {
  chainId: number;
  naiveLane: Address;
  aggregator: Address;
  factory?: Address;
  explorer: string;
}

export function loadDeployments(): Deployments {
  const p = process.env.DEPLOYMENTS ? resolve(process.env.DEPLOYMENTS) : resolve(AGG_DIR, "deployments.json");
  if (!existsSync(p)) throw new Error(`missing ${p} ({chainId, naiveLane, aggregator, explorer})`);
  return JSON.parse(readFileSync(p, "utf8")) as Deployments;
}

/** opts override the env (RPC_URL, KEY_VAR) so one process can hold clients for several keys or nodes. */
export async function getClients(opts: { rpc?: string; privateKey?: Hex; keyVar?: string } = {}) {
  const rpc = opts.rpc ?? process.env.RPC_URL ?? MONAD_TESTNET_RPC;
  // KEY_VAR names the env var holding the key (default PRIVATE_KEY), so parallel runs can use separate keys.
  const keyVar = opts.keyVar ?? process.env.KEY_VAR ?? "PRIVATE_KEY";
  const pk = opts.privateKey ?? process.env[keyVar];
  if (!pk) throw new Error(`${keyVar} not set (root .env)`);
  const account = privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`) as Hex);

  let chainId = 10143;
  if (rpc !== MONAD_TESTNET_RPC) {
    const probe = createPublicClient({ transport: http(rpc) });
    chainId = await probe.getChainId();
  }
  const isMonad = chainId === 10143;
  const chain: Chain = defineChain({
    id: chainId,
    name: isMonad ? "Monad Testnet" : `Local ${chainId}`,
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
    blockExplorers: isMonad ? { default: { name: "Monad Explorer", url: MONAD_EXPLORER } } : undefined,
  });
  // Shared public RPCs rate-limit (HTTP 429); RPC_RETRY_COUNT / RPC_RETRY_DELAY_MS widen viem's retry backoff.
  const transport = http(rpc, { retryCount: Number(process.env.RPC_RETRY_COUNT ?? 3), retryDelay: Number(process.env.RPC_RETRY_DELAY_MS ?? 150) });
  const publicClient = createPublicClient({ chain, transport });
  const raw = createWalletClient({ chain, account, transport });
  // Monad's RPC gas estimates can come back too tight (a first-run submitBatch ran out of gas on
  // testnet), so every contract write gets a 30% gas buffer unless the caller sets gas itself.
  const writeContract = (async (args: any) => {
    const gas = args.gas ?? ((await publicClient.estimateContractGas({ ...args, account })) * 13n) / 10n;
    return raw.writeContract({ ...args, gas });
  }) as typeof raw.writeContract;
  const walletClient = { ...raw, writeContract } as typeof raw;
  return { chain, chainId, account, publicClient, walletClient, rpc };
}

export function txLink(explorer: string | undefined, hash: Hash): string {
  return explorer ? `${explorer.replace(/\/$/, "")}/tx/${hash}` : hash;
}
