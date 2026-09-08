import "server-only";

import { ethers } from "ethers";
import {
  callsPlannedForApplyRole,
  encodeCalls,
  type Permission,
  processPermissions,
  type Role,
} from "zodiac-roles-sdk";
import { getRpcProviderFromUrls } from "@/lib/rpc/provider-factory";
import { getRpcUrlByChainId } from "@/lib/rpc/rpc-config";
import { buildExecTransactionCalldata } from "@/lib/safe/allowance-module";
import { getSafeContracts } from "@/lib/safe/contracts";
import { weiToUsd } from "@/lib/safe/price-oracle";
import {
  buildMultiSendCalldata,
  type MultiSendCall,
} from "@/lib/safe/zodiac-roles";
import { getGasStrategy } from "@/lib/web3/gas-strategy";

/**
 * Simulation helper. Given a *desired* Role state (target scopes + allowances)
 * and the Roles modifier's current Role, compute the Zodiac calls that would
 * bring it to the desired state, wrap them in a MultiSend, wrap that in a
 * Safe `execTransaction`, and return the tx request plus a gas estimate.
 *
 * The confirmation modal calls this to show the user:
 *   - Exactly which on-chain ops will be submitted (decoded)
 *   - Estimated gas units
 *   - Estimated max fee in native + USD
 */

export type PolicyIntent =
  | {
      kind: "install";
      /** Desired target allowlist + allowances for the role */
      desiredRole: Role;
    }
  | {
      kind: "diff";
      /** Next target allowlist + allowances for the role */
      desiredRole: Role;
      /** Role fetched from chain right before this simulate call */
      currentRole: Role;
    };

export type DecodedCall = {
  /** Which Zodiac call this is (e.g. "scopeFunction", "setAllowance") */
  type: string;
  /** On-chain target the call lands on (usually rolesModifier, or Safe) */
  to: string;
  /** Raw calldata for human inspection */
  data: string;
};

export type SafeTxGasEstimate = {
  unitsGas: bigint;
  maxFeePerGasWei: bigint;
  totalWei: bigint;
  totalNative: string;
  totalUsd: number | null;
};

export type SimulationResult = {
  /** Target contract of the outer owner-signed tx (= the Safe) */
  to: string;
  /** Outer calldata the Turnkey EOA will sign via Safe.execTransaction */
  outerCalldata: string;
  /** For display: inner calls batched inside the MultiSend */
  decodedCalls: DecodedCall[];
  gas: SafeTxGasEstimate;
};

/**
 * Collapse the desired-state Role and the (optional) current Role into the
 * concrete Zodiac ops needed, then wrap them for the Safe.
 */
export async function simulatePolicyChange(options: {
  chainId: number;
  safeAddress: string;
  ownerAddress: string;
  rolesModifierAddress: string;
  intent: PolicyIntent;
}): Promise<SimulationResult> {
  const { chainId, safeAddress, ownerAddress, rolesModifierAddress, intent } =
    options;

  const { desiredRole } = intent;
  const currentRole: Role =
    intent.kind === "install"
      ? {
          key: desiredRole.key,
          members: [],
          targets: [],
          annotations: [],
          lastUpdate: 0,
        }
      : intent.currentRole;

  const calls = callsPlannedForApplyRole(currentRole, desiredRole);
  const encodedCalls = encodeCalls(
    calls,
    rolesModifierAddress as `0x${string}`
  );

  const multiSend = getSafeContracts(chainId).multiSendCallOnly;
  const multiSendCalls: MultiSendCall[] = encodedCalls.map((call) => ({
    to: call.to,
    value: BigInt(0),
    data: call.data,
    operation: 0,
  }));
  const multiSendCalldata = buildMultiSendCalldata(multiSendCalls);

  const outerCalldata = buildExecTransactionCalldata({
    to: multiSend,
    data: multiSendCalldata,
    value: BigInt(0),
    operation: 1, // DELEGATECALL into MultiSend so the inner calls come from the Safe
    ownerAddress,
  });

  const rpcUrl = getRpcUrlByChainId(chainId, "primary");
  const manager = await getRpcProviderFromUrls(rpcUrl, undefined, chainId);
  const provider = manager.getProvider();

  let unitsGas: bigint;
  try {
    unitsGas = await provider.estimateGas({
      to: safeAddress,
      data: outerCalldata,
      from: ownerAddress,
    });
  } catch {
    // Estimation often fails for hypothetical txs (e.g. if the modifier
    // isn't installed yet). Fall back to a conservative constant so the UI
    // doesn't block the user from confirming.
    unitsGas = BigInt(500_000);
  }

  const gasConfig = await getGasStrategy().getGasConfig(
    provider,
    unitsGas,
    chainId
  );
  const maxFeePerGasWei = gasConfig.maxFeePerGas;
  const totalWei = unitsGas * maxFeePerGasWei;
  const totalNative = ethers.formatEther(totalWei);
  const totalUsd = await weiToUsd({ chainId, amountWei: totalWei });

  return {
    to: safeAddress,
    outerCalldata,
    decodedCalls: calls.map((call) => ({
      type: call.call,
      to: rolesModifierAddress,
      data: encodedCalls[calls.indexOf(call)]?.data ?? "0x",
    })),
    gas: {
      unitsGas,
      maxFeePerGasWei,
      totalWei,
      totalNative,
      totalUsd,
    },
  };
}

/**
 * Helper to compile admin-selected protocols + per-token allowances into a
 * `Role` shape the SDK planner accepts. The orchestrator uses this to build
 * the "desired role" that drives both simulation and the actual write.
 */
/**
 * Build a `Role` for the SDK planner from the admin's selected permissions.
 *
 * Allowances are NOT part of the Role in the SDK's model — they're a
 * separate top-level entity managed via `setAllowance` calls. The
 * orchestrator handles the allowance-diff separately from the role-diff.
 */
export function buildDesiredRole(options: {
  roleKey: `0x${string}`;
  delegate: `0x${string}`;
  permissions: Permission[];
}): Role {
  const { targets } = processPermissions(options.permissions);
  return {
    key: options.roleKey,
    members: [options.delegate],
    targets,
    annotations: [],
    lastUpdate: 0,
  };
}
