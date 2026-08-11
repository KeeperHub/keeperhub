export function isGasSponsorshipEnabled(): boolean {
  return process.env.NEXT_PUBLIC_GAS_SPONSORSHIP_ENABLED === "true";
}
