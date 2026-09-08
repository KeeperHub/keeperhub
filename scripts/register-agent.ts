/**
 * Idempotent ERC-8004 identity registration script for KeeperHub
 *
 * Mints the KeeperHub identity NFT on Ethereum mainnet by calling register(agentURI)
 * on the ERC-8004 Identity Registry. Checks the DB first -- if a registration row
 * already exists, exits 0 without sending any transaction.
 *
 * Requires:
 *   REGISTRATION_PRIVATE_KEY - Private key of a funded Ethereum mainnet EOA (~0.003 ETH for gas)
 *   DATABASE_URL              - Database connection string
 *   CHAIN_ETH_MAINNET_PRIMARY_RPC - (recommended) Paid RPC endpoint (Alchemy/Infura)
 *
 * Run with: npx tsx scripts/register-agent.ts
 */

import "dotenv/config";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { ethers } from "ethers";
import postgres from "postgres";
import {
  ERC_8004_IDENTITY_REGISTRY_ADDRESS,
  ETHEREUM_MAINNET_CHAIN_ID,
} from "../lib/agentic-wallet/constants";
import { getDatabaseUrl } from "../lib/db/connection-utils";
import { agentRegistrations } from "../lib/db/schema";
import { getRpcUrlByChainId } from "../lib/rpc/rpc-config";
import { formatSanitizedRpcError } from "../lib/rpc/sanitize-rpc-error";

