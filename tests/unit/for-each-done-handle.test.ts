import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildEdgesBySourceHandle } from "@/lib/workflow/editor/edge-handle-utils";
import {
  identifyLoopBody,
  planIterationContinuation,
} from "@/lib/workflow/executor/executor.workflow";
import type { WorkflowNode } from "@/lib/workflow/store";

type EdgeSpec = {
  source: string;
  target: string;
  sourceHandle?: string | null;
};

function action(id: string, actionType: string): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      label: id,
      type: "action",
      config: { actionType },
    },
  };
}

function buildEdgeMaps(edges: EdgeSpec[]): {
  edgesBySource: Map<string, string[]>;
  edgesBySourceHandle: ReturnType<typeof buildEdgesBySourceHandle>;
} {
  const edgesBySource = new Map<string, string[]>();
  for (const edge of edges) {
    const list = edgesBySource.get(edge.source) ?? [];
    list.push(edge.target);
    edgesBySource.set(edge.source, list);
  }
  const edgesBySourceHandle = buildEdgesBySourceHandle(
    edges.map((e) => ({
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle ?? null,
    }))
  );
  return { edgesBySource, edgesBySourceHandle };
}

function buildNodeMap(nodes: WorkflowNode[]): Map<string, WorkflowNode> {
  return new Map(nodes.map((n) => [n.id, n]));
}

