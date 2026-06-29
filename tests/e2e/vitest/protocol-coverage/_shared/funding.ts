/**
 * Native-gas + ERC20-balance preflights for protocol-coverage tests (KEEP-458).
 *
 * The setup workflow itself can't fund the wallet that signs its own
 * transactions, so this helper runs as a TS preflight in `beforeAll`. Logic is
 * lifted from `scripts/miscellaneous/fund-test-wallet.ts:84-126` and
 * parameterised on chainId so it works across testnets and mainnet forks.
 *
 * Two provisioning paths:
 *   - Testnet (TESTNET_FUNDER_PK): real EOA sends native gas and calls faucet
 *     contracts to mint ERC20s. Used on Sepolia.
 *   - Fork mode (FORK_CHAIN_IDS): anvil cheatcodes provision balances without
 *     a funded EOA. ensureNativeGas calls anvil_setBalance; ensureErc20Acquired
 *     delegates to ensureErc20OnFork which impersonates a whale. Used on
 *     mainnet forks (chain 1).
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { ethers } from "ethers";
import postgres from "postgres";
import { getDatabaseUrl } from "@/lib/db/connection-utils";
import { chains } from "@/lib/db/schema";
import {
  FORK_CHAIN_IDS,
  FORK_WHALES,
  FAUCETS,
  FUND_NATIVE_AMOUNT_WEI_BY_CHAIN,
  MIN_NATIVE_BALANCE_WEI_BY_CHAIN,
  TESTNET_FUNDER_PK_ENV,
  TOKEN_REGISTRY,
  type TokenSymbol,
} from "@/lib/test-data/chain-test-data";

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

// chains.defaultPrimaryRpc is bootstrap-time data; memoize per process so a
// test session opening 3+ helpers (ensureNativeGas + one per requiredTokens)
// pays one Postgres round-trip per chain on the first miss and zero on every
// subsequent hit. Each miss still opens a short-lived client (closed in the
// finally below); a module-scope client would shave the connection setup but
// would have to be torn down by test hooks, which is more coupling than the
// saved round-trip is worth here.
const RPC_URL_CACHE = new Map<string, string>();

async function getChainRpcUrl(chainId: string): Promise<string> {
  const cached = RPC_URL_CACHE.get(chainId);
  if (cached) {
    return cached;
  }
  const client = postgres(getDatabaseUrl(), { max: 1 });
  try {
    const db = drizzle(client);
    const [row] = await db
      .select({ rpc: chains.defaultPrimaryRpc })
      .from(chains)
      .where(eq(chains.chainId, Number(chainId)))
      .limit(1);
    if (!row?.rpc) {
      throw new Error(`No RPC URL configured for chain ${chainId} in DB`);
    }
    RPC_URL_CACHE.set(chainId, row.rpc);
    return row.rpc;
  } finally {
    await client.end();
  }
}

/**
 * Top up the test wallet on `chainId` with native gas if its balance falls
 * below the chain's minimum.
 *
 * Fork-mode chains (FORK_CHAIN_IDS): uses anvil_setBalance to set the balance
 * directly — no funder EOA required.
 * Testnet chains: sends a real transaction from the TESTNET_FUNDER_PK EOA.
 */
export async function ensureNativeGas(
  chainId: string,
  address: string
): Promise<void> {
  const minWei = MIN_NATIVE_BALANCE_WEI_BY_CHAIN[chainId];
  const topUpWei = FUND_NATIVE_AMOUNT_WEI_BY_CHAIN[chainId];
  if (minWei === undefined || topUpWei === undefined) {
    throw new Error(
      `chain ${chainId} missing entry in MIN_NATIVE_BALANCE_WEI_BY_CHAIN / FUND_NATIVE_AMOUNT_WEI_BY_CHAIN (lib/test-data/chain-test-data.ts)`
    );
  }

  const rpcUrl = await getChainRpcUrl(chainId);
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const balance = await provider.getBalance(address);
  if (balance >= minWei) {
    return;
  }

  if (FORK_CHAIN_IDS.has(chainId)) {
    // anvil_setBalance sets the balance to an absolute value in hex wei.
    await provider.send("anvil_setBalance", [
      address,
      "0x" + topUpWei.toString(16),
    ]);
    return;
  }

  const funderPk = process.env[TESTNET_FUNDER_PK_ENV];
  if (!funderPk) {
    throw new Error(
      `${TESTNET_FUNDER_PK_ENV} not set; cannot top up native gas on chain ${chainId}`
    );
  }

  const funder = new ethers.Wallet(funderPk, provider);
  const funderBalance = await provider.getBalance(funder.address);
  if (funderBalance < topUpWei) {
    throw new Error(
      `funder ${funder.address} has ${ethers.formatEther(funderBalance)} on chain ${chainId}; need >= ${ethers.formatEther(topUpWei)}`
    );
  }
  const tx = await funder.sendTransaction({ to: address, value: topUpWei });
  await tx.wait();
}

export type AbiInput = { name: string; type: string };
export type AbiFunction = {
  type: string;
  name: string;
  stateMutability?: string;
  inputs: AbiInput[];
  outputs?: AbiInput[];
};

/**
 * Bind a faucet ABI's named inputs to concrete values. Recognises three
 * conventions (case-insensitive):
 *   - `token` -> the token's address
 *   - `to` / `recipient` -> the recipient wallet
 *   - `amount` / `value` -> amount in wei
 * Throws if any input cannot be resolved, so a malformed FAUCET entry fails
 * loudly at the start of a test session rather than mid-run.
 *
 * Exported for unit coverage in tests/unit/faucet-args.test.ts.
 */
