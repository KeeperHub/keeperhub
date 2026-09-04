/**
 * Regression tests for issue #2157:
 *   "Nested For Each can cross an ancestor loop's Collect boundary (crash
 *    or silent double-fire)"
 *
 * Two topologies from the issue, both against a two-level nesting
 * (for-each-circles outer, for-each-members inner):
 *
 *   Scenario 1 (crash, misleading message): the inner loop's body reaches
 *   both its own Collect and the outer's Collect in one scan. Before this
 *   fix, `identifyLoopBody` threw the generic "multiple in-body Collect
 *   nodes" message, which reads as "you wired two Collects into one loop"
 *   when the real cause is that one belongs to a different, enclosing loop.
 *
 *   Scenario 2 (silent adoption, no error): the inner loop has no Collect of
 *   its own, so its scan resolves `collectNodeId` to the outer's Collect and
 *   returns successfully. Before this fix, nothing caught this.
 *
 * The fix: `identifyLoopBody` takes an optional `claimedCollectOwners` map
 * (Collect node id -> owning forEachNodeId). Both scenarios now throw the
 * same precise ownership error, naming the contested Collect and both
 * loops, the instant the scan reaches an already-claimed Collect. That only
 * gives the right answer if ancestor loops are claimed before their
 * descendants are scanned -- `orderForEachNodesOuterFirst` establishes that
 * order; see the "ordering" describe block below for what goes wrong
 * without it.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildEdgesBySourceHandle } from "@/lib/workflow/editor/edge-handle-utils";
import { buildEdgesBySource } from "@/lib/workflow/executor/convergence-barrier";
import {
  claimCollectOwner,
  identifyLoopBody,
  orderForEachNodesOuterFirst,
} from "@/lib/workflow/executor/executor.workflow";
import type { WorkflowNode } from "@/lib/workflow/store";

// ---------------------------------------------------------------------------
// Top-level regex patterns (biome: useTopLevelRegex)
// ---------------------------------------------------------------------------

const OWNERSHIP_REGEX = /already belongs to For Each "for-each-circles"/;
const MULTIPLE_COLLECT_REGEX = /multiple in-body Collect nodes/;

// ---------------------------------------------------------------------------
// Minimal node / edge factory helpers (mirrors for-each-nested-edge-map.test.ts)
// ---------------------------------------------------------------------------

function makeNode(id: string, actionType: string): WorkflowNode {
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

type RawEdge = {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
};

let _edgeSeq = 0;
function makeEdge(
  source: string,
  target: string,
  sourceHandle?: string
): RawEdge {
  return {
    id: `e${++_edgeSeq}`,
    source,
    target,
    sourceHandle: sourceHandle ?? null,
  };
}

function buildNodeMap(nodes: WorkflowNode[]): Map<string, WorkflowNode> {
  return new Map(nodes.map((n) => [n.id, n]));
}

/**
 * The exact wording the executor produces for an ownership conflict, spelled
 * out here so a change to it has to be a deliberate change to this test too.
 * It names both loops and the Collect and asserts nothing about ancestry,
 * because neither detection site tests for ancestry.
 */
function ownershipMessage(
  collectNodeId: string,
  forEachId: string,
  claimedBy: string
): string {
  return (
    `For Each "${forEachId}" resolves Collect "${collectNodeId}", but it ` +
    `already belongs to For Each "${claimedBy}". Two For Each loops ` +
    "cannot share the same Collect node."
  );
}

/**
 * The start-up Collect-ownership pass exactly as `executeWorkflow` runs it:
 * order the loops outer-first, scan each one against the claims made so far,
 * then claim every Collect it resolves - the in-body one and every Collect
 * on its done handle, not only the promoted `doneCollectNodeId`.
 *
 * The executor runs this loop inline, so there is no exported entry point to
 * call; this mirror has to be kept in step with it by hand.
 */