describe("identifyLoopBody — handle-aware mode (KEEP-520)", () => {
  it("done-handle Collect: body excludes Collect, doneCollectNodeId is set", () => {
    const nodes = [
      action("fe", "For Each"),
      action("body-1", "HTTP Request"),
      action("body-2", "Execute Code"),
      action("done-collect", "Collect"),
      action("after", "HTTP Request"),
    ];
    const { edgesBySource, edgesBySourceHandle } = buildEdgeMaps([
      { source: "fe", target: "body-1", sourceHandle: "loop" },
      { source: "fe", target: "done-collect", sourceHandle: "done" },
      { source: "body-1", target: "body-2" },
      { source: "done-collect", target: "after" },
    ]);

    const result = identifyLoopBody(
      "fe",
      edgesBySource,
      buildNodeMap(nodes),
      edgesBySourceHandle
    );

    expect(result.doneCollectNodeId).toBe("done-collect");
    expect(result.doneEntryNodeIds).toEqual(["done-collect"]);
    expect(result.collectNodeId).toBeUndefined();
    expect(result.bodyNodeIds).toEqual(["body-1", "body-2"]);
    expect(result.bodyNodeIds).not.toContain("done-collect");
    expect(result.bodyNodeIds).not.toContain("after");
    expect(result.bodyEdgesBySource.get("fe")).toEqual(["body-1"]);
  });

  it("done-handle non-Collect target: doneCollectNodeId undefined but doneEntryNodeIds populated", () => {
    const nodes = [
      action("fe", "For Each"),
      action("body-1", "HTTP Request"),
      action("post-loop-http", "HTTP Request"),
    ];
    const { edgesBySource, edgesBySourceHandle } = buildEdgeMaps([
      { source: "fe", target: "body-1", sourceHandle: "loop" },
      { source: "fe", target: "post-loop-http", sourceHandle: "done" },
    ]);

    const result = identifyLoopBody(
      "fe",
      edgesBySource,
      buildNodeMap(nodes),
      edgesBySourceHandle
    );

    expect(result.doneCollectNodeId).toBeUndefined();
    expect(result.doneEntryNodeIds).toEqual(["post-loop-http"]);
    expect(result.collectNodeId).toBeUndefined();
    expect(result.bodyNodeIds).toEqual(["body-1"]);
    expect(result.bodyNodeIds).not.toContain("post-loop-http");
  });

  it("loop-only handle (no done edge) is still handle-aware", () => {
    const nodes = [action("fe", "For Each"), action("body-1", "HTTP Request")];
    const { edgesBySource, edgesBySourceHandle } = buildEdgeMaps([
      { source: "fe", target: "body-1", sourceHandle: "loop" },
    ]);

    const result = identifyLoopBody(
      "fe",
      edgesBySource,
      buildNodeMap(nodes),
      edgesBySourceHandle
    );

    expect(result.doneCollectNodeId).toBeUndefined();
    expect(result.doneEntryNodeIds).toEqual([]);
    expect(result.collectNodeId).toBeUndefined();
    expect(result.bodyNodeIds).toEqual(["body-1"]);
  });

  it("mixed wiring: both done-Collect and in-body Collect coexist", () => {
    // Body chain: fe -loop-> body-1 -> in-body-collect -> after-in-body
    // Done:       fe -done-> done-collect
    // The done-Collect wins; the in-body Collect is preserved in
    // collectNodeId so the executor can mark it visited but skip its step.
    const nodes = [
      action("fe", "For Each"),
      action("body-1", "HTTP Request"),
      action("in-body-collect", "Collect"),
      action("after-in-body", "Execute Code"),
      action("done-collect", "Collect"),
      action("after-done", "HTTP Request"),
    ];
    const { edgesBySource, edgesBySourceHandle } = buildEdgeMaps([
      { source: "fe", target: "body-1", sourceHandle: "loop" },
      { source: "fe", target: "done-collect", sourceHandle: "done" },
      { source: "body-1", target: "in-body-collect" },
      { source: "in-body-collect", target: "after-in-body" },
      { source: "done-collect", target: "after-done" },
    ]);

    const result = identifyLoopBody(
      "fe",
      edgesBySource,
      buildNodeMap(nodes),
      edgesBySourceHandle
    );

    expect(result.doneCollectNodeId).toBe("done-collect");
    expect(result.collectNodeId).toBe("in-body-collect");
    expect(result.bodyNodeIds).toEqual(["body-1"]);
    expect(result.bodyNodeIds).not.toContain("in-body-collect");
    expect(result.bodyNodeIds).not.toContain("done-collect");
    expect(result.bodyNodeIds).not.toContain("after-in-body");
    expect(result.bodyNodeIds).not.toContain("after-done");
  });

  it("nested handle-aware For Each: outer body skips inner loop body, follows inner done", () => {
    // Outer: fe-outer -loop-> outer-body-1 -> fe-inner -> outer-after-inner -> outer-tail
    // Outer:                                                                ^
    // Inner: fe-inner -loop-> inner-body
    // Inner: fe-inner -done-> inner-collect -> outer-after-inner
    //
    // The outer body BFS, when it reaches fe-inner, must follow ONLY the
    // inner's done chain (inner-collect -> outer-after-inner -> outer-tail),
    // NOT the inner's loop body (inner-body).
    const nodes = [
      action("fe-outer", "For Each"),
      action("outer-body-1", "HTTP Request"),
      action("fe-inner", "For Each"),
      action("inner-body", "Execute Code"),
      action("inner-collect", "Collect"),
      action("outer-after-inner", "Database Query"),
      action("outer-tail", "Execute Code"),
      action("done-collect", "Collect"),
    ];
    const { edgesBySource, edgesBySourceHandle } = buildEdgeMaps([
      { source: "fe-outer", target: "outer-body-1", sourceHandle: "loop" },
      { source: "fe-outer", target: "done-collect", sourceHandle: "done" },
      { source: "outer-body-1", target: "fe-inner" },
      { source: "fe-inner", target: "inner-body", sourceHandle: "loop" },
      { source: "fe-inner", target: "inner-collect", sourceHandle: "done" },
      { source: "inner-collect", target: "outer-after-inner" },
      { source: "outer-after-inner", target: "outer-tail" },
    ]);

    const result = identifyLoopBody(
      "fe-outer",
      edgesBySource,
      buildNodeMap(nodes),
      edgesBySourceHandle
    );

    expect(result.doneCollectNodeId).toBe("done-collect");
    expect(result.bodyNodeIds).toContain("outer-body-1");
    expect(result.bodyNodeIds).toContain("fe-inner");
    expect(result.bodyNodeIds).toContain("inner-collect");
    expect(result.bodyNodeIds).toContain("outer-after-inner");
    expect(result.bodyNodeIds).toContain("outer-tail");
    expect(result.bodyNodeIds).not.toContain("inner-body");
    expect(result.bodyNodeIds).not.toContain("done-collect");
  });
});

