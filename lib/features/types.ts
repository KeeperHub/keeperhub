// Pure type definitions for the feature gating system.
// No runtime values; safe to import anywhere (client + server + edge).

import type { PlanName } from "@/lib/billing/plans";

// Feature ID convention:
//   "<category>.<short-slug>"
// e.g. "action.database-query", "automation.advanced-scheduling".
// Add new IDs to this union as features are introduced.
export type FeatureId =
  | "action.database-query"
  | "action.http-request"
  | "action.code"
  | "action.webhook"
  | "action.external-request"
  | "notifications.execution-digest";

// High-level grouping used for UI ("Workflow actions", "API access", etc.)
// and analytics. Extend freely as new categories are needed.
export type FeatureCategory =
  | "workflow-action"
  | "automation"
  | "api"
  | "team"
  | "observability";

export type FeatureDefinition = {
  id: FeatureId;
  name: string;
  description: string;
  category: FeatureCategory;
  // Master kill switch. If false, the feature is treated as gated for every
  // plan (used to roll a feature back without removing its definition).
  enabled: boolean;
  // Minimum plan required. "free" means no plan gate; gating is purely the
  // `enabled` flag. Plans are ranked free < pro < business < enterprise.
  requiredPlan: PlanName;
  // When a feature gates one or more workflow action types, list the exact
  // `actionType` string stored on workflow nodes here. The workflow validator
  // uses this to map a saved workflow back to feature IDs.
  //
  // System actions: literal label, e.g. "Database Query".
  // Plugin actions: "<plugin-slug>/<action-slug>", e.g. "code/run-code".
  actionTypes?: readonly string[];
  // Optional copy override for the upgrade prompt shown when this feature is
  // gated. Falls back to a generic message if omitted.
  upgradeCta?: string;
};

export type WorkflowNodeRef = {
  id: string;
  actionType: string;
};

export type WorkflowFeatureViolation = {
  featureId: FeatureId;
  feature: FeatureDefinition;
  actionType: string;
  nodeIds: string[];
};
