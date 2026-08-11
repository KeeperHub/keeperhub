import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildEdgesBySourceHandle } from "@/lib/workflow/editor/edge-handle-utils";
import {
  evaluateConditionExpression,
  resolveBodyConditionTargets,
} from "@/lib/workflow/executor/executor.workflow";

type EdgeLike = {
  source: string;
  target: string;
  sourceHandle?: string | null;
};

function createEdge(
  source: string,
  target: string,
  sourceHandle?: string
): EdgeLike {
  return { source, target, sourceHandle };
}

/**
 * Build bodyEdgesBySource (handle-agnostic) from edges, same as the executor
 * does for the For Each body subgraph.
 */
function buildBodyEdgesBySource(edges: EdgeLike[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const edge of edges) {
    if (!map.has(edge.source)) {
      map.set(edge.source, []);
    }
    map.get(edge.source)?.push(edge.target);
  }
  return map;
}

/**
 * Simulates the executor's bodyEdgesBySourceHandle filtering
 * (workflow-executor.workflow.ts identifyLoopBody, lines 935-953).
 * Only keeps handle entries whose targets are in the body node set.
 */
function filterHandleMapToBody(
  fullHandleMap: ReturnType<typeof buildEdgesBySourceHandle>,
  bodyNodeIds: string[]
): ReturnType<typeof buildEdgesBySourceHandle> {
  const bodyNodeSet = new Set(bodyNodeIds);
  const filtered = new Map<string, Map<string, string[]>>();
  for (const nodeId of bodyNodeIds) {
    const nodeHandleMap = fullHandleMap.get(nodeId);
    if (!nodeHandleMap) {
      continue;
    }
    const filteredHandleMap = new Map<string, string[]>();
    for (const [handle, targets] of nodeHandleMap) {
      const filteredTargets = targets.filter((t) => bodyNodeSet.has(t));
      if (filteredTargets.length > 0) {
        filteredHandleMap.set(handle, filteredTargets);
      }
    }
    if (filteredHandleMap.size > 0) {
      filtered.set(nodeId, filteredHandleMap);
    }
  }
  return filtered;
}

