/**
 * Shared input-normalisation primitives for the Safe role routes.
 *
 * The /role install, /role/update, /role/simulate, and /safe/simulate-deploy
 * handlers all accept the same wizard-shaped payload. Previously each route's
 * normaliser silently `continue`-d past malformed entries, leaving the
 * caller with `success: true` and a partial install. Reviews flagged this
 * as a footgun (KEEP-177 #923-r3 MEDIUM): the user submits 5 rules, 3
 * install, response carries no signal that 2 were dropped.
 *
 * The convention is now: every normaliser returns `{ values, dropped }`,
 * and the route handler returns a 400 with the structured `dropped` list
 * the moment anything was dropped for missing/invalid fields. Unknown
 * protocol slugs are NOT considered malformed input (they may be valid
 * slugs not yet wired into PROTOCOL_CATALOG on this deployment) and stay
 * in the existing `skipped` channel.
 */

export type DroppedInput =
  | {
      category: "direct-rule";
      index: number;
      reason: string;
    }
  | {
      category: "protocol-token";
      protocolSlug: string;
      tokenIndex: number;
      reason: string;
    };
