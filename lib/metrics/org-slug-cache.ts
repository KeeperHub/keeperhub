import { ANONYMOUS_ORG_SLUG } from "@/lib/metrics/metric-constants";

// Dependency-free so the standalone executor can share the cache without
// importing the app's eagerly-created db client; each context supplies its
// own lookup bound to its own db instance (see org-slug.server.ts and
// keeperhub-executor/lib/terminal-counters.ts).

export type OrgSlugLookup = (
  workflowId: string
) => Promise<Array<{ slug: string | null }>>;

// A workflow's organization never changes after creation, so the mapping is
// safe to memoize for the pod lifetime. An org slug rename can leave stale
// label values until pods restart; counters tolerate that (the series simply
// splits at the rename) and it avoids one JOIN per finalized execution on
// the hot finalize path. Bounded FIFO eviction caps memory on long-lived
// pods that see many distinct workflows.
const cache = new Map<string, string>();
export const ORG_SLUG_CACHE_MAX = 10_000;

export async function resolveOrgSlugCached(
  workflowId: string,
  lookup: OrgSlugLookup
): Promise<string> {
  const hit = cache.get(workflowId);
  if (hit !== undefined) {
    return hit;
  }

  const rows = await lookup(workflowId);
  const slug = rows[0]?.slug ?? ANONYMOUS_ORG_SLUG;

  if (cache.size >= ORG_SLUG_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }
  cache.set(workflowId, slug);
  return slug;
}
