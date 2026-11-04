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
  explorer: string;
}

export function loadDeployments(): Deployments {
  const p = process.env.DEPLOYMENTS ? resolve(process.env.DEPLOYMENTS) : resolve(AGG_DIR, "deployments.json");
  if (!existsSync(p)) throw new Error(`missing ${p} ({chainId, naiveLane, aggregator, explorer})`);
  return JSON.parse(readFileSync(p, "utf8")) as Deployments;
}

export async function getClients() {
  const rpc = process.env.RPC_URL ?? MONAD_TESTNET_RPC;
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error("PRIVATE_KEY not set (root .env)");
  const account = privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`) as Hex);

  let chainId = 10143;
  if (process.env.RPC_URL) {
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
  const publicClient = createPublicClient({ chain, transport: http(rpc) });
  const walletClient = createWalletClient({ chain, account, transport: http(rpc) });
  return { chain, chainId, account, publicClient, walletClient, rpc };
}

export function txLink(explorer: string | undefined, hash: Hash): string {
  return explorer ? `${explorer.replace(/\/$/, "")}/tx/${hash}` : hash;
}