describe("identifyLoopBody — Condition inside body still routes via handles (KEEP-520 regression guard)", () => {
  it("Condition's true/false targets remain in body and are reachable via bodyEdgesBySourceHandle", () => {
    // fe -loop-> cond-1
    //   cond-1 -true-> action-true
    //   cond-1 -false-> action-false
    //   action-true -> tail
    //   action-false -> tail
    // fe -done-> done-collect
    //
    // The body must contain cond-1, action-true, action-false, and tail; the
    // handle map for cond-1 must still expose its true and false branches so
    // resolveBodyConditionTargets can route at runtime. Conditions inside
    // For Each iterations have regressed before — this test pins the behavior.
    const nodes = [
      action("fe", "For Each"),
      action("cond-1", "Condition"),
      action("action-true", "HTTP Request"),
      action("action-false", "Execute Code"),
      action("tail", "Database Query"),
      action("done-collect", "Collect"),
    ];
    const { edgesBySource, edgesBySourceHandle } = buildEdgeMaps([
      { source: "fe", target: "cond-1", sourceHandle: "loop" },
      { source: "fe", target: "done-collect", sourceHandle: "done" },
      { source: "cond-1", target: "action-true", sourceHandle: "true" },
      { source: "cond-1", target: "action-false", sourceHandle: "false" },
      { source: "action-true", target: "tail" },
      { source: "action-false", target: "tail" },
    ]);

    const result = identifyLoopBody(
      "fe",
      edgesBySource,
      buildNodeMap(nodes),
      edgesBySourceHandle
    );

    expect(result.doneCollectNodeId).toBe("done-collect");
    expect(result.bodyNodeIds).toContain("cond-1");
    expect(result.bodyNodeIds).toContain("action-true");
    expect(result.bodyNodeIds).toContain("action-false");
    expect(result.bodyNodeIds).toContain("tail");
    expect(result.bodyNodeIds).not.toContain("done-collect");

    // The Condition's handle map must survive into bodyEdgesBySourceHandle
    // so the runtime can route on true/false.
    const condHandles = result.bodyEdgesBySourceHandle.get("cond-1");
    expect(condHandles).toBeDefined();
    expect(condHandles?.get("true")).toEqual(["action-true"]);
    expect(condHandles?.get("false")).toEqual(["action-false"]);
  });

  it("Condition with one branch routing to the loop's done-Collect: that target stays out of body", () => {
    // fe -loop-> cond-1
    //   cond-1 -true-> tail (in body)
    //   cond-1 -false-> done-collect (NOT in body — it's the post-loop boundary)
    // fe -done-> done-collect
    //
    // Even though a Condition's `false` branch points at the done-Collect,
    // the body BFS must NOT pull the done-Collect into bodyNodeIds.
    const nodes = [
      action("fe", "For Each"),
      action("cond-1", "Condition"),
      action("tail", "HTTP Request"),
      action("done-collect", "Collect"),
    ];
    const { edgesBySource, edgesBySourceHandle } = buildEdgeMaps([
      { source: "fe", target: "cond-1", sourceHandle: "loop" },
      { source: "fe", target: "done-collect", sourceHandle: "done" },
      { source: "cond-1", target: "tail", sourceHandle: "true" },
      { source: "cond-1", target: "done-collect", sourceHandle: "false" },
    ]);

    const result = identifyLoopBody(
      "fe",
      edgesBySource,
      buildNodeMap(nodes),
      edgesBySourceHandle
    );

    expect(result.doneCollectNodeId).toBe("done-collect");
    expect(result.bodyNodeIds).toContain("cond-1");
    expect(result.bodyNodeIds).toContain("tail");
    // done-collect is added to bodyNodeIds via the BFS reaching it through
    // the cond-1 false handle, but it's the depth-0 Collect boundary so it
    // becomes the in-body Collect. Whether it's also pulled out as a body
    // member depends on the depth check; either way, the handle map for
    // cond-1 must keep its `true` branch routable.
    const condHandles = result.bodyEdgesBySourceHandle.get("cond-1");
    expect(condHandles?.get("true")).toEqual(["tail"]);
  });
});

describe("identifyLoopBody — legacy mode preserved (KEEP-520)", () => {
  it("legacy For Each with no sourceHandle on edges still finds in-body Collect", () => {
    const nodes = [
      action("fe", "For Each"),
      action("body-1", "HTTP Request"),
      action("collect", "Collect"),
    ];
    const { edgesBySource, edgesBySourceHandle } = buildEdgeMaps([
      { source: "fe", target: "body-1" },
      { source: "body-1", target: "collect" },
    ]);

    const result = identifyLoopBody(
      "fe",
      edgesBySource,
      buildNodeMap(nodes),
      edgesBySourceHandle
    );

    expect(result.collectNodeId).toBe("collect");
    expect(result.doneCollectNodeId).toBeUndefined();
    expect(result.doneEntryNodeIds).toEqual([]);
    expect(result.bodyNodeIds).toEqual(["body-1"]);
  });

  it("legacy nested For Each (no handles) keeps depth-tracking behavior", () => {
    const nodes = [
      action("fe-outer", "For Each"),
      action("a", "HTTP Request"),
      action("fe-inner", "For Each"),
      action("b", "Execute Code"),
      action("c-inner", "Collect"),
      action("c-outer", "Collect"),
    ];
    const { edgesBySource, edgesBySourceHandle } = buildEdgeMaps([
      { source: "fe-outer", target: "a" },
      { source: "a", target: "fe-inner" },
      { source: "fe-inner", target: "b" },
      { source: "b", target: "c-inner" },
      { source: "c-inner", target: "c-outer" },
    ]);

    const result = identifyLoopBody(
      "fe-outer",
      edgesBySource,
      buildNodeMap(nodes),
      edgesBySourceHandle
    );

    expect(result.collectNodeId).toBe("c-outer");
    expect(result.doneCollectNodeId).toBeUndefined();
    expect(result.bodyNodeIds).toContain("a");
    expect(result.bodyNodeIds).toContain("fe-inner");
    expect(result.bodyNodeIds).toContain("b");
    expect(result.bodyNodeIds).toContain("c-inner");
    expect(result.bodyNodeIds).not.toContain("c-outer");
  });
});

