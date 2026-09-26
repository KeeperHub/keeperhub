/**
 * Value-level guards for protocol action inputs.
 *
 * The registry validates an input's shape (a 20-byte address, a uint) but not
 * whether a particular value is safe for a particular function. Some contracts
 * treat a shape-valid value as a sentinel that redirects funds, and the ABI
 * cannot express that. Those rules live here, keyed by protocol and function,
 * so both paths that build protocol call arguments enforce the same thing:
 * the workflow write step (plugins/protocol/steps/protocol-write.ts) and the
 * direct-execute route (app/api/execute/_lib/protocol-function-args.ts).
 *
 * Keep the list short. A guard belongs here only when a shape-valid value
 * loses funds or silently does something other than what the field says.
 */

import { ethers } from "ethers";

import { getProtocol } from "@/lib/protocol-registry";

export type ProtocolInputGuardResult =
  | { ok: true }
  | { ok: false; error: string; field: string };

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
// Uppercase hex prefix: valid hex a user may paste, which getAddress rejects.
const UPPERCASE_HEX_PREFIX = /^0X/;

/**
 * Normalise for comparison, or undefined when the value is not a well-formed
 * address. Only the full 20-byte form survives: `getAddress` throws on "0x0",
 * on any short or padded variant, and on a bad checksum, and all of those land
 * in the catch. That is deliberate - the encoder rejects them with its own
 * message - but it does mean a guard here only ever sees complete addresses.
 * A leading "0X" is normalised first, since it is valid hex a user may paste
 * and `getAddress` would otherwise throw on it.
 */
function normalizeAddress(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }
  const trimmed = value.trim().replace(UPPERCASE_HEX_PREFIX, "0x");
  try {
    return ethers.getAddress(trimmed).toLowerCase();
  } catch {
    return undefined;
  }
}

type GuardContext = {
  /** Chain id, used to resolve the protocol's own contract addresses. */
  network?: string;
};

type ProtocolInputGuard = {
  protocolSlug: string;
  functionName: string;
  field: string;
  reject: (value: unknown, context: GuardContext) => string | null;
};

/** A protocol contract's address on the given chain, lowercased. */
function contractAddressOn(
  protocolSlug: string,
  contractKey: string,
  network: string | undefined
): string | undefined {
  if (!network) {
    return undefined;
  }
  const address =
    getProtocol(protocolSlug)?.contracts[contractKey]?.addresses[network];
  return address?.toLowerCase();
}

const GUARDS: readonly ProtocolInputGuard[] = [
  {
    // NonfungiblePositionManager.collect rewrites a zero recipient to the
    // position manager itself, and its `sweepToken` is unrestricted, so the
    // collected fees go to whoever sweeps that contract first. The call does
    // not revert, so nothing downstream catches it.
    protocolSlug: "uniswap",
    functionName: "collect",
    field: "recipient",
    reject: (value, context) => {
      const recipient = normalizeAddress(value);
      if (recipient === undefined) {
        return null;
      }
      // Both values end in the same place. Zero is the sentinel Uniswap
      // rewrites to the position manager; naming the manager directly skips
      // the rewrite and arrives there anyway.
      const positionManager = contractAddressOn(
        "uniswap",
        "positionManager",
        context.network
      );
      if (recipient !== ZERO_ADDRESS && recipient !== positionManager) {
        return null;
      }
      return "Recipient cannot be the zero address or the position manager itself: Uniswap credits the collected fees to the position manager, where its public sweepToken lets anyone take them. Set the wallet or contract that should receive the fees.";
    },
  },
];

/**
 * Check an action's raw inputs, keyed by input name, against the guards
 * registered for that protocol function. Returns the first failure.
 */
export function checkProtocolInputGuards(
  protocolSlug: string,
  functionName: string,
  inputs: Record<string, unknown>,
  context: GuardContext = {}
): ProtocolInputGuardResult {
  for (const guard of GUARDS) {
    if (
      guard.protocolSlug !== protocolSlug ||
      guard.functionName !== functionName
    ) {
      continue;
    }
    const error = guard.reject(inputs[guard.field], context);
    if (error !== null) {
      return { ok: false, error, field: guard.field };
    }
  }
  return { ok: true };
}