export const IDENTITY_REGISTRY_ADDRESS = ERC_8004_IDENTITY_REGISTRY_ADDRESS;
export const AGENT_URI = "https://app.keeperhub.com/api/agent-registry";
export const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const IDENTITY_REGISTRY_ABI = [
  {
    inputs: [{ name: "agentURI", type: "string" }],
    name: "register",
    outputs: [{ name: "agentId", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

type TransactionLike = {
  hash: string;
  wait: () => Promise<ReceiptLike>;
};

type ReceiptLike = {
  status: number | null;
  logs: Array<{ topics: string[]; address: string }>;
};

type ContractLike = {
  register: (uri: string) => Promise<TransactionLike>;
};

type ProviderLike = {
  getBalance: (address: string) => Promise<bigint>;
};

type WalletLike = {
  address: string;
};

// Conservative floor for ERC-8004 register() on mainnet. Real cost is ~0.003
// ETH; this guards against the script silently failing mid-tx on a wallet
// that's nearly empty.
const MIN_BALANCE_WEI = BigInt("5000000000000000"); // 0.005 ETH

type DbLike = {
  select: () => {
    from: (table: unknown) => {
      where: (filter: unknown) => { limit: (n: number) => Promise<unknown[]> };
    };
  };
  insert: (table: unknown) => { values: (data: unknown) => Promise<void> };
};

const TARGET_CHAIN_ID = ETHEREUM_MAINNET_CHAIN_ID;

export type RegisterDeps = {
  db: DbLike;
  buildContract: (address: string, abi: unknown, wallet: unknown) => ContractLike;
  buildProvider: (rpcUrl: string) => ProviderLike;
  buildWallet: (privateKey: string, provider: unknown) => WalletLike;
};

export type RegisterResult =
  | { alreadyRegistered: true; agentId: string }
  | { agentId: string; txHash: string };

export async function registerAgent(deps?: RegisterDeps): Promise<RegisterResult> {
  const privateKey = process.env.REGISTRATION_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("REGISTRATION_PRIVATE_KEY environment variable is required");
  }

  let db: DbLike;
  let buildContract: RegisterDeps["buildContract"];
  let buildProvider: RegisterDeps["buildProvider"];
  let buildWallet: RegisterDeps["buildWallet"];
  let client: ReturnType<typeof postgres> | null = null;

  if (deps) {
    db = deps.db;
    buildContract = deps.buildContract;
    buildProvider = deps.buildProvider;
    buildWallet = deps.buildWallet;
  } else {
    const databaseUrl = getDatabaseUrl();
    client = postgres(databaseUrl, { max: 1 });
    db = drizzle(client) as unknown as DbLike;
    buildContract = (address, _abi, wallet) =>
      // biome-ignore lint/suspicious/noExplicitAny: ethers Contract ABI param accepts many forms; cast needed for DI pattern
      new ethers.Contract(address, IDENTITY_REGISTRY_ABI as any, wallet as ethers.ContractRunner) as unknown as ContractLike;
    buildProvider = (rpcUrl) => new ethers.JsonRpcProvider(rpcUrl);
    buildWallet = (pk, provider) =>
      new ethers.Wallet(pk, provider as ethers.JsonRpcProvider);
  }

  try {
    // Idempotency is keyed on (chainId, registryAddress) so the script can be
    // safely re-run for a different chain or a different registry contract
    // without short-circuiting on an unrelated previous registration.
    const rows = await db
      .select()
      .from(agentRegistrations)
      .where(
        and(
          eq(agentRegistrations.chainId, TARGET_CHAIN_ID),
          eq(agentRegistrations.registryAddress, IDENTITY_REGISTRY_ADDRESS)
        )
      )
      .limit(1);
    const existing = (rows[0] as { agentId: string; txHash: string } | undefined) ?? null;

    if (existing) {
      console.log(
        `Already registered: agentId=${existing.agentId}, txHash=${existing.txHash}`
      );
      return { alreadyRegistered: true, agentId: existing.agentId };
    }

    const rpcUrl = getRpcUrlByChainId(1);
    const provider = buildProvider(rpcUrl);
    const wallet = buildWallet(privateKey, provider);
    const registry = buildContract(
      IDENTITY_REGISTRY_ADDRESS,
      IDENTITY_REGISTRY_ABI,
      wallet
    );

    // Preflight: fail fast on insufficient balance instead of bombing out
    // halfway through the register() call with a confusing ethers error.
    const balance = await provider.getBalance(wallet.address);
    if (balance < MIN_BALANCE_WEI) {
      throw new Error(
        `Wallet ${wallet.address} has insufficient balance: ${balance} wei (minimum ${MIN_BALANCE_WEI} wei / 0.005 ETH required for gas)`
      );
    }

    console.log(`Registering KeeperHub agent at ${AGENT_URI}...`);
    const tx = await registry.register(AGENT_URI);
    console.log(`Transaction sent: ${tx.hash}`);

    const receipt = await tx.wait();

    // ethers v6 throws on revert in most cases, but explicitly assert receipt
    // status so a status=0 receipt produces a clear "reverted" error instead
    // of falling through to a misleading "Transfer event not found" message.
    if (receipt.status !== 1) {
      throw new Error(
        `Transaction ${tx.hash} reverted on-chain (receipt status=${receipt.status})`
      );
    }

    const transferLog = receipt.logs.find(
      (log) =>
        log.topics[0] === TRANSFER_TOPIC &&
        log.topics.length === 4 &&
        log.address.toLowerCase() === IDENTITY_REGISTRY_ADDRESS.toLowerCase()
    );

    if (!transferLog) {
      throw new Error("ERC-721 Transfer event not found in transaction receipt");
    }

    const tokenIdTopic = transferLog.topics[3];
    if (!tokenIdTopic) {
      throw new Error("Transfer event missing tokenId topic");
    }

    const agentId = BigInt(tokenIdTopic).toString();

    await db.insert(agentRegistrations).values({
      agentId,
      txHash: tx.hash,
      chainId: TARGET_CHAIN_ID,
      registryAddress: IDENTITY_REGISTRY_ADDRESS,
    });

    console.log(`Registration complete: agentId=${agentId}, txHash=${tx.hash}`);
    return { agentId, txHash: tx.hash };
  } finally {
    if (client) {
      await client.end();
    }
  }
}

async function main(): Promise<void> {
  try {
    await registerAgent();
  } catch (err) {
    console.error("Registration failed:", formatSanitizedRpcError(err));
    process.exit(1);
  }
}

// Only execute when run directly (not when imported in tests)
const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("register-agent.ts") ||
    process.argv[1].endsWith("register-agent.js"));

if (isMain) {
  main();
}
