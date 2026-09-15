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

export type ProtocolInputGuardResult =
  | { ok: true }
  | { ok: false; error: string; field: string };

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function isZeroAddress(value: unknown): boolean {
  if (typeof value !== "string" || value.trim() === "") {
    return false;
  }
  try {
    // getAddress normalises case and rejects malformed input, so "0x0",
    // padded variants and a mixed-case zero all resolve to one comparison.
    return ethers.getAddress(value.trim()) === ZERO_ADDRESS;
  } catch {
    // Malformed addresses are the encoder's to reject, with its own message.
    return false;
  }
}

type ProtocolInputGuard = {
  protocolSlug: string;
  functionName: string;
  field: string;
  reject: (value: unknown) => string | null;
};

const GUARDS: readonly ProtocolInputGuard[] = [
  {
    // NonfungiblePositionManager.collect rewrites a zero recipient to the
    // position manager itself, and its `sweepToken` is unrestricted, so the
    // collected fees go to whoever sweeps that contract first. The call does
    // not revert, so nothing downstream catches it.
    protocolSlug: "uniswap",
    functionName: "collect",
    field: "recipient",
    reject: (value) =>
      isZeroAddress(value)
        ? "Recipient cannot be the zero address: Uniswap credits the collected fees to the position manager, where anyone can sweep them. Set the wallet or contract that should receive the fees."
        : null,
  },
];

/**
 * Check an action's raw inputs, keyed by input name, against the guards
 * registered for that protocol function. Returns the first failure.
 */
export function checkProtocolInputGuards(
  protocolSlug: string,
  functionName: string,
  inputs: Record<string, unknown>
): ProtocolInputGuardResult {
  for (const guard of GUARDS) {
    if (
      guard.protocolSlug !== protocolSlug ||
      guard.functionName !== functionName
    ) {
      continue;
    }
    const error = guard.reject(inputs[guard.field]);
    if (error !== null) {
      return { ok: false, error, field: guard.field };
    }
  }
  return { ok: true };
}
