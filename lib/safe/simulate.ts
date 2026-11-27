import "server-only";

import {
  type Permission,
  processPermissions,
  type Role,
} from "zodiac-roles-sdk";

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
