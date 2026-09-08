import "server-only";

import { ethers } from "ethers";
import { rolesAbi } from "zodiac-roles-sdk";
import { getRpcProviderFromUrls } from "@/lib/rpc/provider-factory";
import { getRpcUrlByChainId } from "@/lib/rpc/rpc-config";

/**
 * Read-only helpers that query the live on-chain state of a Safe's Zodiac
 * Roles Modifier. Used by the UI to reconcile the DB cache, and by the
 * orchestrator to decide whether an install/diff is still needed.
 */

const SAFE_MODULES_ABI = [
  "function isModuleEnabled(address module) view returns (bool)",
  "function getModulesPaginated(address start, uint256 pageSize) view returns (address[] modules, address next)",
] as const;

const MODULE_SENTINEL: string = "0x0000000000000000000000000000000000000001";

async function getProvider(chainId: number): Promise<ethers.Provider> {
  const rpcUrl = getRpcUrlByChainId(chainId, "primary");
  const manager = await getRpcProviderFromUrls(rpcUrl, undefined, chainId);
  return manager.getProvider();
}

/** Whether a given module address is currently enabled on a Safe. */
export async function isModuleEnabled(options: {
  chainId: number;
  safeAddress: string;
  moduleAddress: string;
}): Promise<boolean> {
  const provider = await getProvider(options.chainId);
  const contract = new ethers.Contract(
    options.safeAddress,
    SAFE_MODULES_ABI,
    provider
  );
  return (await contract.isModuleEnabled(options.moduleAddress)) as boolean;
}

/** Full list of enabled modules on a Safe (paged through to completion). */
export async function getEnabledModules(options: {
  chainId: number;
  safeAddress: string;
}): Promise<string[]> {
  const provider = await getProvider(options.chainId);
  const contract = new ethers.Contract(
    options.safeAddress,
    SAFE_MODULES_ABI,
    provider
  );
  const collected: string[] = [];
  let cursor = MODULE_SENTINEL;
  // Paginate 25 at a time; Safes rarely have more than a handful of modules.
  for (let page = 0; page < 40; page += 1) {
    const [modules, next] = (await contract.getModulesPaginated(
      cursor,
      25
    )) as [string[], string];
    for (const m of modules) {
      collected.push(ethers.getAddress(m));
    }
    if (next === MODULE_SENTINEL || next === ethers.ZeroAddress) {
      break;
    }
    cursor = next;
  }
  return collected;
}

/**
 * On-chain allowance row. Mirrors the Allowance struct in Roles v2:
 *   struct Allowance { uint128 refill; uint128 maxRefill; uint64 period; uint128 balance; uint64 timestamp; }
 * `balance` is the remaining amount in the current period. `maxRefill` is
 * the period cap. `refill` is added per period up to maxRefill.
 */
export type ChainAllowance = {
  /** Remaining amount in the current period (decimals: token's decimals) */
  balanceWei: bigint;
  /** Cap per period */
  maxRefillWei: bigint;
  /** Refill per period */
  refillWei: bigint;
  /** Period in seconds */
  periodSeconds: bigint;
  /** Last refill timestamp (unix seconds) */
  timestamp: bigint;
};

const rolesInterface = new ethers.Interface(rolesAbi);

/**
 * Read a single allowance bucket from the modifier. Returns null if the
 * modifier doesn't have an allowance configured for the key.
 */
export async function readAllowance(options: {
  chainId: number;
  rolesModifierAddress: string;
  allowanceKey: string;
}): Promise<ChainAllowance | null> {
  const provider = await getProvider(options.chainId);
  const contract = new ethers.Contract(
    options.rolesModifierAddress,
    rolesInterface,
    provider
  );
  try {
    const raw = (await contract.allowances(options.allowanceKey)) as
      | readonly [bigint, bigint, bigint, bigint, bigint]
      | undefined;
    if (!raw) {
      return null;
    }
    const [refill, maxRefill, period, balance, timestamp] = raw;
    if (maxRefill === BigInt(0) && balance === BigInt(0)) {
      return null;
    }
    return {
      balanceWei: balance,
      maxRefillWei: maxRefill,
      refillWei: refill,
      periodSeconds: period,
      timestamp,
    };
  } catch {
    return null;
  }
}

/**
 * Projected remaining balance accounting for refills that have accrued since
 * the last on-chain `timestamp` but haven't been realised on-chain yet. The
 * modifier applies this math lazily when a call actually spends, so for a
 * visual "what's left right now" number we have to redo it client-side.
 */
export function projectAllowance(
  allowance: ChainAllowance,
  nowSeconds: bigint
): {
  remainingWei: bigint;
  usedWei: bigint;
  resetInSeconds: bigint | null;
} {
  const { balanceWei, maxRefillWei, refillWei, periodSeconds, timestamp } =
    allowance;

  if (periodSeconds === BigInt(0) || refillWei === BigInt(0)) {
    // One-shot allowance: never refills; just report current balance.
    return {
      remainingWei: balanceWei,
      usedWei:
        maxRefillWei > balanceWei ? maxRefillWei - balanceWei : BigInt(0),
      resetInSeconds: null,
    };
  }

  const elapsed = nowSeconds > timestamp ? nowSeconds - timestamp : BigInt(0);
  const periodsElapsed = elapsed / periodSeconds;
  const refilled = refillWei * periodsElapsed;
  const projectedBalance =
    balanceWei + refilled > maxRefillWei ? maxRefillWei : balanceWei + refilled;
  const remainingAfterPeriod = elapsed - periodsElapsed * periodSeconds;
  const resetInSeconds =
    projectedBalance < maxRefillWei
      ? periodSeconds - remainingAfterPeriod
      : null;

  return {
    remainingWei: projectedBalance,
    usedWei:
      maxRefillWei > projectedBalance
        ? maxRefillWei - projectedBalance
        : BigInt(0),
    resetInSeconds,
  };
}
