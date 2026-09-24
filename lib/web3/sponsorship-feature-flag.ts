import { resolveDefaultOnFlag } from "@/lib/utils";

export function isGasSponsorshipEnabled(): boolean {
  return process.env.NEXT_PUBLIC_GAS_SPONSORSHIP_ENABLED === "true";
}

/**
 * Resolve the per-node "Sponsor gas" toggle. Defaults on, so a node authored
 * before the toggle existed keeps the sponsored route it already had; only an
 * explicit false sends the transaction straight to direct signing from the
 * org's own wallet.
 *
 * Turning it off does not merely reorder the attempt - the sponsored path is
 * skipped entirely, so no sponsorship credit is spent and msg.sender is the
 * wallet the author expects.
 */
export function resolveSponsorGas(sponsorGas: unknown): boolean {
  return resolveDefaultOnFlag(sponsorGas);
}
