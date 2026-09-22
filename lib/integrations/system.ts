/**
 * System integrations: the integration types that ship without a plugin of
 * their own and so are absent from the plugin registry. Every registry lookup
 * in the UI falls back to these maps, which is why they had been copy-pasted
 * into six components under two different names (SYSTEM_* and BUILTIN_*), with
 * the key constraint quietly dropped in four of the copies.
 *
 * The slug list here must stay in step with SYSTEM_INTEGRATION_TYPES in
 * scripts/discover-plugins.ts, which feeds the generated IntegrationType union.
 * That generator imports nothing from the app so it can run before anything is
 * built, so the pairing is guarded by a test rather than by an import:
 * tests/unit/system-integrations.test.ts.
 */

import type { IntegrationType } from "@/lib/types/integration";

// Annotated as Record<string, string> because several callers index these with
// a plain string taken off the API client. The `satisfies` clause keeps the
// keys checked against the generated union regardless.
export const SYSTEM_INTEGRATION_LABELS: Record<string, string> = {
  database: "Database",
} satisfies Partial<Record<IntegrationType, string>>;

export const SYSTEM_INTEGRATION_DESCRIPTIONS: Record<string, string> = {
  database: "Connect to PostgreSQL databases",
} satisfies Partial<Record<IntegrationType, string>>;

/**
 * Built-in actions that require an integration but are not in the plugin
 * registry, keyed by the action's display name.
 */
export const SYSTEM_ACTION_INTEGRATIONS: Record<string, IntegrationType> = {
  "Database Query": "database",
};

export const SYSTEM_INTEGRATION_TYPES = Object.keys(
  SYSTEM_INTEGRATION_LABELS
) as IntegrationType[];
