import type { SecurityAuditEvent } from "@/lib/api-client";

/**
 * Creator identity for a synthesized "created" entry. Any subset may be
 * present; the entry is attributed only when a name or email is known.
 */
export type FallbackCreator = {
  id?: string | null;
  name?: string | null;
  email?: string | null;
  role?: string | null;
};

export type CreatedFallbackInput = {
  resourceType: string;
  resourceId: string;
  createdAt: string;
  /** Defaults to `${resourceType}.created`. */
  action?: string;
  /** Human label for the resource (e.g. the workflow name), if known. */
  resourceName?: string | null;
  creator?: FallbackCreator | null;
};

/**
 * Build the synthesized "created" event shown for a resource that predates
 * audit logging (no real `*.created` row exists yet). The activity feed merges
 * these on the last/oldest page and drops any whose resource already has a real
 * created event, so a fallback never double-counts. Shared by the per-resource
 * activity overlays and the org-wide activity feed so the baseline is built one
 * way everywhere.
 */
export function createdFallback(
  input: CreatedFallbackInput
): SecurityAuditEvent {
  const creator = input.creator;
  const attributed = Boolean(creator?.name || creator?.email);
  return {
    id: `fallback-${input.resourceType}-${input.resourceId}`,
    action: input.action ?? `${input.resourceType}.created`,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    resourceName: input.resourceName ?? null,
    // A synthesized creation predates the version-history feature, so there is
    // no specific version to deep-link to.
    version: null,
    createdAt: input.createdAt,
    diff: null,
    metadata: null,
    actor: attributed
      ? {
          id: creator?.id ?? "",
          name: creator?.name ?? null,
          email: creator?.email ?? null,
          role: creator?.role ?? null,
        }
      : null,
  };
}
