import type { SuggestionDescriptor } from "@/lib/scan/suggestions/types";

/**
 * Synthetic write-type SuggestionDescriptor for FUNNEL-05 testing.
 *
 * All real v1.13 suggestions are read-only; this fixture is the only
 * write-type descriptor in the codebase. It exists solely to exercise the
 * Turnkey wallet provision gate (FUNNEL-05 forward-compat path) in unit and
 * E2E tests without requiring a real scanned position.
 *
 * The id uses the deterministic slug convention:
 * `${category}-${protocol}-${chainId}[-${suffix}]` (SUGGEST-01).
 */
export const SYNTHETIC_WRITE_DESCRIPTOR: SuggestionDescriptor = {
  id: "health-aave-1-write-synthetic",
  name: "Repay Aave V3 Debt (Write Gate Test)",
  description:
    "Synthetic write-type descriptor for FUNNEL-05 gate testing. All v1.13 real suggestions are read-only; this fixture exercises the write-path provision gate only.",
  category: "health",
  chainId: 1,
  readOrWrite: "write",
  confirmInputs: {
    threshold: "1.5",
    repayAmountUsd: "1000",
  },
  riskNote:
    "Synthetic fixture only. This descriptor is never surfaced to real users and exists purely to test the Turnkey wallet provision gate (FUNNEL-05).",
  protocol: "aave-v3",
  usdValue: 5000,
};
