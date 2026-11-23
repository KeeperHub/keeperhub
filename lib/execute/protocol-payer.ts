import type { ProtocolAction } from "@/lib/protocol-registry";
import { ZERO_ADDRESS } from "@/lib/web3/address";

/**
 * What an entrance puts in a payer argument's position. writeContractCore
 * overwrites it with the paying address after it resolves the signer; it is
 * non-empty so the core's trailing-empty-arg filter keeps its position.
 */
export const PAYER_PLACEHOLDER = ZERO_ADDRESS;

/**
 * The top-level ABI parameter writeContractCore must set to the payer, if
 * any.
 */
export function payerParamOf(
  action: ProtocolAction | undefined
): string | undefined {
  return action?.inputs.find((input) => input.payer)?.name;
}

/**
 * A caller may not choose a payer argument: the refund of an overpaid fee
 * goes there. Returns the refusal for a non-blank supplied value, else null.
 */
export function refuseSuppliedPayer(
  action: ProtocolAction | undefined,
  source: Record<string, unknown>
): { field: string; error: string } | null {
  const name = payerParamOf(action);
  if (!name) {
    return null;
  }
  const supplied = source[name];
  if (
    supplied === undefined ||
    supplied === null ||
    (typeof supplied === "string" && supplied.trim() === "")
  ) {
    return null;
  }
  return {
    field: name,
    error: `${name} is set by KeeperHub to the address that pays for this call and cannot be supplied. Remove it from the request.`,
  };
}
