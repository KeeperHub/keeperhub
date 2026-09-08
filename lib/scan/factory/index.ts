/**
 * Deterministic workflow factory dispatcher.
 *
 * Maps a SuggestionDescriptor to a validated PrefillWorkflow with correct
 * wire-shape node/edge JSON ready for Phase 53 canvas preview and Phase 54 save.
 *
 * Guarantees:
 *   - Zero AI calls; completes in < 10ms (pure TypeScript)
 *   - Every {{@nodeId:...}} template ref resolves to an existing node (PREFILL-03)
 *   - No MaxUint256 approve-token nodes escape the factory (PREFILL-07)
 *   - workflowType is always "read" for Phase 52 shapes (PREFILL-06)
 *
 * No server-only import: the factory is pure deterministic TypeScript that
 * must be testable in a Node.js Vitest environment without a Next.js server
 * context. Shape builders avoid importing server-only modules.
 */
import { buildDepegWatch } from "@/lib/scan/factory/shapes/depeg-watch";
import { buildGasBalance } from "@/lib/scan/factory/shapes/gas-balance";
import { buildGenericMonitor } from "@/lib/scan/factory/shapes/generic-monitor";
import { buildHfMonitor } from "@/lib/scan/factory/shapes/hf-monitor";
import { buildPriceAlert } from "@/lib/scan/factory/shapes/price-alert";
import { buildRewardReminder } from "@/lib/scan/factory/shapes/reward-reminder";
import { buildStablecoinYield } from "@/lib/scan/factory/shapes/stablecoin-yield";
import type { PrefillWorkflow } from "@/lib/scan/factory/types";
import {
  validateNoApproveTokenNode,
  validateNoMaxUint256Approval,
  validateTemplateRefs,
} from "@/lib/scan/factory/validate";
import type { SuggestionDescriptor } from "@/lib/scan/suggestions/types";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow/store";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a deterministic, validated PrefillWorkflow from a SuggestionDescriptor.
 *
 * Dispatches to the appropriate shape builder based on descriptor.category.
 * After building nodes/edges, runs validateTemplateRefs and
 * validateNoMaxUint256Approval; throws on any validation failure.
 */
export function buildWorkflow(
  descriptor: SuggestionDescriptor
): PrefillWorkflow {
  const { nodes, edges } = dispatchShape(descriptor);

  // PREFILL-03: every template ref must resolve to a node in this output
  const refResult = validateTemplateRefs(nodes, edges);
  if (!refResult.valid) {
    throw new Error(
      `Factory template ref validation failed: ${refResult.errors.join("; ")}`
    );
  }

  // PREFILL-07: no MaxUint256 approve-token escapes the factory
  const maxResult = validateNoMaxUint256Approval(nodes);
  if (!maxResult.valid) {
    throw new Error(
      `Factory MaxUint256 validation failed: ${maxResult.errors.join("; ")}`
    );
  }

  // PREFILL-06 / WR-02: no approve-token node of any amount in read-only output
  const approveResult = validateNoApproveTokenNode(nodes);
  if (!approveResult.valid) {
    throw new Error(
      `Factory approve-token validation failed: ${approveResult.errors.join("; ")}`
    );
  }

  return {
    nodes,
    edges,
    workflowType: "read",
    name: descriptor.name,
    description: descriptor.description,
  };
}

// ---------------------------------------------------------------------------
// Shape dispatcher
// ---------------------------------------------------------------------------

interface ShapeOutput {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

function dispatchShape(descriptor: SuggestionDescriptor): ShapeOutput {
  // Id-prefix dispatch for alert-category shapes with their own topology.
  // The category switch below stays the fallback (PREFILL-02).
  if (descriptor.id.startsWith("depeg-watch-")) {
    return buildDepegWatch(descriptor);
  }
  if (descriptor.id.startsWith("gas-balance-")) {
    return buildGasBalance(descriptor);
  }
  switch (descriptor.category) {
    case "health": {
      return buildHfMonitor(descriptor);
    }
    case "yield": {
      return buildStablecoinYield(descriptor);
    }
    case "alert": {
      return buildPriceAlert(descriptor);
    }
    case "claim": {
      return buildRewardReminder(descriptor);
    }
    default: {
      // Runtime safety for any category value that bypasses TypeScript's type
      // system (e.g. test fixtures or future union additions not yet handled).
      // All four current SuggestionCategory values are covered above; this
      // branch is unreachable from well-typed call sites (PREFILL-02).
      return buildGenericMonitor(descriptor);
    }
  }
}
