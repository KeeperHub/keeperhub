import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildEdgesBySourceHandle } from "@/lib/workflow/editor/edge-handle-utils";
import {
  buildEdgesBySource,
  buildEdgesByTarget,
  getReadyDownstreamIds,
  propagateConvergenceSkips,
  signalConvergenceArrival,
} from "@/lib/workflow/executor/convergence-barrier";
import { computeFinalSuccess } from "@/lib/workflow/executor/final-success";

describe("convergence barrier", () => {
  describe("basic convergence: A -> [B, C, D] -> E", () => {
    const edges = [
      { source: "A", target: "B" },
      { source: "A", target: "C" },
      { source: "A", target: "D" },
      { source: "B", target: "E" },
      { source: "C", target: "E" },
      { source: "D", target: "E" },
    ];

    it("should detect E as a convergence node with 3 incoming edges", () => {
      const targetMap = buildEdgesByTarget(edges);
      const sources = targetMap.get("E");
      expect(sources).toEqual(["B", "C", "D"]);
      expect(sources?.length).toBe(3);
    });

    it("should block E when only first branch arrives", () => {
      const targetMap = buildEdgesByTarget(edges);
      const arrivals = new Map<string, Set<string>>();
      const visited = new Set<string>();

      const ready = getReadyDownstreamIds(
        "B",
        ["E"],
        targetMap,
        arrivals,
        visited
      );
      expect(ready).toEqual([]);
      expect(arrivals.get("E")?.size).toBe(1);
    });

    it("should block E when two branches have arrived", () => {
      const targetMap = buildEdgesByTarget(edges);
      const arrivals = new Map<string, Set<string>>();
      const visited = new Set<string>();

      getReadyDownstreamIds("B", ["E"], targetMap, arrivals, visited);
      const ready = getReadyDownstreamIds(
        "C",
        ["E"],
        targetMap,
        arrivals,
        visited
      );
      expect(ready).toEqual([]);
      expect(arrivals.get("E")?.size).toBe(2);
    });

    it("should release E when all three branches have arrived", () => {
      const targetMap = buildEdgesByTarget(edges);
      const arrivals = new Map<string, Set<string>>();
      const visited = new Set<string>();

      getReadyDownstreamIds("B", ["E"], targetMap, arrivals, visited);
      getReadyDownstreamIds("C", ["E"], targetMap, arrivals, visited);
      const ready = getReadyDownstreamIds(
        "D",
        ["E"],
        targetMap,
        arrivals,
        visited
      );
      expect(ready).toEqual(["E"]);
      expect(arrivals.get("E")?.size).toBe(3);
    });

    it("should not block non-convergence nodes", () => {
      const targetMap = buildEdgesByTarget(edges);
      const arrivals = new Map<string, Set<string>>();
      const visited = new Set<string>();

      const ready = getReadyDownstreamIds(
        "A",
        ["B", "C", "D"],
        targetMap,
        arrivals,
        visited
      );
      expect(ready).toEqual(["B", "C", "D"]);
    });
  });

  describe("mixed topology: A -> [B, C] -> E, A -> D -> F", () => {
    const edges = [
      { source: "A", target: "B" },
      { source: "A", target: "C" },
      { source: "A", target: "D" },
      { source: "B", target: "E" },
      { source: "C", target: "E" },
      { source: "D", target: "F" },
    ];

    it("should detect E as convergence (2 incoming) but not F (1 incoming)", () => {
      const targetMap = buildEdgesByTarget(edges);
      expect(targetMap.get("E")?.length).toBe(2);
      expect(targetMap.get("F")?.length).toBe(1);
    });

    it("should block E until both B and C arrive", () => {
      const targetMap = buildEdgesByTarget(edges);
      const arrivals = new Map<string, Set<string>>();
      const visited = new Set<string>();

      const first = getReadyDownstreamIds(
        "B",
        ["E"],
        targetMap,
        arrivals,
        visited
      );
      expect(first).toEqual([]);

      const second = getReadyDownstreamIds(
        "C",
        ["E"],
        targetMap,
        arrivals,
        visited
      );
      expect(second).toEqual(["E"]);
    });

    it("should not block F (single incoming edge from D)", () => {
      const targetMap = buildEdgesByTarget(edges);
      const arrivals = new Map<string, Set<string>>();
      const visited = new Set<string>();

      const ready = getReadyDownstreamIds(
        "D",
        ["F"],
        targetMap,
        arrivals,
        visited
      );
      expect(ready).toEqual(["F"]);
    });
  });

  describe("duplicate arrival from same source is idempotent", () => {
    const edges = [
      { source: "B", target: "E" },
      { source: "C", target: "E" },
    ];

    it("should not count duplicate arrivals from the same source", () => {
      const targetMap = buildEdgesByTarget(edges);
      const arrivals = new Map<string, Set<string>>();
      const visited = new Set<string>();

      getReadyDownstreamIds("B", ["E"], targetMap, arrivals, visited);
      getReadyDownstreamIds("B", ["E"], targetMap, arrivals, visited);
      const ready = getReadyDownstreamIds(
        "B",
        ["E"],
        targetMap,
        arrivals,
        visited
      );

      expect(ready).toEqual([]);
      expect(arrivals.get("E")?.size).toBe(1);
    });
  });

  describe("condition skip propagation", () => {
    it("should signal arrival at convergence node from skipped branch", () => {
      // Condition -> [true: B, false: C] -> E
      const edges = [
        { source: "Cond", target: "B" },
        { source: "Cond", target: "C" },
        { source: "B", target: "E" },
        { source: "C", target: "E" },
      ];
      const sourceMap = buildEdgesBySource(edges);
      const targetMap = buildEdgesByTarget(edges);
      const arrivals = new Map<string, Set<string>>();
      const visited = new Set<string>();

      const skipArrivals = new Map<string, Set<string>>();
      const skippedNodes = new Set<string>();

      // Condition takes true branch (B), skips false branch (C)
      const unblocked = propagateConvergenceSkips(
        "Cond",
        ["C"],
        sourceMap,
        targetMap,
        arrivals,
        skipArrivals,
        skippedNodes,
        visited
      );

      // C's arrival at E was signaled, but E still needs B's arrival
      expect(unblocked).toEqual([]);
      expect(arrivals.get("E")?.has("C")).toBe(true);
      expect(arrivals.get("E")?.size).toBe(1);
      expect(skippedNodes.has("C")).toBe(true);

      // Now B arrives at E
      const ready = getReadyDownstreamIds(
        "B",
        ["E"],
        targetMap,
        arrivals,
        visited
      );
      expect(ready).toEqual(["E"]);
    });

    it("should unblock convergence when skip is the last arrival", () => {
      // B already arrived, then C gets skipped
      const edges = [
        { source: "B", target: "E" },
        { source: "C", target: "E" },
      ];
      const sourceMap = buildEdgesBySource(edges);
      const targetMap = buildEdgesByTarget(edges);
      const arrivals = new Map<string, Set<string>>();
      const visited = new Set<string>();

      // B arrives first
      signalConvergenceArrival("B", ["E"], targetMap, arrivals, visited);
      expect(arrivals.get("E")?.size).toBe(1);

      // C gets skipped and propagation signals its arrival
      const skipArrivals = new Map<string, Set<string>>();
      const skippedNodes = new Set<string>();
      const unblocked = propagateConvergenceSkips(
        "Cond",
        ["C"],
        sourceMap,
        targetMap,
        arrivals,
        skipArrivals,
        skippedNodes,
        visited
      );
      expect(unblocked).toEqual(["E"]);
    });

    it("should propagate through chain of non-convergence nodes to reach convergence", () => {
      // Cond -> [true: B, false: C -> D] -> E
      // C is skipped, D is downstream of C and leads to E
      const edges = [
        { source: "Cond", target: "B" },
        { source: "Cond", target: "C" },
        { source: "C", target: "D" },
        { source: "B", target: "E" },
        { source: "D", target: "E" },
      ];
      const sourceMap = buildEdgesBySource(edges);
      const targetMap = buildEdgesByTarget(edges);
      const arrivals = new Map<string, Set<string>>();
      const visited = new Set<string>();

      // Skip C, which chains through D to E
      const skipArrivals = new Map<string, Set<string>>();
      const skippedNodes = new Set<string>();
      const unblocked = propagateConvergenceSkips(
        "Cond",
        ["C"],
        sourceMap,
        targetMap,
        arrivals,
        skipArrivals,
        skippedNodes,
        visited
      );

      // D is not a convergence node so skip propagates through it
      // E gets arrival from D (via skip chain)
      expect(arrivals.get("E")?.has("D")).toBe(true);
      expect(unblocked).toEqual([]);
      expect(skippedNodes.has("C")).toBe(true);
      expect(skippedNodes.has("D")).toBe(true);

      // B arrives at E, completing the barrier
      const ready = getReadyDownstreamIds(
        "B",
        ["E"],
        targetMap,
        arrivals,
        visited
      );
      expect(ready).toEqual(["E"]);
    });
  });

  describe("direct-skip edge into convergence node", () => {
    // Models the prod stall pattern:
    //   Cond -> true  -> X -> nodeB
    //   Cond -> false ------> nodeB   (direct skipped edge into convergence)
    // The direct not-taken edge from the condition must register a skip-arrival
    // at nodeB, otherwise nodeB stalls at 1/2 arrivals once X completes.
    const edges = [
      { source: "Cond", target: "X" },
      { source: "Cond", target: "nodeB" },
      { source: "X", target: "nodeB" },
    ];

    it("signals skip-arrival when condition's not-taken edge targets convergence directly", () => {
      const sourceMap = buildEdgesBySource(edges);
      const targetMap = buildEdgesByTarget(edges);
      const arrivals = new Map<string, Set<string>>();
      const visited = new Set<string>();

      // Condition=true: X is taken (runs), nodeB is the direct skipped target.
      // propagateConvergenceSkips self-seeds the condition's skip-arrival.
      const skipArrivals = new Map<string, Set<string>>();
      const skippedNodes = new Set<string>();
      const unblocked = propagateConvergenceSkips(
        "Cond",
        ["nodeB"],
        sourceMap,
        targetMap,
        arrivals,
        skipArrivals,
        skippedNodes,
        visited
      );

      expect(unblocked).toEqual([]);
      expect(arrivals.get("nodeB")?.has("Cond")).toBe(true);
      expect(arrivals.get("nodeB")?.size).toBe(1);

      // X completes and arrives at nodeB -- barrier should now release.
      const ready = getReadyDownstreamIds(
        "X",
        ["nodeB"],
        targetMap,
        arrivals,
        visited
      );
      expect(ready).toEqual(["nodeB"]);
    });

    it("releases convergence when condition=false takes direct edge and intermediate arrives via skip", () => {
      // Mirror case:
      //   Cond -> true  ------> nodeB   (direct taken edge into convergence)
      //   Cond -> false -> X -> nodeB
      const mirrorEdges = [
        { source: "Cond", target: "nodeB" },
        { source: "Cond", target: "X" },
        { source: "X", target: "nodeB" },
      ];
      const sourceMap = buildEdgesBySource(mirrorEdges);
      const targetMap = buildEdgesByTarget(mirrorEdges);
      const arrivals = new Map<string, Set<string>>();
      const visited = new Set<string>();

      // Cond takes direct edge to nodeB -- signalConvergenceArrival seeds
      // arrivals[nodeB] = {Cond}; nodeB not yet unblocked (1/2).
      const readyFromTake = getReadyDownstreamIds(
        "Cond",
        ["nodeB"],
        targetMap,
        arrivals,
        visited
      );
      expect(readyFromTake).toEqual([]);
      expect(arrivals.get("nodeB")?.size).toBe(1);

      // X is skipped; propagation walks X -> nodeB, adds X to arrivals.
      const skipArrivals = new Map<string, Set<string>>();
      const skippedNodes = new Set<string>();
      const unblocked = propagateConvergenceSkips(
        "Cond",
        ["X"],
        sourceMap,
        targetMap,
        arrivals,
        skipArrivals,
        skippedNodes,
        visited
      );
      expect(unblocked).toEqual(["nodeB"]);
      expect(skippedNodes.has("X")).toBe(true);
    });

    it("does not corrupt deeper convergence when direct-skip target is still pending", () => {
      // Cond -> true  -> X -> nodeB -> J -> K
      // Cond -> false ------> nodeB
      // Y -----------------------------> K
      // nodeB is waiting on X. BFS must not walk through nodeB and falsely
      // register J as an arrival at K, otherwise Y's real arrival would
      // unblock K prematurely (before J has actually run).
      const deeperEdges = [
        { source: "Cond", target: "X" },
        { source: "Cond", target: "nodeB" },
        { source: "X", target: "nodeB" },
        { source: "nodeB", target: "J" },
        { source: "J", target: "K" },
        { source: "Y", target: "K" },
      ];
      const sourceMap = buildEdgesBySource(deeperEdges);
      const targetMap = buildEdgesByTarget(deeperEdges);
      const arrivals = new Map<string, Set<string>>();
      const visited = new Set<string>();

      const skipArrivals = new Map<string, Set<string>>();
      const skippedNodes = new Set<string>();
      propagateConvergenceSkips(
        "Cond",
        ["nodeB"],
        sourceMap,
        targetMap,
        arrivals,
        skipArrivals,
        skippedNodes,
        visited
      );

      // BFS must stop at the not-fully-resolved nodeB; K's arrivals stay empty.
      expect(arrivals.get("K")).toBeUndefined();

      // Y arrives first -- K must remain blocked until J (after nodeB, X) runs.
      const readyFromY = getReadyDownstreamIds(
        "Y",
        ["K"],
        targetMap,
        arrivals,
        visited
      );
      expect(readyFromY).toEqual([]);
      expect(arrivals.get("K")?.size).toBe(1);
    });
  });

  describe("chained conditions, each with a 5-node post-convergence chain", () => {
    // Realistic workflow shape that mirrors the production stall and verifies
    // that a long post-convergence chain drains all the way to the next
    // condition (and eventually End):
    //
    //   Cond1 -> true  -> Allow1 -> M1 (conv) -> D1a -> D2a -> D3a -> D4a -> Cond2
    //   Cond1 -> false ------------> M1
    //   Cond2 -> true  -> Allow2 -> M2 (conv) -> D1b -> D2b -> D3b -> D4b -> Cond3
    //   Cond2 -> false ------------> M2
    //   Cond3 -> true  -> Allow3 -> M3 (conv) -> D1c -> D2c -> D3c -> D4c -> End
    //   Cond3 -> false ------------> M3
    //
    // Each Mi has exactly 2 incoming edges (the condition's false handle +
    // the Allow_i "taken" node). After each convergence there is a chain of
    // five nodes (Mi, D1, D2, D3, D4) before the next condition -- this is
    // the topology the user explicitly asked to verify.
    const edges = [
      { source: "Cond1", target: "Allow1" },
      { source: "Cond1", target: "M1" },
      { source: "Allow1", target: "M1" },
      { source: "M1", target: "D1a" },
      { source: "D1a", target: "D2a" },
      { source: "D2a", target: "D3a" },
      { source: "D3a", target: "D4a" },
      { source: "D4a", target: "Cond2" },

      { source: "Cond2", target: "Allow2" },
      { source: "Cond2", target: "M2" },
      { source: "Allow2", target: "M2" },
      { source: "M2", target: "D1b" },
      { source: "D1b", target: "D2b" },
      { source: "D2b", target: "D3b" },
      { source: "D3b", target: "D4b" },
      { source: "D4b", target: "Cond3" },

      { source: "Cond3", target: "Allow3" },
      { source: "Cond3", target: "M3" },
      { source: "Allow3", target: "M3" },
      { source: "M3", target: "D1c" },
      { source: "D1c", target: "D2c" },
      { source: "D2c", target: "D3c" },
      { source: "D3c", target: "D4c" },
      { source: "D4c", target: "End" },
    ];

    type ConditionSpec = {
      id: string;
      value: boolean;
      trueTargets: string[];
      falseTargets: string[];
    };

    // End-to-end simulator that mirrors the executor's control flow:
    //   - For condition nodes: signal taken arrival, then propagate skip through
    //     the not-taken subtree (which self-seeds skip arrivals at direct
    //     skipped convergence targets).
    //   - For non-condition nodes: getReadyDownstreamIds over downstream.
    // Returns the set of executed nodes in discovery order.
    function runSimulatedWorkflow(
      triggerReady: string[],
      conditions: Map<string, ConditionSpec>,
      edgesBySource: Map<string, string[]>,
      edgesByTarget: Map<string, string[]>
    ): { executed: string[]; visited: Set<string>; skippedNodes: Set<string> } {
      const arrivals = new Map<string, Set<string>>();
      const skipArrivals = new Map<string, Set<string>>();
      const skippedNodes = new Set<string>();
      const visited = new Set<string>();
      const executed: string[] = [];
      const queue: string[] = [...triggerReady];

      while (queue.length > 0) {
        const nodeId = queue.shift() as string;
        if (visited.has(nodeId)) {
          continue;
        }
        visited.add(nodeId);
        executed.push(nodeId);

        const condSpec = conditions.get(nodeId);
        if (condSpec !== undefined) {
          const taken = condSpec.value
            ? condSpec.trueTargets
            : condSpec.falseTargets;
          const skipped = condSpec.value
            ? condSpec.falseTargets
            : condSpec.trueTargets;
          const readyFromTaken = getReadyDownstreamIds(
            nodeId,
            taken,
            edgesByTarget,
            arrivals,
            visited
          );
          const unblockedFromSkip = propagateConvergenceSkips(
            nodeId,
            skipped,
            edgesBySource,
            edgesByTarget,
            arrivals,
            skipArrivals,
            skippedNodes,
            visited
          );
          for (const next of [...readyFromTaken, ...unblockedFromSkip]) {
            if (!visited.has(next)) {
              queue.push(next);
            }
          }
          continue;
        }

        const downstream = edgesBySource.get(nodeId) ?? [];
        const ready = getReadyDownstreamIds(
          nodeId,
          downstream,
          edgesByTarget,
          arrivals,
          visited
        );
        for (const next of ready) {
          if (!visited.has(next)) {
            queue.push(next);
          }
        }
      }

      return { executed, visited, skippedNodes };
    }

    type Scenario = {
      name: string;
      cond1: boolean;
      cond2: boolean;
      cond3: boolean;
    };

    const scenarios: Scenario[] = [
      { name: "TTT", cond1: true, cond2: true, cond3: true },
      { name: "TTF", cond1: true, cond2: true, cond3: false },
      { name: "TFT", cond1: true, cond2: false, cond3: true },
      { name: "TFF", cond1: true, cond2: false, cond3: false },
      { name: "FTT", cond1: false, cond2: true, cond3: true },
      { name: "FTF", cond1: false, cond2: true, cond3: false },
      { name: "FFT", cond1: false, cond2: false, cond3: true },
      { name: "FFF", cond1: false, cond2: false, cond3: false },
    ];

    for (const scenario of scenarios) {
      it(`reaches End for scenario ${scenario.name} (Cond1=${scenario.cond1}, Cond2=${scenario.cond2}, Cond3=${scenario.cond3})`, () => {
        const sourceMap = buildEdgesBySource(edges);
        const targetMap = buildEdgesByTarget(edges);
        const conditions = new Map<string, ConditionSpec>([
          [
            "Cond1",
            {
              id: "Cond1",
              value: scenario.cond1,
              trueTargets: ["Allow1"],
              falseTargets: ["M1"],
            },
          ],
          [
            "Cond2",
            {
              id: "Cond2",
              value: scenario.cond2,
              trueTargets: ["Allow2"],
              falseTargets: ["M2"],
            },
          ],
          [
            "Cond3",
            {
              id: "Cond3",
              value: scenario.cond3,
              trueTargets: ["Allow3"],
              falseTargets: ["M3"],
            },
          ],
        ]);

        const { executed, visited } = runSimulatedWorkflow(
          ["Cond1"],
          conditions,
          sourceMap,
          targetMap
        );

        // End must be reached in every scenario -- this is the core correctness
        // claim: the stall bug is fixed and the graph drains to its sink.
        expect(visited.has("End")).toBe(true);
        expect(visited.has("M1")).toBe(true);
        expect(visited.has("M2")).toBe(true);
        expect(visited.has("M3")).toBe(true);

        // Each condition ran exactly once.
        expect(executed.filter((id) => id === "Cond1")).toHaveLength(1);
        expect(executed.filter((id) => id === "Cond2")).toHaveLength(1);
        expect(executed.filter((id) => id === "Cond3")).toHaveLength(1);

        // The 4-node post-convergence chain after each Mi must drain fully
        // in every scenario -- this is the core thing the user asked to
        // verify: the workflow keeps running all the way to the next
        // condition (and ultimately End) regardless of which branch each
        // condition took.
        for (const id of [
          "D1a",
          "D2a",
          "D3a",
          "D4a",
          "D1b",
          "D2b",
          "D3b",
          "D4b",
          "D1c",
          "D2c",
          "D3c",
          "D4c",
        ]) {
          expect(visited.has(id)).toBe(true);
        }

        // Allowance nodes (taken chain) run iff their condition was true.
        expect(visited.has("Allow1")).toBe(scenario.cond1);
        expect(visited.has("Allow2")).toBe(scenario.cond2);
        expect(visited.has("Allow3")).toBe(scenario.cond3);
      });
    }
  });

  describe("all-skip convergence should not execute", () => {
    it("should not unblock convergence node when all inputs are from skipped subtree", () => {
      // Cond -> [false: A -> B, false: A -> C] -> D (convergence)
      // Both B and C feed into D, all in the skipped subtree
      const edges = [
        { source: "Cond", target: "A" },
        { source: "A", target: "B" },
        { source: "A", target: "C" },
        { source: "B", target: "D" },
        { source: "C", target: "D" },
      ];
      const sourceMap = buildEdgesBySource(edges);
      const targetMap = buildEdgesByTarget(edges);
      const arrivals = new Map<string, Set<string>>();
      const visited = new Set<string>();

      // Skip A (the false branch root)
      const skipArrivals = new Map<string, Set<string>>();
      const skippedNodes = new Set<string>();
      const unblocked = propagateConvergenceSkips(
        "Cond",
        ["A"],
        sourceMap,
        targetMap,
        arrivals,
        skipArrivals,
        skippedNodes,
        visited
      );

      // D should NOT be unblocked -- all its inputs are from skipped nodes
      expect(unblocked).toEqual([]);
      // and D is recorded as genuinely skipped.
      expect(skippedNodes.has("D")).toBe(true);
    });

    it("should unblock convergence node when at least one input is from real execution", () => {
      // Real: X executes and arrives at D
      // Skip: B is skipped and propagates to D
      const edges = [
        { source: "B", target: "D" },
        { source: "X", target: "D" },
      ];
      const sourceMap = buildEdgesBySource(edges);
      const targetMap = buildEdgesByTarget(edges);
      const arrivals = new Map<string, Set<string>>();
      const visited = new Set<string>();

      // X arrives at D via real execution
      signalConvergenceArrival("X", ["D"], targetMap, arrivals, visited);

      // B gets skipped
      const skipArrivals = new Map<string, Set<string>>();
      const skippedNodes = new Set<string>();
      const unblocked = propagateConvergenceSkips(
        "Cond",
        ["B"],
        sourceMap,
        targetMap,
        arrivals,
        skipArrivals,
        skippedNodes,
        visited
      );

      // D should be unblocked -- X was a real arrival
      expect(unblocked).toEqual(["D"]);
      expect(skippedNodes.has("D")).toBe(false);
    });

    it("should propagate skip through fully-skipped convergence nodes to downstream", () => {
      // Cond -> [false: A -> B] and [false: A -> C] -> D (convergence) -> E
      // D is all-skip, so skip should continue to E
      const edges = [
        { source: "Cond", target: "A" },
        { source: "A", target: "B" },
        { source: "A", target: "C" },
        { source: "B", target: "D" },
        { source: "C", target: "D" },
        { source: "D", target: "E" },
        { source: "X", target: "E" },
      ];
      const sourceMap = buildEdgesBySource(edges);
      const targetMap = buildEdgesByTarget(edges);
      const arrivals = new Map<string, Set<string>>();
      const visited = new Set<string>();

      // X arrives at E via real execution first
      signalConvergenceArrival("X", ["E"], targetMap, arrivals, visited);

      // Skip A -- should propagate through B, C, D (all-skip), then reach E
      const skipArrivals = new Map<string, Set<string>>();
      const skippedNodes = new Set<string>();
      const unblocked = propagateConvergenceSkips(
        "Cond",
        ["A"],
        sourceMap,
        targetMap,
        arrivals,
        skipArrivals,
        skippedNodes,
        visited
      );

      // E should be unblocked (X was real, D arrival was skip-propagated)
      expect(unblocked).toEqual(["E"]);
      // D is all-skip so it is recorded skipped; E executed (real X) so it is not.
      expect(skippedNodes.has("D")).toBe(true);
      expect(skippedNodes.has("E")).toBe(false);
    });
  });

  describe("failure signaling at convergence nodes", () => {
    it("should allow signaling arrival for failed nodes", () => {
      // A -> [B, C] -> E where B fails
      const edges = [
        { source: "B", target: "E" },
        { source: "C", target: "E" },
      ];
      const targetMap = buildEdgesByTarget(edges);
      const arrivals = new Map<string, Set<string>>();
      const visited = new Set<string>();

      // B fails: signal arrival at E (same call the catch block makes)
      signalConvergenceArrival("B", ["E"], targetMap, arrivals, visited);

      // C completes and triggers barrier check
      const ready = getReadyDownstreamIds(
        "C",
        ["E"],
        targetMap,
        arrivals,
        visited
      );
      expect(ready).toEqual(["E"]);
    });
  });

  describe("duplicate edge deduplication", () => {
    it("should not inflate convergence threshold from duplicate edges", () => {
      const edges = [
        { source: "A", target: "B" },
        { source: "A", target: "B" },
        { source: "A", target: "B" },
        { source: "A", target: "B" },
        { source: "A", target: "B" },
        { source: "C", target: "B" },
      ];
      const targetMap = buildEdgesByTarget(edges);
      const arrivals = new Map<string, Set<string>>();
      const visited = new Set<string>();

      // B has 2 unique sources (A, C), not 6
      expect(targetMap.get("B")).toEqual(["A", "C"]);

      // A arrives
      getReadyDownstreamIds("A", ["B"], targetMap, arrivals, visited);
      expect(arrivals.get("B")?.size).toBe(1);

      // C arrives -- barrier should unblock
      const ready = getReadyDownstreamIds(
        "C",
        ["B"],
        targetMap,
        arrivals,
        visited
      );
      expect(ready).toEqual(["B"]);
    });

    it("buildEdgesByTarget returns deduplicated source arrays", () => {
      const edges = [
        { source: "X", target: "Y" },
        { source: "X", target: "Y" },
        { source: "Z", target: "Y" },
      ];
      const targetMap = buildEdgesByTarget(edges);
      expect(targetMap.get("Y")).toEqual(["X", "Z"]);
    });

    it("buildEdgesBySource returns deduplicated target arrays", () => {
      const edges = [
        { source: "A", target: "B" },
        { source: "A", target: "B" },
        { source: "A", target: "C" },
      ];
      const sourceMap = buildEdgesBySource(edges);
      expect(sourceMap.get("A")).toEqual(["B", "C"]);
    });

    it("buildEdgesBySourceHandle deduplicates targets per handle", () => {
      const edges = [
        { source: "Cond", target: "B", sourceHandle: "true" },
        { source: "Cond", target: "B", sourceHandle: "true" },
        { source: "Cond", target: "C", sourceHandle: "false" },
        { source: "Cond", target: "C", sourceHandle: "false" },
        { source: "Cond", target: "C", sourceHandle: "false" },
      ];
      const handleMap = buildEdgesBySourceHandle(edges);
      const condHandles = handleMap.get("Cond");
      expect(condHandles?.get("true")).toEqual(["B"]);
      expect(condHandles?.get("false")).toEqual(["C"]);
    });
  });

  describe("alert OR-join wired to several conditions' false handles", () => {
    // Production shape: five health-check conditions each route their `false`
    // handle to a single alert step. The alert fires if ANY check fails; when
    // every check passes the alert must be skipped, and a workflow with no real
    // failure must report success.
    const condIds = ["c1", "c2", "c3", "c4", "c5"];
    const alert = "alert";
    const edges = condIds.map((id) => ({ source: id, target: alert }));

    // Drive every condition's not-taken (false) branch into the alert and
    // return the resulting execute-ready list plus the skipped-node set.
    function runAllConditions(realFromConditions: string[]): {
      executeReady: string[];
      skippedNodes: Set<string>;
      arrivals: Map<string, Set<string>>;
    } {
      const sourceMap = buildEdgesBySource(edges);
      const targetMap = buildEdgesByTarget(edges);
      const arrivals = new Map<string, Set<string>>();
      const skipArrivals = new Map<string, Set<string>>();
      const skippedNodes = new Set<string>();
      const visited = new Set<string>();
      const executeReady: string[] = [];

      for (const condId of condIds) {
        if (realFromConditions.includes(condId)) {
          // Condition went false: it TAKES the edge to the alert (real arrival).
          executeReady.push(
            ...getReadyDownstreamIds(
              condId,
              [alert],
              targetMap,
              arrivals,
              visited
            )
          );
        } else {
          // Condition went true: the alert is on its not-taken handle (skip).
          executeReady.push(
            ...propagateConvergenceSkips(
              condId,
              [alert],
              sourceMap,
              targetMap,
              arrivals,
              skipArrivals,
              skippedNodes,
              visited
            )
          );
        }
      }
      return { executeReady, skippedNodes, arrivals };
    }

    it("does not execute the alert when every condition passed (all-skip)", () => {
      const { executeReady, skippedNodes } = runAllConditions([]);
      expect(executeReady).toEqual([]);
      expect(skippedNodes.has(alert)).toBe(true);
    });

    it("reports success when the all-skip alert never ran (no masking needed)", () => {
      const { skippedNodes } = runAllConditions([]);
      // The alert never executed, so it is absent from results.
      const results = {
        c1: { success: true },
        c2: { success: true },
        c3: { success: true },
        c4: { success: true },
        c5: { success: true },
      };
      expect(computeFinalSuccess(results, skippedNodes)).toBe(true);
    });

    it("executes the alert once when a single condition failed", () => {
      const { executeReady, skippedNodes } = runAllConditions(["c3"]);
      expect(executeReady).toEqual([alert]);
      // The alert genuinely ran, so it must NOT be recorded as skipped.
      expect(skippedNodes.has(alert)).toBe(false);
    });

    it("counts an executed-and-failed alert against final success (no false success)", () => {
      const { executeReady, skippedNodes } = runAllConditions(["c3"]);
      expect(executeReady).toEqual([alert]);
      // The alert ran and failed (e.g. bad webhook payload).
      const results = {
        c1: { success: true },
        c2: { success: true },
        c3: { success: true },
        c4: { success: true },
        c5: { success: true },
        [alert]: { success: false, error: "HTTP 400: Invalid routing key" },
      };
      // Because the alert is not in skippedNodes, its failure is authoritative.
      expect(computeFinalSuccess(results, skippedNodes)).toBe(false);
    });

    it("executes the alert when at least one of several failures arrives", () => {
      const { executeReady, skippedNodes } = runAllConditions(["c1", "c4"]);
      // Real arrivals from c1 and c4 plus skips from c2/c3/c5 -> one execution.
      expect(executeReady).toEqual([alert]);
      expect(skippedNodes.has(alert)).toBe(false);
    });

    // KEEP-895: a condition that evaluates `true` must contribute a SKIP to the
    // OR-join even when it completes through the spurious-completion recovery
    // path (lost `step_completed` event under heavy fan-in -> re-fire ->
    // exceeded-max-retries -> recover). The bug was that the recovery path
    // continued downstream through the handle-agnostic `edgesBySource`, which
    // routes the not-taken `false` edge as a REAL arrival -- modeled here by
    // putting a passing condition into `realFromConditions`. That single
    // mis-routed arrival fires the alert even though every condition passed.
    it("a true condition routed via the skip primitive keeps the alert skipped", () => {
      // Post-fix: the recovery path routes a true condition exactly like the
      // normal path -- propagateConvergenceSkips -- so all five are skips.
      const { executeReady, skippedNodes } = runAllConditions([]);
      expect(executeReady).toEqual([]);
      expect(skippedNodes.has(alert)).toBe(true);
    });

    it("regression: routing one passing condition as a real arrival wrongly fires the alert", () => {
      // Pin the exact pre-fix failure mode: c3 passed (its output was
      // `condition: true`) but was mis-routed as a real arrival. The four
      // genuine skips plus that one bogus real arrival fire the alert.
      const { executeReady, skippedNodes } = runAllConditions(["c3"]);
      expect(executeReady).toEqual([alert]);
      expect(skippedNodes.has(alert)).toBe(false);
    });
  });

  describe("OR-join with a non-condition predecessor", () => {
    // J converges a condition's false branch and a plain (always-run) node.
    // The plain node's real arrival must release J even though the condition
    // skipped its edge -- a join is skipped only when EVERY input was skipped.
    const edges = [
      { source: "Cond", target: "J" },
      { source: "Plain", target: "J" },
    ];

    it("executes the join when the plain node arrives after the condition skip", () => {
      const sourceMap = buildEdgesBySource(edges);
      const targetMap = buildEdgesByTarget(edges);
      const arrivals = new Map<string, Set<string>>();
      const skipArrivals = new Map<string, Set<string>>();
      const skippedNodes = new Set<string>();
      const visited = new Set<string>();

      // Condition skips its edge to J first.
      const afterSkip = propagateConvergenceSkips(
        "Cond",
        ["J"],
        sourceMap,
        targetMap,
        arrivals,
        skipArrivals,
        skippedNodes,
        visited
      );
      expect(afterSkip).toEqual([]);
      expect(skippedNodes.has("J")).toBe(false);

      // Plain executes and arrives -> J releases.
      const afterReal = getReadyDownstreamIds(
        "Plain",
        ["J"],
        targetMap,
        arrivals,
        visited
      );
      expect(afterReal).toEqual(["J"]);
      expect(skippedNodes.has("J")).toBe(false);
    });

    it("executes the join when the plain node arrives before the condition skip", () => {
      const sourceMap = buildEdgesBySource(edges);
      const targetMap = buildEdgesByTarget(edges);
      const arrivals = new Map<string, Set<string>>();
      const skipArrivals = new Map<string, Set<string>>();
      const skippedNodes = new Set<string>();
      const visited = new Set<string>();

      const afterReal = getReadyDownstreamIds(
        "Plain",
        ["J"],
        targetMap,
        arrivals,
        visited
      );
      expect(afterReal).toEqual([]);

      const afterSkip = propagateConvergenceSkips(
        "Cond",
        ["J"],
        sourceMap,
        targetMap,
        arrivals,
        skipArrivals,
        skippedNodes,
        visited
      );
      expect(afterSkip).toEqual(["J"]);
      expect(skippedNodes.has("J")).toBe(false);
    });

    it("runs the join and its continuation when several conditions skip but a normal node arrives", () => {
      // c1, c2 both route their not-taken handle into Merge; Plain always runs
      // and also feeds Merge; Merge -> Next continues the workflow. Merge must
      // run on Plain's real arrival regardless of the two condition skips, and
      // Next (downstream of Merge) must then run too.
      const wf = [
        { source: "c1", target: "Merge" },
        { source: "c2", target: "Merge" },
        { source: "Plain", target: "Merge" },
        { source: "Merge", target: "Next" },
      ];
      const sourceMap = buildEdgesBySource(wf);
      const targetMap = buildEdgesByTarget(wf);
      const arrivals = new Map<string, Set<string>>();
      const skipArrivals = new Map<string, Set<string>>();
      const skippedNodes = new Set<string>();
      const visited = new Set<string>();

      // Both conditions pass: their edges into Merge are skipped (2/3 arrivals).
      for (const cond of ["c1", "c2"]) {
        expect(
          propagateConvergenceSkips(
            cond,
            ["Merge"],
            sourceMap,
            targetMap,
            arrivals,
            skipArrivals,
            skippedNodes,
            visited
          )
        ).toEqual([]);
      }
      expect(skippedNodes.has("Merge")).toBe(false);

      // Plain runs -> real arrival completes Merge (3/3) and releases it.
      const readyMerge = getReadyDownstreamIds(
        "Plain",
        ["Merge"],
        targetMap,
        arrivals,
        visited
      );
      expect(readyMerge).toEqual(["Merge"]);

      // Execute Merge and route downstream: Next (single-incoming) runs.
      visited.add("Merge");
      const readyNext = getReadyDownstreamIds(
        "Merge",
        ["Next"],
        targetMap,
        arrivals,
        visited
      );
      expect(readyNext).toEqual(["Next"]);
      expect(skippedNodes.has("Next")).toBe(false);
    });
  });

  describe("OR-join: a plain node parallel to all-false conditions whose taken branch is a dead end", () => {
    // Topology: each condition feeds the join J on its `true` handle; the
    // condition's `false` handle (the branch TAKEN when it evaluates false) has
    // no edge -- a dead end. A plain, always-run node also feeds J. So a
    // condition that goes false never reaches J through the dead-end handle; it
    // instead skips its not-taken `true` edge into J. J is an OR-join: it runs
    // once if any real arrival lands (the plain node, or a condition that went
    // true) and is skipped only when EVERY incoming edge was a skip.
    const condIds = ["c1", "c2", "c3"];
    const plain = "Plain";
    const join = "J";

    type Barrier = {
      arrivals: Map<string, Set<string>>;
      skipArrivals: Map<string, Set<string>>;
      skippedNodes: Set<string>;
      visited: Set<string>;
    };

    function freshBarrier(): Barrier {
      return {
        arrivals: new Map<string, Set<string>>(),
        skipArrivals: new Map<string, Set<string>>(),
        skippedNodes: new Set<string>(),
        visited: new Set<string>(),
      };
    }

    function withPlainEdges(): { source: string; target: string }[] {
      return [
        ...condIds.map((id) => ({ source: id, target: join })),
        { source: plain, target: join },
      ];
    }

    function condOnlyEdges(): { source: string; target: string }[] {
      return condIds.map((id) => ({ source: id, target: join }));
    }

    // A false condition takes its disconnected `false` handle (nothing happens
    // downstream) and skips its not-taken `true` edge into J. A true condition
    // takes the connected `true` edge -> real arrival.
    function driveCondition(
      condId: string,
      truthy: boolean,
      edges: { source: string; target: string }[],
      b: Barrier
    ): string[] {
      const sourceMap = buildEdgesBySource(edges);
      const targetMap = buildEdgesByTarget(edges);
      if (truthy) {
        return getReadyDownstreamIds(
          condId,
          [join],
          targetMap,
          b.arrivals,
          b.visited
        );
      }
      return propagateConvergenceSkips(
        condId,
        [join],
        sourceMap,
        targetMap,
        b.arrivals,
        b.skipArrivals,
        b.skippedNodes,
        b.visited
      );
    }

    function drivePlain(
      edges: { source: string; target: string }[],
      b: Barrier
    ): string[] {
      const targetMap = buildEdgesByTarget(edges);
      return getReadyDownstreamIds(
        plain,
        [join],
        targetMap,
        b.arrivals,
        b.visited
      );
    }

    it("fires the join once via the plain node when every condition went false", () => {
      const b = freshBarrier();
      const edges = withPlainEdges();
      const ready: string[] = [];
      for (const c of condIds) {
        ready.push(...driveCondition(c, false, edges, b));
      }
      // Three skips, no real arrival yet: J is neither released nor skipped
      // because the plain edge has not landed.
      expect(ready).toEqual([]);
      expect(b.skippedNodes.has(join)).toBe(false);

      // The plain node arrives -> real arrival completes the OR-join (4/4) and
      // runs it exactly once.
      expect(drivePlain(edges, b)).toEqual([join]);
      expect(b.skippedNodes.has(join)).toBe(false);
    });

    it("fires the join once when the plain node arrives before the false conditions", () => {
      const b = freshBarrier();
      const edges = withPlainEdges();
      // Plain lands first (1/4) -> not enough arrivals yet.
      expect(drivePlain(edges, b)).toEqual([]);

      const releases: string[] = [];
      for (const c of condIds) {
        releases.push(...driveCondition(c, false, edges, b));
      }
      // The last skip completes 4/4 with a real arrival already present, so the
      // join releases exactly once and is not marked skipped.
      expect(releases).toEqual([join]);
      expect(b.skippedNodes.has(join)).toBe(false);
    });

    it("skips the join when all-false conditions have a dead-end branch and there is no plain node", () => {
      const b = freshBarrier();
      const edges = condOnlyEdges();
      const ready: string[] = [];
      for (const c of condIds) {
        ready.push(...driveCondition(c, false, edges, b));
      }
      // Every incoming edge was a skip -> the join is skipped, never executed.
      expect(ready).toEqual([]);
      expect(b.skippedNodes.has(join)).toBe(true);
    });

    it("fires the join once when a condition goes true alongside the plain node", () => {
      const b = freshBarrier();
      const edges = withPlainEdges();
      const ready: string[] = [];
      ready.push(...driveCondition("c1", false, edges, b)); // skip 1/4
      ready.push(...driveCondition("c2", true, edges, b)); // real 2/4
      ready.push(...driveCondition("c3", false, edges, b)); // skip 3/4
      ready.push(...drivePlain(edges, b)); // real 4/4 -> release
      expect(ready).toEqual([join]);
      expect(b.skippedNodes.has(join)).toBe(false);
    });

    it("does not double-fire the join when both a true condition and the plain node real-arrive", () => {
      const b = freshBarrier();
      const edges = withPlainEdges();
      const ready: string[] = [];
      ready.push(...driveCondition("c1", false, edges, b)); // skip 1/4
      ready.push(...driveCondition("c2", false, edges, b)); // skip 2/4
      ready.push(...drivePlain(edges, b)); // real 3/4, still pending
      expect(ready).toEqual([]);
      ready.push(...driveCondition("c3", true, edges, b)); // real 4/4 -> release
      // The join appears exactly once in the ready list across all arrivals.
      expect(ready).toEqual([join]);
      expect(b.skippedNodes.has(join)).toBe(false);
    });
  });
});