function runCollectOwnershipPass(
  nodes: WorkflowNode[],
  edges: RawEdge[]
): Map<string, string> {
  const edgesBySource = buildEdgesBySource(edges);
  const edgesBySourceHandle = buildEdgesBySourceHandle(edges);
  const nodeMap = buildNodeMap(nodes);
  const claimed = new Map<string, string>();

  const forEachNodeIds = nodes
    .filter(
      (n) =>
        n.data.type === "action" && n.data.config?.actionType === "For Each"
    )
    .map((n) => n.id);

  for (const forEachId of orderForEachNodesOuterFirst(
    forEachNodeIds,
    edgesBySource,
    nodeMap,
    edgesBySourceHandle
  )) {
    const body = identifyLoopBody(
      forEachId,
      edgesBySource,
      nodeMap,
      edgesBySourceHandle,
      claimed
    );
    if (body.collectNodeId) {
      claimCollectOwner(claimed, body.collectNodeId, forEachId);
    }
    for (const doneEntryNodeId of body.doneEntryNodeIds) {
      const doneEntryNode = nodeMap.get(doneEntryNodeId);
      if (
        doneEntryNode?.data.type === "action" &&
        doneEntryNode.data.config?.actionType === "Collect"
      ) {
        claimCollectOwner(claimed, doneEntryNodeId, forEachId);
      }
    }
  }

  return claimed;
}

/** The message thrown by `run`, or "" if it did not throw. */
function messageFrom(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as Error).message;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Scenario 1: inner body reaches both its own Collect and the ancestor's
//
//   for-each-circles --loop--> for-each-members --loop--> write-cover-default
//   for-each-circles --done--> collect-circles
//   for-each-members --done--> collect-members
//   write-cover-default --> collect-members   (the inner's own)
//   write-cover-default --> collect-circles   (the extra edge -- the bug)
// ---------------------------------------------------------------------------

