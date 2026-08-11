/**
 * Native-gas + ERC20-balance preflights for protocol-coverage tests (KEEP-458).
 *
 * The setup workflow itself can't fund the wallet that signs its own
 * transactions, so this helper runs as a TS preflight in `beforeAll`. Logic is
 * lifted from `scripts/miscellaneous/fund-test-wallet.ts:84-126` and
 * parameterised on chainId so it works across testnets and mainnet forks.
 *
 * Two provisioning paths:
 *   - Live chain (TESTNET_FUNDER_PK): real EOA sends native gas and calls
 *     faucet contracts to mint ERC20s. Used on Base (ajna, reads only).
 *   - Fork mode (FORK_CHAIN_IDS): anvil cheatcodes provision balances without
 *     a funded EOA. ensureNativeGas calls anvil_setBalance; ERC20s come from
 *     whale impersonation (FORK_WHALES), a permissionless faucet mint
 *     impersonating the wallet (FAUCETS), or - when neither exists - direct
 *     balances-slot fabrication via anvil_setStorageAt (fabricate-state.ts).
 *     Used on the mainnet fork (chain 1) and the Sepolia fork
 *     (chain 11155111) in CI.
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { ethers } from "ethers";
import postgres from "postgres";
import { getDatabaseUrl } from "@/lib/db/connection-utils";
import { chains } from "@/lib/db/schema";
import { getProtocol } from "@/lib/protocol-registry";
import { resolveBinding } from "@/lib/test-data/build-workflow";
import {
  FAUCETS,
  FORK_CHAIN_IDS,
  FORK_WHALES,
  FUND_NATIVE_AMOUNT_WEI_BY_CHAIN,
  MIN_NATIVE_BALANCE_WEI_BY_CHAIN,
  TESTNET_FUNDER_PK_ENV,
  TOKEN_REGISTRY,
  type TokenSymbol,
} from "@/lib/test-data/chain-test-data";
import {
  fabricateElapsedCooldown,
  fabricateErc20Allowance,
  fabricateErc20Balance,
} from "./fabricate-state";

export const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

/**
 * Run `fn` with `address` impersonated on an anvil fork, guaranteeing
 * anvil_stopImpersonatingAccount runs even when the callback throws.
 * Shared by the fork provisioning paths below and the Tier 1 simulation
 * harness so the impersonate/stop bracket cannot drift between copies.
 */
export async function withImpersonation<T>(
  provider: ethers.JsonRpcProvider,
  address: string,
  fn: (signer: ethers.JsonRpcSigner) => Promise<T>
): Promise<T> {
  await provider.send("anvil_impersonateAccount", [address]);
  try {
    return await fn(await provider.getSigner(address));
  } finally {
    await provider.send("anvil_stopImpersonatingAccount", [address]);
  }
}

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
      `0x${topUpWei.toString(16)}`,
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

/**
 * Run a protocol's fork-only impersonated provisioning calls
 * (`setup.forkImpersonatedCalls`), e.g. an authed ward kissing the test
 * wallet on a toll-gated Chronicle feed. Shared by the coverage
 * preflight (runSetup) and the Tier 1 simulation harness so the
 * impersonation semantics cannot drift between tiers.
 *
 * Throws when the spec is declared on a non-fork chain: impersonation
 * is an anvil cheatcode, and silently skipping would let gated fixtures
 * fail far downstream (or pass vacuously).
 */
export async function runForkImpersonatedCalls(
  protocolSlug: string,
  chainId: string,
  walletAddress: string,
  /** Fork RPC endpoint for DB-less callers (the simulation tier);
   *  defaults to the chains-table lookup the coverage suites use. */
  rpcUrlOverride?: string
): Promise<void> {
  const protocol = getProtocol(protocolSlug);
  const calls = protocol?.testData?.[chainId]?.setup?.forkImpersonatedCalls;
  if (!(protocol && calls) || calls.length === 0) {
    return;
  }
  if (!(FORK_CHAIN_IDS.has(chainId) || rpcUrlOverride)) {
    throw new Error(
      `${protocolSlug} declares forkImpersonatedCalls on chain ${chainId}, which is not in FORK_CHAIN_IDS; impersonation only exists on anvil forks.`
    );
  }
  const rpcUrl = rpcUrlOverride ?? (await getChainRpcUrl(chainId));
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  for (const call of calls) {
    const to = resolveBinding(
      call.contract,
      "address",
      protocol,
      chainId,
      walletAddress
    );
    const abi = JSON.parse(call.abi) as AbiFunction[];
    const fn = abi.find((entry) => entry.name === call.functionName);
    if (!fn) {
      throw new Error(
        `${protocolSlug}: forkImpersonatedCalls ABI missing function "${call.functionName}"`
      );
    }
    const args = call.args.map((arg, i) =>
      resolveBinding(arg, fn.inputs[i]?.type, protocol, chainId, walletAddress)
    );
    // Impersonated senders are privileged accounts (often contracts)
    // chosen for authority, not ETH balance; fund their gas.
    await provider.send("anvil_setBalance", [
      call.impersonate,
      "0x8ac7230489e80000",
    ]);
    await withImpersonation(provider, call.impersonate, async (signer) => {
      const target = new ethers.Contract(to, [fn], signer);
      const tx = await target[call.functionName](...args);
      const receipt = await tx.wait();
      if (receipt?.status !== 1) {
        throw new Error(
          `${protocolSlug}: impersonated ${call.functionName} on ${to} reverted`
        );
      }
    });
  }
}