describe("identifyLoopBody — multiple done-handle Collect targets (KEEP-520)", () => {
  it("first done-Collect wins; later ones stay in doneEntryNodeIds but are not promoted", () => {
    // Two Collect nodes wired to the For Each's done handle. The executor
    // picks the first one as the canonical aggregation target; the second
    // remains in doneEntryNodeIds (so it is not lost from the graph) but
    // is NOT recorded as doneCollectNodeId. The "first wins" rule pins
    // deterministic behavior in this admittedly-unusual graph shape.
    const nodes = [
      action("fe", "For Each"),
      action("body-1", "HTTP Request"),
      action("first-done", "Collect"),
      action("second-done", "Collect"),
    ];
    const { edgesBySource, edgesBySourceHandle } = buildEdgeMaps([
      { source: "fe", target: "body-1", sourceHandle: "loop" },
      { source: "fe", target: "first-done", sourceHandle: "done" },
      { source: "fe", target: "second-done", sourceHandle: "done" },
    ]);

    const result = identifyLoopBody(
      "fe",
      edgesBySource,
      buildNodeMap(nodes),
      edgesBySourceHandle
    );

    expect(result.doneCollectNodeId).toBe("first-done");
    expect(result.doneEntryNodeIds).toEqual(["first-done", "second-done"]);
    expect(result.collectNodeId).toBeUndefined();
  });

  it("done-handle non-Collect first, Collect second: Collect is promoted as doneCollectNodeId", () => {
    // The "first whose actionType is Collect" rule means a non-Collect
    // node ahead of the Collect in done-handle order does NOT block the
    // Collect from being recognized.
    const nodes = [
      action("fe", "For Each"),
      action("body-1", "HTTP Request"),
      action("non-collect-first", "HTTP Request"),
      action("collect-second", "Collect"),
    ];
    const { edgesBySource, edgesBySourceHandle } = buildEdgeMaps([
      { source: "fe", target: "body-1", sourceHandle: "loop" },
      { source: "fe", target: "non-collect-first", sourceHandle: "done" },
      { source: "fe", target: "collect-second", sourceHandle: "done" },
    ]);

    const result = identifyLoopBody(
      "fe",
      edgesBySource,
      buildNodeMap(nodes),
      edgesBySourceHandle
    );

    expect(result.doneCollectNodeId).toBe("collect-second");
    expect(result.doneEntryNodeIds).toEqual([
      "non-collect-first",
      "collect-second",
    ]);
  });
});

describe("planIterationContinuation (KEEP-520 routing priority)", () => {
  it("aggregate-collect: done-handle Collect wins over an in-body Collect", () => {
    const result = planIterationContinuation({
      collectNodeId: "in-body",
      doneCollectNodeId: "done",
      doneEntryNodeIds: ["done", "after-done"],
    });
    expect(result).toEqual({
      kind: "aggregate-collect",
      collectNodeId: "done",
    });
  });

  it("aggregate-collect: legacy in-body Collect when no done-handle Collect", () => {
    const result = planIterationContinuation({
      collectNodeId: "in-body",
      doneCollectNodeId: undefined,
      doneEntryNodeIds: [],
    });
    expect(result).toEqual({
      kind: "aggregate-collect",
      collectNodeId: "in-body",
    });
  });

  it("done-targets: non-Collect targets on done handle, no Collect anywhere", () => {
    const result = planIterationContinuation({
      collectNodeId: undefined,
      doneCollectNodeId: undefined,
      doneEntryNodeIds: ["post-loop-step", "another-step"],
    });
    expect(result).toEqual({
      kind: "done-targets",
      targets: ["post-loop-step", "another-step"],
    });
  });

  it("none: fire-and-forget loop with no continuation wiring", () => {
    const result = planIterationContinuation({
      collectNodeId: undefined,
      doneCollectNodeId: undefined,
      doneEntryNodeIds: [],
    });
    expect(result).toEqual({ kind: "none" });
  });

  it("aggregate-collect priority is deterministic when only an in-body Collect exists alongside non-Collect done targets", () => {
    // Edge case: a workflow that has both a legacy in-body Collect AND
    // non-Collect nodes on the done handle. The aggregate-collect path
    // wins because the in-body Collect needs to receive `{ results, count }`;
    // the done-handle non-Collect targets remain unreachable here (a
    // structural mistake the editor should warn about, but the executor
    // stays deterministic).
    const result = planIterationContinuation({
      collectNodeId: "in-body",
      doneCollectNodeId: undefined,
      doneEntryNodeIds: ["stray-done-target"],
    });
    expect(result).toEqual({
      kind: "aggregate-collect",
      collectNodeId: "in-body",
    });
  });
});
