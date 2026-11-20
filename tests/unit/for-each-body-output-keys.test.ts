import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildEdgesBySourceHandle } from "@/lib/workflow/editor/edge-handle-utils";
import { buildEdgesBySource } from "@/lib/workflow/executor/convergence-barrier";
import { identifyLoopBody } from "@/lib/workflow/executor/executor.workflow";
import {
  type BodyExecutionResult,
  type BodyNodeOutputs,
  type RunBodyContext,
  runBodyNode,
} from "@/lib/workflow/executor/for-each-body-runner";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow/store";

const action = (
  id: string,
  actionType: string,
  enabled = true
): WorkflowNode => ({
  id,
  type: "action",
  position: { x: 0, y: 0 },
  data: { type: "action", label: id, config: { actionType }, enabled },
});
const edge = (
  source: string,
  target: string,
  sourceHandle?: string
): WorkflowEdge => ({
  id: `${source}->${target}`,
  source,
  target,
  type: "default",
  ...(sourceHandle ? { sourceHandle } : {}),
});

describe("For Each body output keys", () => {
  it("stores each body step's output under sanitizeNodeId(id)", async () => {
    const nodes = [
      action("for-each", "For Each"),
      action("a-b.c", "HTTP Request"),
      action("d-x", "HTTP Request", false),
    ];
    const edges = [edge("for-each", "a-b.c", "loop"), edge("a-b.c", "d-x")];
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    const { collectNodeId, bodyEdgesBySource, bodyEdgesBySourceHandle } =
      identifyLoopBody(
        "for-each",
        buildEdgesBySource(edges),
        nodeMap,
        buildEdgesBySourceHandle(edges)
      );
    const scopedOutputs: BodyNodeOutputs = {};
    const bodyResults: Record<string, BodyExecutionResult> = {};
    const ctx = {
      nodeMap,
      bodyEdgesBySource,
      bodyEdgesBySourceHandle,
      collectNodeId,
      bodyVisited: new Set<string>(),
      bodyResults,
      scopedOutputs,
      iterationMeta: { iterationIndex: 0, forEachNodeId: "for-each" },
      runStep: async () => ({ ok: 1 }),
      processConfig: (config: Record<string, unknown>) => ({ ...config }),
      getNodeName: (n: WorkflowNode) => n.data.label || n.id,
      getErrorMessageAsync: async (err: unknown) => String(err),
      injectBuiltinVariables: () => undefined,
      baseStepContext: {
        executionId: "e",
        organizationId: "o",
        orgSlug: "o",
        createdBy: "u",
        workflowId: "w",
      },
    } as unknown as RunBodyContext;
    for (const id of bodyEdgesBySource.get("for-each") ?? []) {
      await runBodyNode(id, ctx);
    }
    expect(Object.keys(scopedOutputs).sort()).toEqual(["a_b_c", "d_x"]);
  });
});