export function bindFaucetArgs(
  fn: AbiFunction,
  tokenAddress: string,
  recipient: string,
  amountWei: bigint
): unknown[] {
  return fn.inputs.map((input) => {
    const name = input.name.toLowerCase();
    if (name === "token") {
      return tokenAddress;
    }
    if (name === "to" || name === "recipient") {
      return recipient;
    }
    if (name === "amount" || name === "value") {
      return amountWei;
    }
    throw new Error(
      `FAUCET mint ABI has unsupported input "${input.name}" of type "${input.type}". ` +
        "Update bindFaucetArgs in tests/e2e/vitest/protocol-coverage/_shared/funding.ts."
    );
  });
}

/**
 * Fork-mode ERC20 provisioning via whale impersonation.
 *
 * Impersonates a whale account on the anvil fork, transfers the needed tokens
 * to the test wallet, then stops impersonation. The whale address is looked up
 * from FORK_WHALES in chain-test-data.ts.
 *
 * Only called from ensureErc20Acquired when FORK_CHAIN_IDS.has(chainId).
 */
async function ensureErc20OnFork(
  chainId: string,
  walletAddress: string,
  symbol: TokenSymbol,
  human: string
): Promise<void> {
  const tokenEntry = TOKEN_REGISTRY[chainId]?.[symbol];
  if (!tokenEntry) {
    throw new Error(
      `TOKEN_REGISTRY missing ${symbol} on chain ${chainId}; cannot acquire on fork.`
    );
  }

  const whale = FORK_WHALES[chainId]?.[symbol];
  if (!whale) {
    throw new Error(
      `FORK_WHALES missing ${symbol} on chain ${chainId}. Add a whale address to lib/test-data/chain-test-data.ts.`
    );
  }

  const needed = ethers.parseUnits(human, tokenEntry.decimals);
  const rpcUrl = await getChainRpcUrl(chainId);
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  const token = new ethers.Contract(tokenEntry.address, ERC20_ABI, provider);
  const balance: bigint = await token.balanceOf(walletAddress);
  if (balance >= needed) {
    return;
  }
  const gap = needed - balance;

  await provider.send("anvil_impersonateAccount", [whale.address]);
  try {
    const whaleSigner = await provider.getSigner(whale.address);
    const tokenAsWhale = new ethers.Contract(
      tokenEntry.address,
      ERC20_ABI,
      whaleSigner
    );
    const tx = await tokenAsWhale.transfer(walletAddress, gap);
    await tx.wait();
  } finally {
    await provider.send("anvil_stopImpersonatingAccount", [whale.address]);
  }
}

/**
 * Top up the wallet's ERC20 balance when the existing balance is short.
 * Returns silently when balance is sufficient.
 *
 * Fork-mode chains: delegates to ensureErc20OnFork (whale impersonation).
 * Testnet chains: mints via FAUCETS entries signed by the TESTNET_FUNDER_PK EOA.
 *
 * Throws when no acquisition path exists for (chain, symbol).
 */
export async function ensureErc20Acquired(
  chainId: string,
  walletAddress: string,
  symbol: TokenSymbol,
  human: string
): Promise<void> {
  if (FORK_CHAIN_IDS.has(chainId)) {
    await ensureErc20OnFork(chainId, walletAddress, symbol, human);
    return;
  }

  const tokenEntry = TOKEN_REGISTRY[chainId]?.[symbol];
  if (!tokenEntry) {
    throw new Error(
      `TOKEN_REGISTRY missing ${symbol} on chain ${chainId}; cannot acquire.`
    );
  }
  const needed = ethers.parseUnits(human, tokenEntry.decimals);

  const rpcUrl = await getChainRpcUrl(chainId);
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const token = new ethers.Contract(tokenEntry.address, ERC20_ABI, provider);
  const balance: bigint = await token.balanceOf(walletAddress);
  if (balance >= needed) {
    return;
  }

  const faucet = FAUCETS[chainId]?.[symbol];
  if (!faucet) {
    throw new Error(
      `manual provisioning required: wallet ${walletAddress} holds ${ethers.formatUnits(balance, tokenEntry.decimals)} ${symbol} on chain ${chainId}; need >= ${human}. No FAUCETS entry. Acquire via faucet/transfer then retry.`
    );
  }

  const funderPk = process.env[TESTNET_FUNDER_PK_ENV];
  if (!funderPk) {
    throw new Error(
      `${TESTNET_FUNDER_PK_ENV} not set; cannot mint ${symbol} on chain ${chainId} via FAUCETS.`
    );
  }
  const funder = new ethers.Wallet(funderPk, provider);

  const abi = JSON.parse(faucet.abi) as AbiFunction[];
  const fn = abi.find((entry) => entry.name === faucet.functionName);
  if (!fn) {
    throw new Error(
      `FAUCETS[${chainId}][${symbol}].abi missing function "${faucet.functionName}".`
    );
  }
  // Mint the gap, not the full target -- a previous run may have left a
  // partial balance, and over-minting wastes faucet quota (Aave Sepolia
  // caps each call at MAX_MINT_AMOUNT). `balance < needed` is guaranteed
  // by the early-return above, so `gap` is always positive.
  const gap = needed - balance;
  const args = bindFaucetArgs(fn, tokenEntry.address, walletAddress, gap);

  const contract = new ethers.Contract(faucet.contract, abi, funder);
  const tx = await contract[faucet.functionName](...args);
  await tx.wait();
}