/**
 * Run a protocol action's declared pre-execution state fabrications
 * (`testData.fabrications[actionSlug]`) - cheatcode rewrites of
 * on-chain preconditions the setup phase cannot buy or sequence, e.g.
 * marking the wallet's real sUSDe cooldown as elapsed so unstake can run
 * without waiting out the cooldown period. Shared by the Tier 1
 * simulation harness and the Tier 2 coverage runner so the fabrication
 * semantics cannot drift between tiers. No-op when the action declares
 * none; throws on a non-fork chain, same as runForkImpersonatedCalls.
 */
export async function runActionFabrications(
  protocolSlug: string,
  chainId: string,
  walletAddress: string,
  actionSlug: string,
  /** Fork RPC endpoint for DB-less callers (the simulation tier);
   *  defaults to the chains-table lookup the coverage suites use. */
  rpcUrlOverride?: string
): Promise<void> {
  const protocol = getProtocol(protocolSlug);
  const specs = protocol?.testData?.[chainId]?.fabrications?.[actionSlug];
  if (!(protocol && specs) || specs.length === 0) {
    return;
  }
  if (!(FORK_CHAIN_IDS.has(chainId) || rpcUrlOverride)) {
    throw new Error(
      `${protocolSlug}/${actionSlug} declares fabrications on chain ${chainId}, which is not in FORK_CHAIN_IDS; state fabrication only exists on anvil forks.`
    );
  }
  const rpcUrl = rpcUrlOverride ?? (await getChainRpcUrl(chainId));
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  for (const spec of specs) {
    const target = resolveBinding(
      spec.contract,
      "address",
      protocol,
      chainId,
      walletAddress
    );
    await fabricateElapsedCooldown(provider, target, walletAddress);
  }
}

/**
 * Fabricate a protocol's fork-only setup allowances
 * (`setup.fabricatedApprovals`) with anvil_setStorageAt, so the setup
 * phase never submits a slow approve-token transaction. Shared by the
 * Tier 1 simulation harness and the Tier 2 coverage preflight so the
 * allowance provisioning cannot drift between tiers. No-op when the
 * protocol declares none; throws on a non-fork chain, same as
 * runForkImpersonatedCalls.
 */
export async function runFabricatedApprovals(
  protocolSlug: string,
  chainId: string,
  walletAddress: string,
  /** Fork RPC endpoint for DB-less callers (the simulation tier);
   *  defaults to the chains-table lookup the coverage suites use. */
  rpcUrlOverride?: string
): Promise<void> {
  const protocol = getProtocol(protocolSlug);
  const approvals = protocol?.testData?.[chainId]?.setup?.fabricatedApprovals;
  if (!(protocol && approvals) || approvals.length === 0) {
    return;
  }
  if (!(FORK_CHAIN_IDS.has(chainId) || rpcUrlOverride)) {
    throw new Error(
      `${protocolSlug} declares fabricatedApprovals on chain ${chainId}, which is not in FORK_CHAIN_IDS; storage fabrication only exists on anvil forks.`
    );
  }
  const rpcUrl = rpcUrlOverride ?? (await getChainRpcUrl(chainId));
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  for (const approval of approvals) {
    const tokenEntry = TOKEN_REGISTRY[chainId]?.[approval.token];
    if (!tokenEntry) {
      throw new Error(
        `TOKEN_REGISTRY missing ${approval.token} on chain ${chainId}; cannot fabricate approval.`
      );
    }
    const spender = resolveBinding(
      approval.spender,
      "address",
      protocol,
      chainId,
      walletAddress
    );
    await fabricateErc20Allowance(
      provider,
      tokenEntry.address,
      walletAddress,
      spender,
      ethers.parseUnits(approval.human, tokenEntry.decimals)
    );
  }
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
  human: string,
  rpcUrlOverride?: string
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
  const rpcUrl = rpcUrlOverride ?? (await getChainRpcUrl(chainId));
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  const token = new ethers.Contract(tokenEntry.address, ERC20_ABI, provider);
  const balance: bigint = await token.balanceOf(walletAddress);
  if (balance >= needed) {
    return;
  }
  const gap = needed - balance;

  // Whales are chosen for token balance, not ETH; fund their gas.
  await provider.send("anvil_setBalance", [
    whale.address,
    "0x8ac7230489e80000",
  ]);
  await withImpersonation(provider, whale.address, async (whaleSigner) => {
    const tokenAsWhale = new ethers.Contract(
      tokenEntry.address,
      ERC20_ABI,
      whaleSigner
    );
    const tx = await tokenAsWhale.transfer(walletAddress, gap);
    await tx.wait();
  });
}

