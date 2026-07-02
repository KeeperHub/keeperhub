/**
 * Managed-client cohort + alert routing, sourced from env -- never hardcoded.
 *
 * `MANAGED_ORGS_CONFIG` is a JSON object keyed by org slug, injected at deploy
 * from AWS Parameter Store (SecureString) so client identities and their
 * PagerDuty routing keys never live in source (this repo is public). Shape:
 *   {"<slug>":{"pagerdutyRoutingKey":"<events-v2-key>"}}
 *
 * Consumers: the metrics scraper (managed-client error gauge, scoped to these
 * slugs to bound `workflow_id` cardinality) and the post-deploy verification
 * route (cohort selection + per-client PagerDuty routing). Kept dependency-free
 * so it can be imported from API routes, the metrics scraper, and scripts.
 *
 * Empty / unset config => no managed slugs: the gauge emits no managed series
 * and the verification cohort falls back to enterprise-plan orgs only. Parsed
 * per call (the JSON is tiny) so a value change takes effect without caching.
 */

export type ManagedOrgConfig = {
  pagerdutyRoutingKey?: string;
};

function parseManagedOrgs(): Record<string, ManagedOrgConfig> {
  const raw = process.env.MANAGED_ORGS_CONFIG;
  if (!raw) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, ManagedOrgConfig>;
    }
  } catch {
    // Malformed config behaves like "no managed orgs" rather than crashing the
    // caller (a metrics scrape or the verification route).
  }
  return {};
}

/** Slugs of the managed-client cohort. Empty when unconfigured. */
export function getManagedOrgSlugs(): string[] {
  return Object.keys(parseManagedOrgs());
}

/**
 * PagerDuty Events v2 routing key for a slug. Falls back to
 * `DEFAULT_PAGERDUTY_ROUTING_KEY` (for enterprise-plan orgs without a dedicated
 * service). Undefined when neither is set -- callers then skip paging.
 */
export function getPagerDutyRoutingKey(slug: string): string | undefined {
  return (
    parseManagedOrgs()[slug]?.pagerdutyRoutingKey ??
    process.env.DEFAULT_PAGERDUTY_ROUTING_KEY ??
    undefined
  );
}
