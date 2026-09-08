/**
 * The Turnkey API endpoint, shared by both custody models.
 *
 * This lives in its own module rather than in `turnkey-operations.ts` because
 * `agentic-wallet.ts` must not import from that file - see the v1.8 custody
 * boundary at the top of `agentic-wallet.ts`, enforced by
 * `tests/unit/agentic-wallet-boundary.test.ts`. A base URL is not a custody
 * primitive, so a third module both sides may read keeps the boundary intact.
 *
 * Overridable so a deployment can point at a Turnkey-compatible endpoint of its
 * own. Unset yields the value all four call sites hardcoded before.
 */
export const TURNKEY_API_BASE_URL =
  process.env.TURNKEY_API_BASE_URL || "https://api.turnkey.com";