/**
 * Fork-mode ERC20 provisioning via a permissionless faucet mint.
 *
 * For tokens with a FAUCETS entry whose mint is permissionless (e.g. the
 * Superfluid Sepolia fUSDC), no whale is needed on a fork: impersonate the
 * recipient wallet itself and call the faucet from it. The wallet already
 * holds native gas from ensureNativeGas (runSetup funds gas before tokens).
 */
async function mintViaFaucetOnFork(
  chainId: string,
  walletAddress: string,
  symbol: TokenSymbol,
  human: string,
  rpcUrlOverride?: string
): Promise<void> {
  const tokenEntry = TOKEN_REGISTRY[chainId]?.[symbol];
  if (!tokenEntry) {
    throw new Error(
      `TOKEN_REGISTRY missing ${symbol} on chain ${chainId}; cannot mint on fork.`
    );
  }
  const faucet = FAUCETS[chainId]?.[symbol];
  if (!faucet) {
    throw new Error(
      `FAUCETS missing ${symbol} on chain ${chainId}; cannot mint on fork.`
    );
  }

  const needed = ethers.parseUnits(human, tokenEntry.decimals);
  const rpcUrl = rpcUrlOverride ?? (await getChainRpcUrl(chainId));
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const token = new ethers.Contract(tokenEntry.address, ERC20_ABI, provider);
  const balance: bigint = await token.balanceOf(walletAddress);
  if (balance >= needed) {
    return;
  }
  const gap = needed - balance;

  const abi = JSON.parse(faucet.abi) as AbiFunction[];
  const fn = abi.find((entry) => entry.name === faucet.functionName);
  if (!fn) {
    throw new Error(
      `FAUCETS[${chainId}][${symbol}].abi missing function "${faucet.functionName}".`
    );
  }
  const args = bindFaucetArgs(fn, tokenEntry.address, walletAddress, gap);

  await withImpersonation(provider, walletAddress, async (signer) => {
    const contract = new ethers.Contract(faucet.contract, abi, signer);
    const tx = await contract[faucet.functionName](...args);
    await tx.wait();
  });
}

/**
 * Top up the wallet's ERC20 balance when the existing balance is short.
 * Returns silently when balance is sufficient.
 *
 * Fork-mode chains: whale impersonation (FORK_WHALES) when a whale is
 * registered, otherwise a permissionless faucet mint impersonating the
 * wallet itself (FAUCETS). Live testnet chains: FAUCETS entries signed by
 * the TESTNET_FUNDER_PK EOA.
 *
 * Throws when no acquisition path exists for (chain, symbol).
 */
export async function ensureErc20Acquired(
  chainId: string,
  walletAddress: string,
  symbol: TokenSymbol,
  human: string,
  /** Fork RPC endpoint for DB-less callers (the simulation tier);
   *  defaults to the chains-table lookup the coverage suites use. */
  rpcUrlOverride?: string
): Promise<void> {
  // An override asserts "this endpoint is a fork": only cheatcode-based
  // provisioning may run against it. Falling through to the live branch
  // would silently ignore the override (DB lookup, funder-signed txs).
  if (FORK_CHAIN_IDS.has(chainId) || rpcUrlOverride) {
    if (FORK_WHALES[chainId]?.[symbol]) {
      await ensureErc20OnFork(
        chainId,
        walletAddress,
        symbol,
        human,
        rpcUrlOverride
      );
      return;
    }
    if (FAUCETS[chainId]?.[symbol]) {
      await mintViaFaucetOnFork(
        chainId,
        walletAddress,
        symbol,
        human,
        rpcUrlOverride
      );
      return;
    }
    // No whale and no faucet: write the balance into the token's
    // balances-mapping slot directly (probed and verified against
    // balanceOf; see fabricate-state.ts). Whales stay preferred where
    // registered - a real transfer exercises the token's own accounting -
    // but slot fabrication does not rot when a whale's balance drains
    // (the previously registered USDS PSM whale emptied by 2026-07-08).
    const tokenEntry = TOKEN_REGISTRY[chainId]?.[symbol];
    if (!tokenEntry) {
      throw new Error(
        `TOKEN_REGISTRY missing ${symbol} on chain ${chainId}; cannot fabricate on fork.`
      );
    }
    const provider = new ethers.JsonRpcProvider(
      rpcUrlOverride ?? (await getChainRpcUrl(chainId))
    );
    await fabricateErc20Balance(
      provider,
      tokenEntry.address,
      walletAddress,
      ethers.parseUnits(human, tokenEntry.decimals)
    );
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
