/**
 * Validation guards for scan-generated workflow JSON.
 *
 * PREFILL-03: validateTemplateRefs asserts every {{@nodeId:...}} template
 *   reference in node configs resolves to a node present in nodes[].
 *
 * PREFILL-07: validateNoMaxUint256Approval blocks any approve-token node that
 *   uses an unlimited (MaxUint256) amount before the workflow is returned to
 *   the caller. Defensive guard for any future write prefill.
 *
 * No server-only imports — safe to call from tests and client-side code.
 */
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow/store";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// ---------------------------------------------------------------------------
// PREFILL-03: Template ref validation
// ---------------------------------------------------------------------------

/**
 * Matches {{@nodeId:Label.field}} template references.
 * The first capture group is the nodeId.
 *
 * Mirrors OUTPUT_MAPPING_TEMPLATE_RE from lib/mcp/validate-workflow.ts.
 */
const TEMPLATE_REF_RE = /\{\{@([^:}]+):[^}]+\}\}/g;

/**
 * The built-in pseudo-node ID that is always resolvable.
 * Matches BUILTIN_NODE_ID from lib/workflow/editor/builtin-variables.ts.
 */
const BUILTIN_NODE_ID = "__system";

/**
 * Assert every {{@nodeId:Label.field}} reference in node configs resolves to
 * a node that exists in nodes[]. The built-in "__system" node is always
 * considered resolvable.
 *
 * Scans the serialised config of each node; edges are passed for API
 * consistency but are not currently scanned for refs.
 */
export function validateTemplateRefs(
  nodes: WorkflowNode[],
  _edges: WorkflowEdge[]
): ValidationResult {
  const nodeIds = new Set(nodes.map((n) => n.id));
  const errors: string[] = [];

  for (const node of nodes) {
    const configStr = JSON.stringify(node.data.config ?? {});
    for (const match of configStr.matchAll(TEMPLATE_REF_RE)) {
      const referencedId = match[1];
      if (referencedId !== BUILTIN_NODE_ID && !nodeIds.has(referencedId)) {
        errors.push(
          `Node ${node.id} references missing nodeId "${referencedId}"`
        );
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// PREFILL-07: MaxUint256 approval block
// ---------------------------------------------------------------------------

/**
 * The decimal string representation of 2^256 - 1 (ethers MaxUint256).
 * Source: approve-token-core.ts ethers.MaxUint256 → decimal 78-digit constant.
 */
const MAX_UINT256_STR =
  "115792089237316195423570985008687907853269984665640564039457584007913129639935";

/**
 * Block any approve-token node that would grant an unlimited (MaxUint256)
 * allowance. Detects both the shorthand "max" and the literal 78-digit
 * decimal string.
 *
 * Source of detection pattern: plugins/web3/steps/approve-token-core.ts
 * `amount.trim().toLowerCase() === "max"` → ethers.MaxUint256.
 */
export function validateNoMaxUint256Approval(
  nodes: WorkflowNode[]
): ValidationResult {
  const errors: string[] = [];

  for (const node of nodes) {
    const config = node.data.config;
    if (!config) {
      continue;
    }
    if (config.actionType !== "web3/approve-token") {
      continue;
    }
    const amount = String(config.amount ?? "").trim();
    if (amount.toLowerCase() === "max" || amount === MAX_UINT256_STR) {
      errors.push(
        `Node ${node.id}: approve-token with MaxUint256 amount blocked. Use exact approval amounts.`
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// PREFILL-06: approve-token block (WR-02)
// ---------------------------------------------------------------------------

/**
 * Block any approve-token node unconditionally in factory output.
 *
 * Phase 52 shapes are read-only (PREFILL-06). An approve-token node mutates
 * chain state regardless of the amount, and findFirstWriteActionNode in
 * lib/mcp/calldata.ts intentionally excludes approve-token from write
 * detection (because it is not calldata-generatable). That means a factory
 * shape that accidentally includes an approve-token with a finite amount
 * would pass both validateNoMaxUint256Approval (not max amount) and the
 * runWriteActionCheck (not classified as write), and be returned with
 * workflowType "read" — silently allowing a state-mutation node to ship.
 *
 * This validator closes the gap: any approve-token in factory output is a
 * violation of the read-only invariant and must be rejected here.
 */
export function validateNoApproveTokenNode(
  nodes: WorkflowNode[]
): ValidationResult {
  const errors: string[] = [];

  for (const node of nodes) {
    const config = node.data.config;
    if (!config) {
      continue;
    }
    if (config.actionType === "web3/approve-token") {
      errors.push(
        `Node ${node.id}: approve-token node blocked in read-only factory output (PREFILL-06).`
      );
    }
  }

  return { valid: errors.length === 0, errors };
}
