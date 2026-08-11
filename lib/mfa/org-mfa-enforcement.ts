import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { organization, users } from "@/lib/db/schema";
import type { StepUpFactor } from "@/lib/mfa/step-up-policy";

/**
 * Organization-level MFA enforcement for wallet (SIWE) members.
 *
 * An org owner can require that every member carries a second factor while the
 * org is their active context. Email/TOTP members already enforce dual-factor
 * globally, so the gate only changes behavior for wallet members, who are
 * otherwise MFA-exempt (their signature is the login factor). When a wallet
 * member's active org enforces MFA and they have not enrolled a satisfying
 * factor, the proxy hard-gates them to /enforce-mfa until they comply.
 */

/** Factors an org can require for enforcement. Wallet signature is implicit
 *  (it's the login factor), so enforcement is about the extra factors. */
const ENFORCEABLE_FACTORS: ReadonlySet<StepUpFactor> = new Set([
  "totp",
  "email",
]);

export type OrgMfaEnforcement = {
  enforce: boolean;
  /** Factors enforcement requires; a member must carry every one of them. */
  factors: StepUpFactor[];
};

const NO_ENFORCEMENT: OrgMfaEnforcement = { enforce: false, factors: [] };

// Short-lived in-process cache for org enforcement config. The proxy calls
// getOrgMfaEnforcement on every authenticated wallet request; without a cache
// that is one DB query per request per wallet user. The TTL is intentionally
// short (30 s) so enforcement changes propagate quickly, and the cache is
// best-effort per-pod (serverless deployments will see cache misses more
// often, which is safe -- just slightly more DB queries). When an org's
// enforcement settings are changed via the API, invalidateOrgMfaEnforcement
// should be called so the update is visible on the next request in that pod
// rather than waiting out the TTL.
//
// Disabled (TTL 0) under CI / NODE_ENV=test so E2E specs that flip enforcement
// directly in the DB observe the change on the next request without waiting out
// the TTL. Mirrors the rate-limit `enabled: !(CI || test)` gate in lib/auth.ts.
const ENFORCEMENT_CACHE_TTL_MS =
  process.env.CI || process.env.NODE_ENV === "test" ? 0 : 30_000;
type CacheEntry = { value: OrgMfaEnforcement; expiry: number };
const enforcementCache = new Map<string, CacheEntry>();

export function invalidateOrgMfaEnforcement(organizationId: string): void {
  enforcementCache.delete(organizationId);
}

/** Coerce the jsonb column into a clean factor list, dropping unknown values. */
export function parseEnforcedFactors(value: unknown): StepUpFactor[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<StepUpFactor>();
  for (const factor of value) {
    if (
      typeof factor === "string" &&
      ENFORCEABLE_FACTORS.has(factor as StepUpFactor)
    ) {
      seen.add(factor as StepUpFactor);
    }
  }
  return [...seen];
}

/** Read an org's enforcement config. Returns no-enforcement for a missing org,
 *  a disabled switch, or an empty factor list (nothing to require). */
export async function getOrgMfaEnforcement(
  organizationId: string | null | undefined
): Promise<OrgMfaEnforcement> {
  if (!organizationId) {
    return NO_ENFORCEMENT;
  }
  const now = Date.now();
  const cached = enforcementCache.get(organizationId);
  if (cached && cached.expiry > now) {
    return cached.value;
  }
  const [row] = await db
    .select({
      enforceMfa: organization.enforceMfa,
      enforcedMfaFactors: organization.enforcedMfaFactors,
    })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1);
  let result: OrgMfaEnforcement;
  if (row?.enforceMfa) {
    const factors = parseEnforcedFactors(row.enforcedMfaFactors);
    result = factors.length === 0 ? NO_ENFORCEMENT : { enforce: true, factors };
  } else {
    result = NO_ENFORCEMENT;
  }
  enforcementCache.set(organizationId, {
    value: result,
    expiry: now + ENFORCEMENT_CACHE_TTL_MS,
  });
  return result;
}

/** Which extra factors a user currently has enrolled (TOTP authenticator,
 *  verified step-up email). Wallet signature is always present for SIWE users
 *  and is not part of enforcement. */
export async function getEnrolledFactors(
  userId: string
): Promise<{ totp: boolean; email: boolean }> {
  const [user] = await db
    .select({
      stepUpEmail: users.stepUpEmail,
      twoFactorEnabled: users.twoFactorEnabled,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  // TOTP counts as enrolled only once confirmed (twoFactorEnabled), not when a
  // setup row exists but the code was never verified.
  return {
    totp: user?.twoFactorEnabled === true,
    email: Boolean(user?.stepUpEmail),
  };
}

/** A member satisfies enforcement only when they carry every factor the org
 *  requires. (Owner selects "totp", "email", or both; selecting both means the
 *  member must enroll both -- the selection is the exact requirement, not a
 *  menu of alternatives.) */
export function satisfiesEnforcement(
  required: StepUpFactor[],
  enrolled: { totp: boolean; email: boolean }
): boolean {
  return required.every(
    (factor) =>
      (factor === "totp" && enrolled.totp) ||
      (factor === "email" && enrolled.email)
  );
}

/**
 * Whether a wallet member is compliant with their active org's enforcement.
 * Returns `{ compliant: true }` when there's nothing to enforce or the member
 * already carries a required factor; otherwise reports the missing factors so
 * the enrollment page can show exactly what to add.
 */
export async function checkWalletOrgMfaCompliance(params: {
  userId: string;
  activeOrganizationId: string | null | undefined;
}): Promise<{ compliant: boolean; required: StepUpFactor[] }> {
  const enforcement = await getOrgMfaEnforcement(params.activeOrganizationId);
  if (!enforcement.enforce) {
    return { compliant: true, required: [] };
  }
  const enrolled = await getEnrolledFactors(params.userId);
  return {
    compliant: satisfiesEnforcement(enforcement.factors, enrolled),
    required: enforcement.factors,
  };
}
