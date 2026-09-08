import { NextResponse } from "next/server";
import { getGasCreditCapCents } from "@/lib/billing/gas-credits";
import { formatGasCreditUsd } from "@/lib/billing/gas-sponsorship-public";
import { isGasSponsorshipEnabled } from "@/lib/web3/sponsorship-feature-flag";

/**
 * GET /api/gas-sponsorship
 *
 * Public, read-only view of the free-tier gas sponsorship amount so onboarding
 * surfaces can explain "every account gets $X of sponsored gas on mainnet"
 * without baking the amount into a NEXT_PUBLIC build env. The authoritative
 * value is the server-only GAS_CREDITS_FREE_CENTS (lib/billing/gas-credits.ts).
 */
export function GET(): NextResponse {
  const freeCents = getGasCreditCapCents("free");
  return NextResponse.json({
    enabled: isGasSponsorshipEnabled(),
    freeCents,
    label: formatGasCreditUsd(freeCents),
  });
}
