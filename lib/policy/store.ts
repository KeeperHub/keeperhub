import "server-only";

/**
 * Loading and caching the compiled policy set, and resolving grants.
 *
 * The cache is a 30 second in-process TTL with explicit invalidation on write,
 * matching how organization MFA enforcement is read elsewhere. Under CI and
 * test the TTL is zero so a test never sees another test's policy.
 *
 * Failure is closed with a stale-serve window: a brief store outage serves the
 * last known good set rather than denying everything, and past that window the
 * caller gets a denial that is distinguishable from a real policy refusal.
 */

import { and, eq, gt, isNull, lte, or } from "drizzle-orm";
import { db } from "@/lib/db";
import { organizationPolicies, resourceGrants } from "@/lib/db/schema";
import { ErrorCategory, logSystemWarn } from "@/lib/logging";
import { arnStringMatches } from "./arn";
import type { Capability } from "./capabilities";
import { compilePolicy } from "./compile";
import { POLICY_CACHE_TTL_MS, POLICY_STALE_SERVE_MAX_MS } from "./constants";
import type { CompiledPolicy, CompiledPolicySet } from "./types";

type CacheEntry = {
  set: CompiledPolicySet;
  loadedAt: number;
};

const cache = new Map<string, CacheEntry>();

export function invalidateOrgPolicies(organizationId: string): void {
  cache.delete(organizationId);
}

export function invalidateAllPolicies(): void {
  cache.clear();
}

/**
 * A version string for the whole set, so a run can pin what it started with.
 * Derived from each policy's id and version, so any edit changes it.
 */
function computeVersion(rows: { id: string; version: number }[]): string {
  if (rows.length === 0) {
    return "empty";
  }
  return rows
    .map((r) => `${r.id}:${r.version}`)
    .sort()
    .join(",");
}

async function loadFromDb(organizationId: string): Promise<CompiledPolicySet> {
  const now = new Date();
  const rows = await db
    .select()
    .from(organizationPolicies)
    .where(
      and(
        eq(organizationPolicies.organizationId, organizationId),
        eq(organizationPolicies.enabled, true),
        // A change delay means an edit is recorded now and bites later, so a
        // policy that is not yet effective is not yet enforced.
        lte(organizationPolicies.effectiveAt, now)
      )
    );

  const policies: CompiledPolicy[] = [];
  for (const row of rows) {
    const out = compilePolicy({
      id: row.id,
      enabled: row.enabled,
      document: row.document,
      enforcement: row.enforcement,
    });
    if (out.ok) {
      policies.push(out.compiled);
      continue;
    }
    // A stored policy that no longer compiles is a real problem: it was valid
    // when saved, so either the compiler changed or the row was edited out of
    // band. Dropping it silently would quietly remove a guardrail, so it is
    // reported and the rest of the set still loads.
    logSystemWarn(
      ErrorCategory.CONFIGURATION,
      `[Policy] Stored policy ${row.id} failed to compile and was skipped`,
      new Error(out.errors.map((e) => e.message).join("; ")),
      { organizationId, policyId: row.id }
    );
  }

  return {
    organizationId,
    version: computeVersion(rows),
    policies,
    compiledAt: Date.now(),
  };
}

/**
 * The compiled set for an organization.
 *
 * Returns null only when the store is unreachable AND no cached set is within
 * the stale window. A null result must be treated as a denial, never as "no
 * policies", which is why the caller gets null rather than an empty set.
 */
export async function getCompiledPolicySet(
  organizationId: string
): Promise<CompiledPolicySet | null> {
  const cached = cache.get(organizationId);
  const now = Date.now();

  if (cached && now - cached.loadedAt < POLICY_CACHE_TTL_MS) {
    return cached.set;
  }

  try {
    const set = await loadFromDb(organizationId);
    cache.set(organizationId, { set, loadedAt: now });
    return set;
  } catch (error) {
    if (cached && now - cached.loadedAt < POLICY_STALE_SERVE_MAX_MS) {
      // Serving a slightly stale set beats denying every action in the org for
      // a transient database blip. Past the window this branch stops firing.
      logSystemWarn(
        ErrorCategory.DATABASE,
        "[Policy] Serving a stale policy set after a load failure",
        error instanceof Error ? error : new Error(String(error)),
        { organizationId }
      );
      return cached.set;
    }
    logSystemWarn(
      ErrorCategory.DATABASE,
      "[Policy] Policy set unavailable and no usable cache; failing closed",
      error instanceof Error ? error : new Error(String(error)),
      { organizationId }
    );
    return null;
  }
}

export type GrantSubject = {
  kind: "workflow" | "principal";
  id: string;
};

export type ResolvedGrant = {
  id: string;
  resource: string;
  capabilities: readonly Capability[];
};

/**
 * Live grants for a subject. Revoked and expired rows never come back, so a
 * revocation takes effect on the next resolution rather than at a cache
 * boundary.
 */
export async function loadGrants(
  organizationId: string,
  subject: GrantSubject
): Promise<ResolvedGrant[]> {
  const now = new Date();
  const rows = await db
    .select({
      id: resourceGrants.id,
      resource: resourceGrants.resource,
      capabilities: resourceGrants.capabilities,
    })
    .from(resourceGrants)
    .where(
      and(
        eq(resourceGrants.organizationId, organizationId),
        eq(resourceGrants.subjectKind, subject.kind),
        eq(resourceGrants.subjectId, subject.id),
        isNull(resourceGrants.revokedAt),
        or(
          isNull(resourceGrants.expiresAt),
          // A grant expiring in the future is still live.
          gt(resourceGrants.expiresAt, now)
        )
      )
    );
  return rows.map((r) => ({
    id: r.id,
    resource: r.resource,
    capabilities: r.capabilities,
  }));
}

/**
 * Whether a held grant covers this resource and capability.
 *
 * This is the capability half of the model: without a covering grant the
 * resource was never reachable, which is a different answer from "a rule
 * refused you" and is reported as such.
 */
export function grantCovers(
  grants: readonly ResolvedGrant[],
  resource: string,
  capability: Capability
): ResolvedGrant | null {
  for (const grant of grants) {
    if (!grant.capabilities.includes(capability)) {
      continue;
    }
    if (arnStringMatches(grant.resource, resource)) {
      return grant;
    }
  }
  return null;
}
