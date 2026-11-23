// Validates a workflow's nodes against the feature registry given a plan.
// Used at save time (reject if violations) and at execute time (hard block).
//
// Gating resolves through resolveActionFeature (not the pure registry lookup)
// so the egress-derived gate applies: any "user-destination" action is gated
// even when it has no explicit feature entry - a new custom-destination action
// is blocked for free plans the moment it is classified, without being added to
// a hand-maintained list. Unknown/unclassified action types are not blocked
// here (the executor rejects them at dispatch); the build-time invariant
// (tests/unit/features-egress-invariant.test.ts) is what guarantees every
// dispatchable egress action is classified and gated.

import type { PlanName } from "@/lib/billing/plans";
import {
  asRecord,
  normalizeActionType,
  readNodeConfigField,
} from "@/lib/workflow/node-config-read";
import { resolveActionFeature } from "./action-egress";
import { isFeatureEnabled } from "./check";
import type {
  FeatureId,
  WorkflowFeatureViolation,
  WorkflowNodeRef,
} from "./types";

export function validateWorkflowFeatures(
  nodes: readonly WorkflowNodeRef[],
  plan: PlanName
): WorkflowFeatureViolation[] {
  const violations = new Map<FeatureId, WorkflowFeatureViolation>();

  for (const node of nodes) {
    const feature = resolveActionFeature(node.actionType);
    if (!feature) {
      continue;
    }
    if (isFeatureEnabled(feature.id, plan)) {
      continue;
    }

    const existing = violations.get(feature.id);
    if (existing) {
      existing.nodeIds.push(node.id);
      continue;
    }
    violations.set(feature.id, {
      featureId: feature.id,
      feature,
      actionType: node.actionType,
      nodeIds: [node.id],
    });
  }

  return [...violations.values()];
}

// Helper to extract the bits the validator needs from a raw workflow JSONB
// payload. Nodes live in `workflow.nodes` as a JSONB array; each node carries
// `data.config.actionType` (set by the action grid when the action is picked).
// Fails closed: a non-string id or actionType is coerced, never skipped.
type UnknownNode = {
  id?: unknown;
  data?: unknown;
};

function coerceActionType(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return;
  }
  return normalizeActionType(typeof value === "string" ? value : String(value));
}

export function extractActionTypeNodes(nodes: unknown): WorkflowNodeRef[] {
  if (!Array.isArray(nodes)) {
    return [];
  }
  const refs: WorkflowNodeRef[] = [];
  for (const [index, raw] of nodes.entries()) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const node = raw as UnknownNode;
    const data = asRecord(node.data);
    const config = data ? asRecord(data.config) : null;
    const actionType = coerceActionType(
      readNodeConfigField(data, config, "actionType")
    );
    if (!actionType) {
      continue;
    }
    const id =
      typeof node.id === "string" && node.id !== ""
        ? node.id
        : String(node.id ?? `nodes[${index}]`);
    refs.push({ id, actionType });
  }
  return refs;
}