describe("condition routing inside For Each body", () => {
  describe("one-sided condition: only true-handle edge, false result", () => {
    // Reproduces the exact bug: condition with only a true-handle edge,
    // condition evaluates false, but downstream nodes still execute
    const edges: EdgeLike[] = [
      createEdge("compare-tokens", "already-cast", "true"),
    ];
    const bodyNodeIds = ["compare-tokens", "already-cast", "search-db"];
    const bodyEdges: EdgeLike[] = [
      createEdge("compare-tokens", "already-cast", "true"),
      createEdge("already-cast", "search-db", "false"),
    ];

    it("should NOT route to true-branch target when condition is false", () => {
      const fullHandleMap = buildEdgesBySourceHandle(edges);
      const bodyHandleMap = filterHandleMapToBody(fullHandleMap, bodyNodeIds);
      const bodyEdgesBySource = buildBodyEdgesBySource(bodyEdges);

      const targets = resolveBodyConditionTargets(
        false,
        "compare-tokens",
        bodyHandleMap,
        bodyEdgesBySource
      );

      expect(targets).toEqual([]);
    });

    it("should route to true-branch target when condition is true", () => {
      const fullHandleMap = buildEdgesBySourceHandle(edges);
      const bodyHandleMap = filterHandleMapToBody(fullHandleMap, bodyNodeIds);
      const bodyEdgesBySource = buildBodyEdgesBySource(bodyEdges);

      const targets = resolveBodyConditionTargets(
        true,
        "compare-tokens",
        bodyHandleMap,
        bodyEdgesBySource
      );

      expect(targets).toEqual(["already-cast"]);
    });
  });

  describe("one-sided condition: only false-handle edge", () => {
    const edges: EdgeLike[] = [
      createEdge("cond-check", "error-handler", "false"),
    ];
    const bodyNodeIds = ["cond-check", "error-handler"];

    it("should route to false-branch target when condition is false", () => {
      const fullHandleMap = buildEdgesBySourceHandle(edges);
      const bodyHandleMap = filterHandleMapToBody(fullHandleMap, bodyNodeIds);
      const bodyEdgesBySource = buildBodyEdgesBySource(edges);

      const targets = resolveBodyConditionTargets(
        false,
        "cond-check",
        bodyHandleMap,
        bodyEdgesBySource
      );

      expect(targets).toEqual(["error-handler"]);
    });

    it("should NOT route to false-branch target when condition is true", () => {
      const fullHandleMap = buildEdgesBySourceHandle(edges);
      const bodyHandleMap = filterHandleMapToBody(fullHandleMap, bodyNodeIds);
      const bodyEdgesBySource = buildBodyEdgesBySource(edges);

      const targets = resolveBodyConditionTargets(
        true,
        "cond-check",
        bodyHandleMap,
        bodyEdgesBySource
      );

      expect(targets).toEqual([]);
    });
  });

  describe("both handles present", () => {
    const edges: EdgeLike[] = [
      createEdge("cond-1", "action-a", "true"),
      createEdge("cond-1", "action-b", "false"),
    ];
    const bodyNodeIds = ["cond-1", "action-a", "action-b"];

    it("should route to true target when true", () => {
      const fullHandleMap = buildEdgesBySourceHandle(edges);
      const bodyHandleMap = filterHandleMapToBody(fullHandleMap, bodyNodeIds);
      const bodyEdgesBySource = buildBodyEdgesBySource(edges);

      const targets = resolveBodyConditionTargets(
        true,
        "cond-1",
        bodyHandleMap,
        bodyEdgesBySource
      );

      expect(targets).toEqual(["action-a"]);
    });

    it("should route to false target when false", () => {
      const fullHandleMap = buildEdgesBySourceHandle(edges);
      const bodyHandleMap = filterHandleMapToBody(fullHandleMap, bodyNodeIds);
      const bodyEdgesBySource = buildBodyEdgesBySource(edges);

      const targets = resolveBodyConditionTargets(
        false,
        "cond-1",
        bodyHandleMap,
        bodyEdgesBySource
      );

      expect(targets).toEqual(["action-b"]);
    });
  });

  describe("multiple downstream conditions in For Each body", () => {
    //   forEach -> action-read -> cond-1 (true-only) -> cond-2 (both) -> action-true / action-false
    const allEdges: EdgeLike[] = [
      createEdge("action-read", "cond-1", undefined),
      createEdge("cond-1", "cond-2", "true"),
      createEdge("cond-2", "action-true", "true"),
      createEdge("cond-2", "action-false", "false"),
    ];
    const bodyNodeIds = [
      "action-read",
      "cond-1",
      "cond-2",
      "action-true",
      "action-false",
    ];

    it("cond-1=false should stop the chain entirely", () => {
      const fullHandleMap = buildEdgesBySourceHandle(allEdges);
      const bodyHandleMap = filterHandleMapToBody(fullHandleMap, bodyNodeIds);
      const bodyEdgesBySource = buildBodyEdgesBySource(allEdges);

      const targets = resolveBodyConditionTargets(
        false,
        "cond-1",
        bodyHandleMap,
        bodyEdgesBySource
      );

      expect(targets).toEqual([]);
    });

    it("cond-1=true, cond-2=true should reach action-true", () => {
      const fullHandleMap = buildEdgesBySourceHandle(allEdges);
      const bodyHandleMap = filterHandleMapToBody(fullHandleMap, bodyNodeIds);
      const bodyEdgesBySource = buildBodyEdgesBySource(allEdges);

      const cond1Targets = resolveBodyConditionTargets(
        true,
        "cond-1",
        bodyHandleMap,
        bodyEdgesBySource
      );
      expect(cond1Targets).toEqual(["cond-2"]);

      const cond2Targets = resolveBodyConditionTargets(
        true,
        "cond-2",
        bodyHandleMap,
        bodyEdgesBySource
      );
      expect(cond2Targets).toEqual(["action-true"]);
    });

    it("cond-1=true, cond-2=false should reach action-false", () => {
      const fullHandleMap = buildEdgesBySourceHandle(allEdges);
      const bodyHandleMap = filterHandleMapToBody(fullHandleMap, bodyNodeIds);
      const bodyEdgesBySource = buildBodyEdgesBySource(allEdges);

      const cond1Targets = resolveBodyConditionTargets(
        true,
        "cond-1",
        bodyHandleMap,
        bodyEdgesBySource
      );
      expect(cond1Targets).toEqual(["cond-2"]);

      const cond2Targets = resolveBodyConditionTargets(
        false,
        "cond-2",
        bodyHandleMap,
        bodyEdgesBySource
      );
      expect(cond2Targets).toEqual(["action-false"]);
    });
  });

  describe("chained one-sided conditions (all true-only)", () => {
    // cond-a (true) -> cond-b (true) -> cond-c (true) -> final-action
    const edges: EdgeLike[] = [
      createEdge("cond-a", "cond-b", "true"),
      createEdge("cond-b", "cond-c", "true"),
      createEdge("cond-c", "final-action", "true"),
    ];
    const bodyNodeIds = ["cond-a", "cond-b", "cond-c", "final-action"];

    it("all true should reach final-action", () => {
      const fullHandleMap = buildEdgesBySourceHandle(edges);
      const bodyHandleMap = filterHandleMapToBody(fullHandleMap, bodyNodeIds);
      const bodyEdgesBySource = buildBodyEdgesBySource(edges);

      const aTargets = resolveBodyConditionTargets(
        true,
        "cond-a",
        bodyHandleMap,
        bodyEdgesBySource
      );
      expect(aTargets).toEqual(["cond-b"]);

      const bTargets = resolveBodyConditionTargets(
        true,
        "cond-b",
        bodyHandleMap,
        bodyEdgesBySource
      );
      expect(bTargets).toEqual(["cond-c"]);

      const cTargets = resolveBodyConditionTargets(
        true,
        "cond-c",
        bodyHandleMap,
        bodyEdgesBySource
      );
      expect(cTargets).toEqual(["final-action"]);
    });

    it("first condition false should stop entire chain", () => {
      const fullHandleMap = buildEdgesBySourceHandle(edges);
      const bodyHandleMap = filterHandleMapToBody(fullHandleMap, bodyNodeIds);
      const bodyEdgesBySource = buildBodyEdgesBySource(edges);

      const targets = resolveBodyConditionTargets(
        false,
        "cond-a",
        bodyHandleMap,
        bodyEdgesBySource
      );
      expect(targets).toEqual([]);
    });

    it("middle condition false should stop chain at that point", () => {
      const fullHandleMap = buildEdgesBySourceHandle(edges);
      const bodyHandleMap = filterHandleMapToBody(fullHandleMap, bodyNodeIds);
      const bodyEdgesBySource = buildBodyEdgesBySource(edges);

      const aTargets = resolveBodyConditionTargets(
        true,
        "cond-a",
        bodyHandleMap,
        bodyEdgesBySource
      );
      expect(aTargets).toEqual(["cond-b"]);

      const bTargets = resolveBodyConditionTargets(
        false,
        "cond-b",
        bodyHandleMap,
        bodyEdgesBySource
      );
      expect(bTargets).toEqual([]);
    });

    it("last condition false should not reach final-action", () => {
      const fullHandleMap = buildEdgesBySourceHandle(edges);
      const bodyHandleMap = filterHandleMapToBody(fullHandleMap, bodyNodeIds);
      const bodyEdgesBySource = buildBodyEdgesBySource(edges);

      const aTargets = resolveBodyConditionTargets(
        true,
        "cond-a",
        bodyHandleMap,
        bodyEdgesBySource
      );
      expect(aTargets).toEqual(["cond-b"]);

      const bTargets = resolveBodyConditionTargets(
        true,
        "cond-b",
        bodyHandleMap,
        bodyEdgesBySource
      );
      expect(bTargets).toEqual(["cond-c"]);

      const cTargets = resolveBodyConditionTargets(
        false,
        "cond-c",
        bodyHandleMap,
        bodyEdgesBySource
      );
      expect(cTargets).toEqual([]);
    });
  });

  describe("condition with multiple targets on true, none on false", () => {
    const edges: EdgeLike[] = [
      createEdge("cond-fan", "action-1", "true"),
      createEdge("cond-fan", "action-2", "true"),
      createEdge("cond-fan", "action-3", "true"),
    ];
    const bodyNodeIds = ["cond-fan", "action-1", "action-2", "action-3"];

    it("true should fan out to all targets", () => {
      const fullHandleMap = buildEdgesBySourceHandle(edges);
      const bodyHandleMap = filterHandleMapToBody(fullHandleMap, bodyNodeIds);
      const bodyEdgesBySource = buildBodyEdgesBySource(edges);

      const targets = resolveBodyConditionTargets(
        true,
        "cond-fan",
        bodyHandleMap,
        bodyEdgesBySource
      );
      expect(targets).toEqual(["action-1", "action-2", "action-3"]);
    });

    it("false should not execute any of the fan-out targets", () => {
      const fullHandleMap = buildEdgesBySourceHandle(edges);
      const bodyHandleMap = filterHandleMapToBody(fullHandleMap, bodyNodeIds);
      const bodyEdgesBySource = buildBodyEdgesBySource(edges);

      const targets = resolveBodyConditionTargets(
        false,
        "cond-fan",
        bodyHandleMap,
        bodyEdgesBySource
      );
      expect(targets).toEqual([]);
    });
  });

  describe("parallel conditions in For Each body", () => {
    // action-read -> cond-a (true-only) + cond-b (true-only)
    const edges: EdgeLike[] = [
      createEdge("action-read", "cond-a", undefined),
      createEdge("action-read", "cond-b", undefined),
      createEdge("cond-a", "notify-a", "true"),
      createEdge("cond-b", "notify-b", "true"),
    ];
    const bodyNodeIds = [
      "action-read",
      "cond-a",
      "cond-b",
      "notify-a",
      "notify-b",
    ];

    it("cond-a=true, cond-b=false: only notify-a executes", () => {
      const fullHandleMap = buildEdgesBySourceHandle(edges);
      const bodyHandleMap = filterHandleMapToBody(fullHandleMap, bodyNodeIds);
      const bodyEdgesBySource = buildBodyEdgesBySource(edges);

      const aTargets = resolveBodyConditionTargets(
        true,
        "cond-a",
        bodyHandleMap,
        bodyEdgesBySource
      );
      expect(aTargets).toEqual(["notify-a"]);

      const bTargets = resolveBodyConditionTargets(
        false,
        "cond-b",
        bodyHandleMap,
        bodyEdgesBySource
      );
      expect(bTargets).toEqual([]);
    });

    it("cond-a=false, cond-b=true: only notify-b executes", () => {
      const fullHandleMap = buildEdgesBySourceHandle(edges);
      const bodyHandleMap = filterHandleMapToBody(fullHandleMap, bodyNodeIds);
      const bodyEdgesBySource = buildBodyEdgesBySource(edges);

      const aTargets = resolveBodyConditionTargets(
        false,
        "cond-a",
        bodyHandleMap,
        bodyEdgesBySource
      );
      expect(aTargets).toEqual([]);

      const bTargets = resolveBodyConditionTargets(
        true,
        "cond-b",
        bodyHandleMap,
        bodyEdgesBySource
      );
      expect(bTargets).toEqual(["notify-b"]);
    });

    it("both false: nothing executes downstream", () => {
      const fullHandleMap = buildEdgesBySourceHandle(edges);
      const bodyHandleMap = filterHandleMapToBody(fullHandleMap, bodyNodeIds);
      const bodyEdgesBySource = buildBodyEdgesBySource(edges);

      const aTargets = resolveBodyConditionTargets(
        false,
        "cond-a",
        bodyHandleMap,
        bodyEdgesBySource
      );
      const bTargets = resolveBodyConditionTargets(
        false,
        "cond-b",
        bodyHandleMap,
        bodyEdgesBySource
      );

      expect(aTargets).toEqual([]);
      expect(bTargets).toEqual([]);
    });

    it("both true: both notify nodes execute", () => {
      const fullHandleMap = buildEdgesBySourceHandle(edges);
      const bodyHandleMap = filterHandleMapToBody(fullHandleMap, bodyNodeIds);
      const bodyEdgesBySource = buildBodyEdgesBySource(edges);

      const aTargets = resolveBodyConditionTargets(
        true,
        "cond-a",
        bodyHandleMap,
        bodyEdgesBySource
      );
      const bTargets = resolveBodyConditionTargets(
        true,
        "cond-b",
        bodyHandleMap,
        bodyEdgesBySource
      );

      expect(aTargets).toEqual(["notify-a"]);
      expect(bTargets).toEqual(["notify-b"]);
    });
  });

  describe("condition with BigInt web3 values in For Each context", () => {
    it("should correctly evaluate false when loop item has 0 tokens vs large hat balance", () => {
      const outputs = {
        f48AH_PyqHFNYeob6NhcC: {
          label: "Amount of tockens locked in the spell",
          data: { amt: "0" },
        },
        F_b1_FDBQeghz8bCkFjn8: {
          label: "Get amount of SKY token on the current hat",
          data: { amt: "6577716159627818993901156981" },
        },
      };

      const { result } = evaluateConditionExpression(
        "{{@f48AH_PyqHFNYeob6NhcC:Amount of tockens locked in the spell.amt}} > {{@F_b1_FDBQeghz8bCkFjn8:Get amount of SKY token on the current hat.amt}}",
        outputs
      );
      expect(result).toBe(false);

      const edges: EdgeLike[] = [
        createEdge("compare-tokens", "already-cast", "true"),
      ];
      const bodyNodeIds = ["compare-tokens", "already-cast"];
      const fullHandleMap = buildEdgesBySourceHandle(edges);
      const bodyHandleMap = filterHandleMapToBody(fullHandleMap, bodyNodeIds);
      const bodyEdgesBySource = buildBodyEdgesBySource(edges);

      const targets = resolveBodyConditionTargets(
        result,
        "compare-tokens",
        bodyHandleMap,
        bodyEdgesBySource
      );
      expect(targets).toEqual([]);
    });

    it("should correctly evaluate true when loop item has more tokens than hat", () => {
      const outputs = {
        f48AH_PyqHFNYeob6NhcC: {
          label: "Amount of tockens locked in the spell",
          data: { amt: "9999999999999999999999999999" },
        },
        F_b1_FDBQeghz8bCkFjn8: {
          label: "Get amount of SKY token on the current hat",
          data: { amt: "6577716159627818993901156981" },
        },
      };

      const { result } = evaluateConditionExpression(
        "{{@f48AH_PyqHFNYeob6NhcC:Amount of tockens locked in the spell.amt}} > {{@F_b1_FDBQeghz8bCkFjn8:Get amount of SKY token on the current hat.amt}}",
        outputs
      );
      expect(result).toBe(true);

      const edges: EdgeLike[] = [
        createEdge("compare-tokens", "already-cast", "true"),
      ];
      const bodyNodeIds = ["compare-tokens", "already-cast"];
      const fullHandleMap = buildEdgesBySourceHandle(edges);
      const bodyHandleMap = filterHandleMapToBody(fullHandleMap, bodyNodeIds);
      const bodyEdgesBySource = buildBodyEdgesBySource(edges);

      const targets = resolveBodyConditionTargets(
        result,
        "compare-tokens",
        bodyHandleMap,
        bodyEdgesBySource
      );
      expect(targets).toEqual(["already-cast"]);
    });
  });

  describe("legacy body edges (no sourceHandle)", () => {
    it("should use bodyEdgesBySource when no handle map entry exists", () => {
      const edges: EdgeLike[] = [
        createEdge("cond-legacy", "next-action", undefined),
      ];
      const bodyNodeIds = ["cond-legacy", "next-action"];
      const fullHandleMap = buildEdgesBySourceHandle(edges);
      const bodyHandleMap = filterHandleMapToBody(fullHandleMap, bodyNodeIds);
      const bodyEdgesBySource = buildBodyEdgesBySource(edges);

      // No handle map entry, so legacy fallback applies
      expect(bodyHandleMap.has("cond-legacy")).toBe(false);

      const trueTargets = resolveBodyConditionTargets(
        true,
        "cond-legacy",
        bodyHandleMap,
        bodyEdgesBySource
      );
      expect(trueTargets).toEqual(["next-action"]);

      const falseTargets = resolveBodyConditionTargets(
        false,
        "cond-legacy",
        bodyHandleMap,
        bodyEdgesBySource
      );
      expect(falseTargets).toEqual([]);
    });
  });

  describe("complex body: condition -> fan-out -> nested condition", () => {
    //   cond-gate (true-only) -> action-1
    //                         -> action-2
    //                         -> cond-nested (true/false)
    //                              true  -> notify-ok
    //                              false -> notify-fail
    const edges: EdgeLike[] = [
      createEdge("cond-gate", "action-1", "true"),
      createEdge("cond-gate", "action-2", "true"),
      createEdge("cond-gate", "cond-nested", "true"),
      createEdge("cond-nested", "notify-ok", "true"),
      createEdge("cond-nested", "notify-fail", "false"),
    ];
    const bodyNodeIds = [
      "cond-gate",
      "action-1",
      "action-2",
      "cond-nested",
      "notify-ok",
      "notify-fail",
    ];

    it("gate=false should block everything downstream", () => {
      const fullHandleMap = buildEdgesBySourceHandle(edges);
      const bodyHandleMap = filterHandleMapToBody(fullHandleMap, bodyNodeIds);
      const bodyEdgesBySource = buildBodyEdgesBySource(edges);

      const targets = resolveBodyConditionTargets(
        false,
        "cond-gate",
        bodyHandleMap,
        bodyEdgesBySource
      );
      expect(targets).toEqual([]);
    });

    it("gate=true should fan out, nested=true routes to notify-ok", () => {
      const fullHandleMap = buildEdgesBySourceHandle(edges);
      const bodyHandleMap = filterHandleMapToBody(fullHandleMap, bodyNodeIds);
      const bodyEdgesBySource = buildBodyEdgesBySource(edges);

      const gateTargets = resolveBodyConditionTargets(
        true,
        "cond-gate",
        bodyHandleMap,
        bodyEdgesBySource
      );
      expect(gateTargets).toEqual(["action-1", "action-2", "cond-nested"]);

      const nestedTargets = resolveBodyConditionTargets(
        true,
        "cond-nested",
        bodyHandleMap,
        bodyEdgesBySource
      );
      expect(nestedTargets).toEqual(["notify-ok"]);
    });

    it("gate=true, nested=false routes to notify-fail", () => {
      const fullHandleMap = buildEdgesBySourceHandle(edges);
      const bodyHandleMap = filterHandleMapToBody(fullHandleMap, bodyNodeIds);
      const bodyEdgesBySource = buildBodyEdgesBySource(edges);

      const gateTargets = resolveBodyConditionTargets(
        true,
        "cond-gate",
        bodyHandleMap,
        bodyEdgesBySource
      );
      expect(gateTargets).toEqual(["action-1", "action-2", "cond-nested"]);

      const nestedTargets = resolveBodyConditionTargets(
        false,
        "cond-nested",
        bodyHandleMap,
        bodyEdgesBySource
      );
      expect(nestedTargets).toEqual(["notify-fail"]);
    });
  });

  describe("mixed: one-sided condition followed by two-sided condition", () => {
    // cond-filter (true-only) -> cond-route (true + false)
    //                              true  -> path-a, path-b
    //                              false -> path-c
    const edges: EdgeLike[] = [
      createEdge("cond-filter", "cond-route", "true"),
      createEdge("cond-route", "path-a", "true"),
      createEdge("cond-route", "path-b", "true"),
      createEdge("cond-route", "path-c", "false"),
    ];
    const bodyNodeIds = [
      "cond-filter",
      "cond-route",
      "path-a",
      "path-b",
      "path-c",
    ];

    it("filter=false blocks everything", () => {
      const fullHandleMap = buildEdgesBySourceHandle(edges);
      const bodyHandleMap = filterHandleMapToBody(fullHandleMap, bodyNodeIds);
      const bodyEdgesBySource = buildBodyEdgesBySource(edges);

      const targets = resolveBodyConditionTargets(
        false,
        "cond-filter",
        bodyHandleMap,
        bodyEdgesBySource
      );
      expect(targets).toEqual([]);
    });

    it("filter=true, route=true reaches path-a and path-b", () => {
      const fullHandleMap = buildEdgesBySourceHandle(edges);
      const bodyHandleMap = filterHandleMapToBody(fullHandleMap, bodyNodeIds);
      const bodyEdgesBySource = buildBodyEdgesBySource(edges);

      const filterTargets = resolveBodyConditionTargets(
        true,
        "cond-filter",
        bodyHandleMap,
        bodyEdgesBySource
      );
      expect(filterTargets).toEqual(["cond-route"]);

      const routeTargets = resolveBodyConditionTargets(
        true,
        "cond-route",
        bodyHandleMap,
        bodyEdgesBySource
      );
      expect(routeTargets).toEqual(["path-a", "path-b"]);
    });

    it("filter=true, route=false reaches path-c", () => {
      const fullHandleMap = buildEdgesBySourceHandle(edges);
      const bodyHandleMap = filterHandleMapToBody(fullHandleMap, bodyNodeIds);
      const bodyEdgesBySource = buildBodyEdgesBySource(edges);

      const filterTargets = resolveBodyConditionTargets(
        true,
        "cond-filter",
        bodyHandleMap,
        bodyEdgesBySource
      );
      expect(filterTargets).toEqual(["cond-route"]);

      const routeTargets = resolveBodyConditionTargets(
        false,
        "cond-route",
        bodyHandleMap,
        bodyEdgesBySource
      );
      expect(routeTargets).toEqual(["path-c"]);
    });
  });
});