describe("Scenario 1: inner scan reaches an ancestor's Collect alongside its own", () => {
  const nodes: WorkflowNode[] = [
    makeNode("for-each-circles", "For Each"),
    makeNode("for-each-members", "For Each"),
    makeNode("write-cover-default", "Write Contract"),
    makeNode("collect-members", "Collect"),
    makeNode("collect-circles", "Collect"),
  ];
  const edges: RawEdge[] = [
    makeEdge("for-each-circles", "for-each-members", "loop"),
    makeEdge("for-each-circles", "collect-circles", "done"),
    makeEdge("for-each-members", "write-cover-default", "loop"),
    makeEdge("for-each-members", "collect-members", "done"),
    makeEdge("write-cover-default", "collect-members"),
    makeEdge("write-cover-default", "collect-circles"),
  ];
  const edgesBySource = buildEdgesBySource(edges);
  const edgesBySourceHandle = buildEdgesBySourceHandle(edges);
  const nodeMap = buildNodeMap(nodes);

  it("throws the ownership error once the outer Collect is claimed", () => {
    const claimed = new Map<string, string>([
      ["collect-circles", "for-each-circles"],
    ]);

    expect(() =>
      identifyLoopBody(
        "for-each-members",
        edgesBySource,
        nodeMap,
        edgesBySourceHandle,
        claimed
      )
    ).toThrow(OWNERSHIP_REGEX);
  });

  it("falls back to the generic double-Collect message with no ownership context", () => {
    // No claimed map at all -- today's unqualified behavior, unchanged.
    // Both Collects look equally "unowned" from inside this one scan, so the
    // message can only say what it always said.
    expect(() =>
      identifyLoopBody(
        "for-each-members",
        edgesBySource,
        nodeMap,
        edgesBySourceHandle
      )
    ).toThrow(MULTIPLE_COLLECT_REGEX);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: inner has no Collect of its own, silently adopts the outer's
//
//   for-each-circles --loop--> for-each-members --loop--> write-cover-default
//   for-each-circles --done--> collect-circles
//   write-cover-default --> collect-circles   (inner has no done-handle Collect)
// ---------------------------------------------------------------------------

describe("Scenario 2: inner has no Collect of its own and would silently adopt the outer's", () => {
  const nodes: WorkflowNode[] = [
    makeNode("for-each-circles", "For Each"),
    makeNode("for-each-members", "For Each"),
    makeNode("write-cover-default", "Write Contract"),
    makeNode("collect-circles", "Collect"),
  ];
  const edges: RawEdge[] = [
    makeEdge("for-each-circles", "for-each-members", "loop"),
    makeEdge("for-each-circles", "collect-circles", "done"),
    makeEdge("for-each-members", "write-cover-default", "loop"),
    makeEdge("write-cover-default", "collect-circles"),
  ];
  const edgesBySource = buildEdgesBySource(edges);
  const edgesBySourceHandle = buildEdgesBySourceHandle(edges);
  const nodeMap = buildNodeMap(nodes);

  it("resolves collectNodeId to the outer's Collect when unclaimed (pre-fix shape)", () => {
    const innerBody = identifyLoopBody(
      "for-each-members",
      edgesBySource,
      nodeMap,
      edgesBySourceHandle
    );
    expect(innerBody.collectNodeId).toBe("collect-circles");
  });

  it("throws the ownership error once the outer Collect is claimed", () => {
    const claimed = new Map<string, string>([
      ["collect-circles", "for-each-circles"],
    ]);

    expect(() =>
      identifyLoopBody(
        "for-each-members",
        edgesBySource,
        nodeMap,
        edgesBySourceHandle,
        claimed
      )
    ).toThrow(OWNERSHIP_REGEX);
  });
});

// ---------------------------------------------------------------------------
// Happy path: genuinely separate Collects at each level -- no conflict
// ---------------------------------------------------------------------------

describe("two nested loops with their own Collects: no conflict", () => {
  const nodes: WorkflowNode[] = [
    makeNode("for-each-circles", "For Each"),
    makeNode("for-each-members", "For Each"),
    makeNode("write-cover-default", "Write Contract"),
    makeNode("collect-members", "Collect"),
    makeNode("collect-circles", "Collect"),
  ];
  const edges: RawEdge[] = [
    makeEdge("for-each-circles", "for-each-members", "loop"),
    makeEdge("for-each-circles", "collect-circles", "done"),
    makeEdge("for-each-members", "write-cover-default", "loop"),
    makeEdge("for-each-members", "collect-members", "done"),
    makeEdge("write-cover-default", "collect-members"),
  ];
  const edgesBySource = buildEdgesBySource(edges);
  const edgesBySourceHandle = buildEdgesBySourceHandle(edges);
  const nodeMap = buildNodeMap(nodes);

  it("claims each loop's own Collect without throwing when processed outer-first", () => {
    const claimed = new Map<string, string>();
    const outerBody = identifyLoopBody(
      "for-each-circles",
      edgesBySource,
      nodeMap,
      edgesBySourceHandle,
      claimed
    );
    if (outerBody.doneCollectNodeId) {
      claimed.set(outerBody.doneCollectNodeId, "for-each-circles");
    }

    const innerBody = identifyLoopBody(
      "for-each-members",
      edgesBySource,
      nodeMap,
      edgesBySourceHandle,
      claimed
    );

    expect(outerBody.doneCollectNodeId).toBe("collect-circles");
    expect(innerBody.collectNodeId).toBe("collect-members");
  });
});

// ---------------------------------------------------------------------------
// Ordering: outer-before-inner is load-bearing, not incidental
// ---------------------------------------------------------------------------

describe("ordering: the ownership check only works outer-before-inner", () => {
  // Scenario 2's topology again -- inner silently resolves the outer's
  // Collect as its own when nothing has claimed it yet.
  const nodes: WorkflowNode[] = [
    makeNode("for-each-circles", "For Each"),
    makeNode("for-each-members", "For Each"),
    makeNode("write-cover-default", "Write Contract"),
    makeNode("collect-circles", "Collect"),
  ];
  const edges: RawEdge[] = [
    makeEdge("for-each-circles", "for-each-members", "loop"),
    makeEdge("for-each-circles", "collect-circles", "done"),
    makeEdge("for-each-members", "write-cover-default", "loop"),
    makeEdge("write-cover-default", "collect-circles"),
  ];
  const edgesBySource = buildEdgesBySource(edges);
  const edgesBySourceHandle = buildEdgesBySourceHandle(edges);
  const nodeMap = buildNodeMap(nodes);

  it("processing the inner loop first mis-claims the outer's Collect with no error", () => {
    const claimed = new Map<string, string>();

    // Inner processed before outer: nothing is claimed yet, so the inner
    // loop's scan resolves collect-circles as its own -- no throw, the
    // exact silent-adoption bug this issue reports.
    const innerBody = identifyLoopBody(
      "for-each-members",
      edgesBySource,
      nodeMap,
      edgesBySourceHandle,
      claimed
    );
    if (innerBody.collectNodeId) {
      claimed.set(innerBody.collectNodeId, "for-each-members");
    }

    expect(innerBody.collectNodeId).toBe("collect-circles");
    expect(claimed.get("collect-circles")).toBe("for-each-members");
  });

  it("orderForEachNodesOuterFirst places the ancestor before its nested loop", () => {
    const ordered = orderForEachNodesOuterFirst(
      ["for-each-members", "for-each-circles"], // deliberately reversed input
      edgesBySource,
      nodeMap,
      edgesBySourceHandle
    );

    expect(ordered.indexOf("for-each-circles")).toBeLessThan(
      ordered.indexOf("for-each-members")
    );
  });

  it("processing in that order surfaces the real ownership conflict instead", () => {
    const claimed = new Map<string, string>();
    const ordered = orderForEachNodesOuterFirst(
      ["for-each-members", "for-each-circles"],
      edgesBySource,
      nodeMap,
      edgesBySourceHandle
    );

    for (const forEachId of ordered) {
      if (forEachId === "for-each-circles") {
        const outerBody = identifyLoopBody(
          forEachId,
          edgesBySource,
          nodeMap,
          edgesBySourceHandle,
          claimed
        );
        if (outerBody.doneCollectNodeId) {
          claimed.set(outerBody.doneCollectNodeId, forEachId);
        }
        continue;
      }

      expect(() =>
        identifyLoopBody(
          forEachId,
          edgesBySource,
          nodeMap,
          edgesBySourceHandle,
          claimed
        )
      ).toThrow(OWNERSHIP_REGEX);
    }
  });
});

// ---------------------------------------------------------------------------
// orderForEachNodesOuterFirst: direct coverage beyond the two-level case above
// ---------------------------------------------------------------------------

describe("orderForEachNodesOuterFirst", () => {
  it("keeps independent sibling loops in their given relative order", () => {
    // Each loop has a real body, so both BFS walks actually run and both
    // report no nested loop. With `done` edges alone the walks would seed
    // from nothing and the assertion would hold for any implementation.
    const nodes: WorkflowNode[] = [
      makeNode("fe-a", "For Each"),
      makeNode("fe-b", "For Each"),
      makeNode("step-a", "HTTP Request"),
      makeNode("step-b", "HTTP Request"),
      makeNode("collect-a", "Collect"),
      makeNode("collect-b", "Collect"),
    ];
    const edges: RawEdge[] = [
      makeEdge("fe-a", "step-a", "loop"),
      makeEdge("fe-a", "collect-a", "done"),
      makeEdge("step-a", "collect-a"),
      makeEdge("fe-b", "step-b", "loop"),
      makeEdge("fe-b", "collect-b", "done"),
      makeEdge("step-b", "collect-b"),
    ];
    const edgesBySource = buildEdgesBySource(edges);
    const edgesBySourceHandle = buildEdgesBySourceHandle(edges);
    const nodeMap = buildNodeMap(nodes);

    expect(
      orderForEachNodesOuterFirst(
        ["fe-a", "fe-b"],
        edgesBySource,
        nodeMap,
        edgesBySourceHandle
      )
    ).toEqual(["fe-a", "fe-b"]);

    // Neither loop encloses the other, so the input order is the only thing
    // deciding the output order - reversing the input reverses the output.
    expect(
      orderForEachNodesOuterFirst(
        ["fe-b", "fe-a"],
        edgesBySource,
        nodeMap,
        edgesBySourceHandle
      )
    ).toEqual(["fe-b", "fe-a"]);
  });

  it("orders 3-level nesting strictly outer to inner regardless of input order", () => {
    const nodes: WorkflowNode[] = [
      makeNode("fe-l1", "For Each"),
      makeNode("fe-l2", "For Each"),
      makeNode("fe-l3", "For Each"),
      makeNode("collect-l1", "Collect"),
      makeNode("collect-l2", "Collect"),
      makeNode("collect-l3", "Collect"),
    ];
    const edges: RawEdge[] = [
      makeEdge("fe-l1", "fe-l2", "loop"),
      makeEdge("fe-l1", "collect-l1", "done"),
      makeEdge("fe-l2", "fe-l3", "loop"),
      makeEdge("fe-l2", "collect-l2", "done"),
      makeEdge("fe-l3", "collect-l3", "done"),
    ];
    const edgesBySource = buildEdgesBySource(edges);
    const edgesBySourceHandle = buildEdgesBySourceHandle(edges);
    const nodeMap = buildNodeMap(nodes);

    const ordered = orderForEachNodesOuterFirst(
      ["fe-l3", "fe-l1", "fe-l2"], // deliberately scrambled
      edgesBySource,
      nodeMap,
      edgesBySourceHandle
    );

    expect(ordered).toEqual(["fe-l1", "fe-l2", "fe-l3"]);
  });
});

// ---------------------------------------------------------------------------
// claimCollectOwner: the other place the conflict surfaces
//
// The BFS check only fires for a Collect a scan walks into. A Collect
// resolved off the done handle never enters the BFS, so the pass claims it
// afterwards and this function is what a user hits instead.
// ---------------------------------------------------------------------------

describe("claimCollectOwner", () => {
  it("records the owner of an unclaimed Collect", () => {
    const claimed = new Map<string, string>();

    claimCollectOwner(claimed, "collect-a", "fe-a");

    expect(claimed.get("collect-a")).toBe("fe-a");
  });

  it("is idempotent for the loop that already owns the Collect", () => {
    const claimed = new Map<string, string>([["collect-a", "fe-a"]]);

    expect(() => claimCollectOwner(claimed, "collect-a", "fe-a")).not.toThrow();
    expect(claimed.get("collect-a")).toBe("fe-a");
  });

  it("throws naming both loops and the Collect when another loop owns it", () => {
    const claimed = new Map<string, string>([["collect-a", "fe-a"]]);

    const message = messageFrom(() =>
      claimCollectOwner(claimed, "collect-a", "fe-b")
    );

    expect(message).toBe(ownershipMessage("collect-a", "fe-b", "fe-a"));
  });

  it("leaves the existing owner in place when it throws", () => {
    const claimed = new Map<string, string>([["collect-a", "fe-a"]]);

    messageFrom(() => claimCollectOwner(claimed, "collect-a", "fe-b"));

    expect(claimed.get("collect-a")).toBe("fe-a");
  });
});

// ---------------------------------------------------------------------------
// Legacy (no sourceHandle) topologies
//
// Nothing above uses a handle-free graph, so `findDirectNestedForEachIds`'s
// legacy seeding - every outgoing edge, not just the `loop` handle - and its
// descent through legacy nested loops go untested by the scenarios.
// ---------------------------------------------------------------------------

describe("legacy topologies", () => {
  it("orders a legacy nested loop after its enclosing loop", () => {
    //   fe-outer -> fe-inner -> step -> collect-inner -> collect-outer
    // No sourceHandle anywhere, so both scans seed from edgesBySource and
    // the nested loop is only found by descending through it.
    const nodes: WorkflowNode[] = [
      makeNode("fe-outer", "For Each"),
      makeNode("fe-inner", "For Each"),
      makeNode("step", "HTTP Request"),
      makeNode("collect-inner", "Collect"),
      makeNode("collect-outer", "Collect"),
    ];
    const edges: RawEdge[] = [
      makeEdge("fe-outer", "fe-inner"),
      makeEdge("fe-inner", "step"),
      makeEdge("step", "collect-inner"),
      makeEdge("collect-inner", "collect-outer"),
    ];
    const edgesBySource = buildEdgesBySource(edges);
    const edgesBySourceHandle = buildEdgesBySourceHandle(edges);
    const nodeMap = buildNodeMap(nodes);

    const ordered = orderForEachNodesOuterFirst(
      ["fe-inner", "fe-outer"], // deliberately reversed input
      edgesBySource,
      nodeMap,
      edgesBySourceHandle
    );

    expect(ordered).toEqual(["fe-outer", "fe-inner"]);
  });

  it("blames whichever legacy sibling loop is processed second, in neutral wording", () => {
    //   fe-a -> step-a -> shared
    //   fe-b -> step-b -> shared
    // Two loops that do not nest at all, wired to one Collect. The pass
    // throws, and the message must not claim either loop encloses the other:
    // nothing here established that, and which loop is blamed is decided by
    // the order the loops arrive in.
    const nodes: WorkflowNode[] = [
      makeNode("fe-a", "For Each"),
      makeNode("fe-b", "For Each"),
      makeNode("step-a", "HTTP Request"),
      makeNode("step-b", "HTTP Request"),
      makeNode("shared", "Collect"),
    ];
    const edges: RawEdge[] = [
      makeEdge("fe-a", "step-a"),
      makeEdge("fe-b", "step-b"),
      makeEdge("step-a", "shared"),
      makeEdge("step-b", "shared"),
    ];

    const message = messageFrom(() => runCollectOwnershipPass(nodes, edges));

    expect(message).toBe(ownershipMessage("shared", "fe-b", "fe-a"));
    expect(message).not.toContain("ancestor");
  });

  it("names the loops the other way round when the node order is swapped", () => {
    // Same graph, `fe-b` declared first. Neither loop is nested in the
    // other, so the blame flips - which is exactly why the message may not
    // describe one loop as the other's ancestor.
    const nodes: WorkflowNode[] = [
      makeNode("fe-b", "For Each"),
      makeNode("fe-a", "For Each"),
      makeNode("step-a", "HTTP Request"),
      makeNode("step-b", "HTTP Request"),
      makeNode("shared", "Collect"),
    ];
    const edges: RawEdge[] = [
      makeEdge("fe-a", "step-a"),
      makeEdge("fe-b", "step-b"),
      makeEdge("step-a", "shared"),
      makeEdge("step-b", "shared"),
    ];

    expect(messageFrom(() => runCollectOwnershipPass(nodes, edges))).toBe(
      ownershipMessage("shared", "fe-a", "fe-b")
    );
  });

  it("parents a grandchild loop to its nearest enclosing loop, not the first one to reach it", () => {
    //   fe-l1 -> fe-l3        (the diamond's short edge)
    //   fe-l1 -> fe-l2 -> fe-l3 -> collect-l3 -> collect-l2 -> collect-l1
    // Legacy descent is transitive, so fe-l1 reports fe-l3 as nested too,
    // and it reports it before fe-l2. Parenting fe-l3 to the first reporter
    // would order it ahead of fe-l2 and invert outer-before-inner.
    const nodes: WorkflowNode[] = [
      makeNode("fe-l1", "For Each"),
      makeNode("fe-l2", "For Each"),
      makeNode("fe-l3", "For Each"),
      makeNode("collect-l3", "Collect"),
      makeNode("collect-l2", "Collect"),
      makeNode("collect-l1", "Collect"),
    ];
    const edges: RawEdge[] = [
      makeEdge("fe-l1", "fe-l3"),
      makeEdge("fe-l1", "fe-l2"),
      makeEdge("fe-l2", "fe-l3"),
      makeEdge("fe-l3", "collect-l3"),
      makeEdge("collect-l3", "collect-l2"),
      makeEdge("collect-l2", "collect-l1"),
    ];
    const edgesBySource = buildEdgesBySource(edges);
    const edgesBySourceHandle = buildEdgesBySourceHandle(edges);
    const nodeMap = buildNodeMap(nodes);

    const ordered = orderForEachNodesOuterFirst(
      ["fe-l1", "fe-l2", "fe-l3"],
      edgesBySource,
      nodeMap,
      edgesBySourceHandle
    );

    expect(ordered).toEqual(["fe-l1", "fe-l2", "fe-l3"]);
  });
});

// ---------------------------------------------------------------------------
// More than one done-handle Collect
//
// `identifyLoopBody` stops promoting at the first Collect among the done
// targets ("first done-Collect wins"), so the later ones are resolved by
// the loop but never promoted. The pass has to claim them all, or a nested
// loop can still adopt one in silence.
// ---------------------------------------------------------------------------

describe("a loop with two done-handle Collects", () => {
  const nodes: WorkflowNode[] = [
    makeNode("fe-outer", "For Each"),
    makeNode("fe-inner", "For Each"),
    makeNode("step", "HTTP Request"),
    makeNode("first-done", "Collect"),
    makeNode("second-done", "Collect"),
  ];
  const edges: RawEdge[] = [
    makeEdge("fe-outer", "fe-inner", "loop"),
    makeEdge("fe-outer", "first-done", "done"),
    makeEdge("fe-outer", "second-done", "done"),
    makeEdge("fe-inner", "step", "loop"),
    makeEdge("step", "second-done"),
  ];

  it("claims both of them for the loop that owns them", () => {
    // The same loop on its own: only `first-done` is promoted to
    // `doneCollectNodeId`, but both must end up owned.
    const claimed = runCollectOwnershipPass(
      [
        makeNode("fe-outer", "For Each"),
        makeNode("step", "HTTP Request"),
        makeNode("first-done", "Collect"),
        makeNode("second-done", "Collect"),
      ],
      [
        makeEdge("fe-outer", "step", "loop"),
        makeEdge("fe-outer", "first-done", "done"),
        makeEdge("fe-outer", "second-done", "done"),
      ]
    );

    expect(claimed.get("first-done")).toBe("fe-outer");
    expect(claimed.get("second-done")).toBe("fe-outer");
  });

  it("stops a nested loop adopting the one that was never promoted", () => {
    expect(messageFrom(() => runCollectOwnershipPass(nodes, edges))).toBe(
      ownershipMessage("second-done", "fe-inner", "fe-outer")
    );
  });
});

// ---------------------------------------------------------------------------
// Regression guard: the canonical chained-Collect topology stays legal
//
// The same graph as the 3-level case in for-each-nested-edge-map.test.ts,
// where each level's Collect feeds the next level's. The depth counter is
// what keeps that legal: an inner Collect is reached at depth 1, so it is
// not the outer loop's boundary, and the outer loop resolves the Collect one
// step further out. The ordering test above uses isolated Collects and never
// exercises that arithmetic.
// ---------------------------------------------------------------------------

describe("chained Collects across three nesting levels", () => {
  const nodes: WorkflowNode[] = [
    makeNode("fe-l1", "For Each"),
    makeNode("fe-l2", "For Each"),
    makeNode("fe-l3", "For Each"),
    makeNode("read-data", "Read Contract"),
    makeNode("condition-deep", "Condition"),
    makeNode("write-result", "Write Contract"),
    makeNode("collect-l3", "Collect"),
    makeNode("collect-l2", "Collect"),
    makeNode("collect-l1", "Collect"),
  ];
  const edges: RawEdge[] = [
    makeEdge("fe-l1", "fe-l2", "loop"),
    makeEdge("fe-l1", "collect-l1", "done"),
    makeEdge("fe-l2", "fe-l3", "loop"),
    makeEdge("fe-l2", "collect-l2", "done"),
    makeEdge("fe-l3", "read-data", "loop"),
    makeEdge("fe-l3", "collect-l3", "done"),
    makeEdge("read-data", "condition-deep"),
    makeEdge("condition-deep", "write-result", "true"),
    makeEdge("write-result", "collect-l3"),
    makeEdge("collect-l3", "collect-l2"),
    makeEdge("collect-l2", "collect-l1"),
  ];

  it("passes the ownership pass with each level owning its own Collect", () => {
    const claimed = runCollectOwnershipPass(nodes, edges);

    expect(claimed.get("collect-l1")).toBe("fe-l1");
    expect(claimed.get("collect-l2")).toBe("fe-l2");
    expect(claimed.get("collect-l3")).toBe("fe-l3");
  });
});
