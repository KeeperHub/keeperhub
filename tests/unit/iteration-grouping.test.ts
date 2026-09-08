import { describe, expect, it } from "vitest";
import {
  buildChildLogsLookup,
  buildIterationGroups,
  groupLogsByIteration,
  type IterationLogFields,
} from "@/lib/workflow/nodes/for-each/iteration-grouping";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let logCounter = 0;

function makeLog(
  overrides: Partial<IterationLogFields> = {}
): IterationLogFields {
  logCounter += 1;
  return {
    nodeId: `node-${logCounter}`,
    nodeType: "action",
    startedAt: new Date("2025-01-01T00:00:00Z"),
    iterationIndex: null,
    forEachNodeId: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildIterationGroups
// ---------------------------------------------------------------------------

describe("buildIterationGroups", () => {
  it("returns an empty array for empty input", () => {
    const result = buildIterationGroups([]);
    expect(result).toEqual([]);
  });

  it("returns a single iteration with one log", () => {
    const log = makeLog({ iterationIndex: 0 });
    const result = buildIterationGroups([log]);

    expect(result).toHaveLength(1);
    expect(result[0].iterationIndex).toBe(0);
    expect(result[0].logs).toEqual([log]);
  });

  it("groups multiple logs into a single iteration sorted by startedAt", () => {
    const logA = makeLog({
      iterationIndex: 0,
      startedAt: new Date("2025-01-01T00:00:03Z"),
    });
    const logB = makeLog({
      iterationIndex: 0,
      startedAt: new Date("2025-01-01T00:00:01Z"),
    });
    const logC = makeLog({
      iterationIndex: 0,
      startedAt: new Date("2025-01-01T00:00:02Z"),
    });

    const result = buildIterationGroups([logA, logB, logC]);

    expect(result).toHaveLength(1);
    expect(result[0].iterationIndex).toBe(0);
    expect(result[0].logs).toEqual([logB, logC, logA]);
  });

  it("returns multiple iterations sorted by iterationIndex", () => {
    const log0 = makeLog({ iterationIndex: 0 });
    const log1 = makeLog({ iterationIndex: 1 });
    const log2 = makeLog({ iterationIndex: 2 });

    const result = buildIterationGroups([log0, log1, log2]);

    expect(result).toHaveLength(3);
    expect(result[0].iterationIndex).toBe(0);
    expect(result[1].iterationIndex).toBe(1);
    expect(result[2].iterationIndex).toBe(2);
  });

  it("defaults null iterationIndex to 0", () => {
    const logWithNull = makeLog({ iterationIndex: null });
    const logWithZero = makeLog({ iterationIndex: 0 });

    const result = buildIterationGroups([logWithNull, logWithZero]);

    expect(result).toHaveLength(1);
    expect(result[0].iterationIndex).toBe(0);
    expect(result[0].logs).toHaveLength(2);
    expect(result[0].logs).toContain(logWithNull);
    expect(result[0].logs).toContain(logWithZero);
  });

  it("sorts out-of-order iterations by iterationIndex", () => {
    const log2 = makeLog({ iterationIndex: 2 });
    const log0 = makeLog({ iterationIndex: 0 });
    const log5 = makeLog({ iterationIndex: 5 });
    const log1 = makeLog({ iterationIndex: 1 });

    const result = buildIterationGroups([log2, log0, log5, log1]);

    expect(result.map((g) => g.iterationIndex)).toEqual([0, 1, 2, 5]);
  });

  it("sorts out-of-order logs within the same iteration by startedAt", () => {
    const late = makeLog({
      iterationIndex: 1,
      startedAt: new Date("2025-01-01T00:05:00Z"),
    });
    const early = makeLog({
      iterationIndex: 1,
      startedAt: new Date("2025-01-01T00:01:00Z"),
    });
    const middle = makeLog({
      iterationIndex: 1,
      startedAt: new Date("2025-01-01T00:03:00Z"),
    });

    const result = buildIterationGroups([late, early, middle]);

    expect(result).toHaveLength(1);
    expect(result[0].logs[0]).toBe(early);
    expect(result[0].logs[1]).toBe(middle);
    expect(result[0].logs[2]).toBe(late);
  });

  it("handles multiple iterations each with multiple logs", () => {
    const iter0a = makeLog({
      iterationIndex: 0,
      startedAt: new Date("2025-01-01T00:00:02Z"),
    });
    const iter0b = makeLog({
      iterationIndex: 0,
      startedAt: new Date("2025-01-01T00:00:01Z"),
    });
    const iter1a = makeLog({
      iterationIndex: 1,
      startedAt: new Date("2025-01-01T00:00:04Z"),
    });
    const iter1b = makeLog({
      iterationIndex: 1,
      startedAt: new Date("2025-01-01T00:00:03Z"),
    });

    const result = buildIterationGroups([iter0a, iter1a, iter0b, iter1b]);

    expect(result).toHaveLength(2);
    expect(result[0].iterationIndex).toBe(0);
    expect(result[0].logs).toEqual([iter0b, iter0a]);
    expect(result[1].iterationIndex).toBe(1);
    expect(result[1].logs).toEqual([iter1b, iter1a]);
  });
});

// ---------------------------------------------------------------------------
// groupLogsByIteration
// ---------------------------------------------------------------------------

describe("groupLogsByIteration", () => {
  it("returns an empty array for empty input", () => {
    const result = groupLogsByIteration([]);
    expect(result).toEqual([]);
  });

  it("treats all logs as standalone when none are For Each related", () => {
    const logA = makeLog({ nodeType: "action" });
    const logB = makeLog({ nodeType: "action" });

    const result = groupLogsByIteration([logA, logB]);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ type: "standalone", log: logA });
    expect(result[1]).toEqual({ type: "standalone", log: logB });
  });

  it("groups a For Each node with its body logs into iterations", () => {
    const forEachLog = makeLog({
      nodeId: "fe-1",
      nodeType: "For Each",
    });
    const bodyLog0 = makeLog({
      nodeId: "body-1",
      forEachNodeId: "fe-1",
      iterationIndex: 0,
      startedAt: new Date("2025-01-01T00:00:01Z"),
    });
    const bodyLog1 = makeLog({
      nodeId: "body-2",
      forEachNodeId: "fe-1",
      iterationIndex: 1,
      startedAt: new Date("2025-01-01T00:00:02Z"),
    });

    const result = groupLogsByIteration([forEachLog, bodyLog0, bodyLog1]);

    expect(result).toHaveLength(1);
    const entry = result[0];
    expect(entry.type).toBe("for-each-group");
    if (entry.type === "for-each-group") {
      expect(entry.forEachLog).toBe(forEachLog);
      expect(entry.collectLog).toBeNull();
      expect(entry.iterations).toHaveLength(2);
      expect(entry.iterations[0].iterationIndex).toBe(0);
      expect(entry.iterations[0].logs).toEqual([bodyLog0]);
      expect(entry.iterations[1].iterationIndex).toBe(1);
      expect(entry.iterations[1].logs).toEqual([bodyLog1]);
    }
  });

  it("treats a For Each log with no child logs as standalone", () => {
    const forEachLog = makeLog({
      nodeId: "fe-1",
      nodeType: "For Each",
    });

    const result = groupLogsByIteration([forEachLog]);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: "standalone", log: forEachLog });
  });

  it("handles mixed standalone and For Each entries", () => {
    const standaloneA = makeLog({
      nodeId: "s-1",
      nodeType: "action",
    });
    const forEachLog = makeLog({
      nodeId: "fe-1",
      nodeType: "For Each",
    });
    const bodyLog = makeLog({
      nodeId: "body-1",
      forEachNodeId: "fe-1",
      iterationIndex: 0,
    });
    const standaloneB = makeLog({
      nodeId: "s-2",
      nodeType: "action",
    });

    const result = groupLogsByIteration([
      standaloneA,
      forEachLog,
      bodyLog,
      standaloneB,
    ]);

    expect(result).toHaveLength(3);
    expect(result[0].type).toBe("standalone");
    expect(result[1].type).toBe("for-each-group");
    expect(result[2].type).toBe("standalone");

    if (result[0].type === "standalone") {
      expect(result[0].log).toBe(standaloneA);
    }
    if (result[1].type === "for-each-group") {
      expect(result[1].forEachLog).toBe(forEachLog);
      expect(result[1].iterations).toHaveLength(1);
      expect(result[1].iterations[0].logs).toEqual([bodyLog]);
    }
    if (result[2].type === "standalone") {
      expect(result[2].log).toBe(standaloneB);
    }
  });

  it("handles multiple For Each groups in the same execution", () => {
    const fe1 = makeLog({
      nodeId: "fe-1",
      nodeType: "For Each",
    });
    const fe1Body = makeLog({
      nodeId: "b1",
      forEachNodeId: "fe-1",
      iterationIndex: 0,
    });
    const fe2 = makeLog({
      nodeId: "fe-2",
      nodeType: "For Each",
    });
    const fe2Body = makeLog({
      nodeId: "b2",
      forEachNodeId: "fe-2",
      iterationIndex: 0,
    });

    const result = groupLogsByIteration([fe1, fe1Body, fe2, fe2Body]);

    expect(result).toHaveLength(2);
    expect(result[0].type).toBe("for-each-group");
    expect(result[1].type).toBe("for-each-group");

    if (result[0].type === "for-each-group") {
      expect(result[0].forEachLog).toBe(fe1);
      expect(result[0].iterations[0].logs).toEqual([fe1Body]);
    }
    if (result[1].type === "for-each-group") {
      expect(result[1].forEachLog).toBe(fe2);
      expect(result[1].iterations[0].logs).toEqual([fe2Body]);
    }
  });

  it("treats logs with null iterationIndex and null forEachNodeId as standalone", () => {
    const log = makeLog({
      iterationIndex: null,
      forEachNodeId: null,
      nodeType: "action",
    });

    const result = groupLogsByIteration([log]);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("standalone");
    if (result[0].type === "standalone") {
      expect(result[0].log).toBe(log);
    }
  });

  it("does not duplicate body logs - they appear only in iterations, not as standalone", () => {
    const forEachLog = makeLog({
      nodeId: "fe-1",
      nodeType: "For Each",
    });
    const bodyA = makeLog({
      nodeId: "body-a",
      forEachNodeId: "fe-1",
      iterationIndex: 0,
    });
    const bodyB = makeLog({
      nodeId: "body-b",
      forEachNodeId: "fe-1",
      iterationIndex: 1,
    });

    const result = groupLogsByIteration([forEachLog, bodyA, bodyB]);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("for-each-group");

    const standaloneEntries = result.filter((e) => e.type === "standalone");
    expect(standaloneEntries).toHaveLength(0);
  });

  it("treats a For Each node with nodeType 'For Each' but no matching children as standalone", () => {
    const forEachLog = makeLog({
      nodeId: "fe-1",
      nodeType: "For Each",
    });

    const result = groupLogsByIteration([forEachLog]);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("standalone");
    if (result[0].type === "standalone") {
      expect(result[0].log).toBe(forEachLog);
    }
  });

  it("preserves original order of standalone logs", () => {
    const logA = makeLog({ nodeType: "action" });
    const logB = makeLog({ nodeType: "action" });
    const logC = makeLog({ nodeType: "action" });
    const logD = makeLog({ nodeType: "action" });

    const result = groupLogsByIteration([logA, logB, logC, logD]);

    expect(result).toHaveLength(4);
    for (const [i, entry] of result.entries()) {
      expect(entry.type).toBe("standalone");
      if (entry.type === "standalone") {
        expect(entry.log).toBe([logA, logB, logC, logD][i]);
      }
    }
  });

  it("treats a log with forEachNodeId set but iterationIndex null as standalone", () => {
    const edgeCase = makeLog({
      nodeId: "orphan-1",
      forEachNodeId: "fe-1",
      iterationIndex: null,
      nodeType: "action",
    });

    const result = groupLogsByIteration([edgeCase]);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("standalone");
    if (result[0].type === "standalone") {
      expect(result[0].log).toBe(edgeCase);
    }
  });

  it("treats a log with iterationIndex set but forEachNodeId null as standalone", () => {
    const edgeCase = makeLog({
      nodeId: "orphan-2",
      iterationIndex: 3,
      forEachNodeId: null,
      nodeType: "action",
    });

    const result = groupLogsByIteration([edgeCase]);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("standalone");
    if (result[0].type === "standalone") {
      expect(result[0].log).toBe(edgeCase);
    }
  });

  it("groups multiple body steps within the same iteration correctly", () => {
    const forEachLog = makeLog({
      nodeId: "fe-1",
      nodeType: "For Each",
    });
    const stepA = makeLog({
      nodeId: "step-a",
      forEachNodeId: "fe-1",
      iterationIndex: 0,
      startedAt: new Date("2025-01-01T00:00:01Z"),
    });
    const stepB = makeLog({
      nodeId: "step-b",
      forEachNodeId: "fe-1",
      iterationIndex: 0,
      startedAt: new Date("2025-01-01T00:00:02Z"),
    });
    const stepC = makeLog({
      nodeId: "step-c",
      forEachNodeId: "fe-1",
      iterationIndex: 0,
      startedAt: new Date("2025-01-01T00:00:03Z"),
    });

    const result = groupLogsByIteration([forEachLog, stepA, stepB, stepC]);

    expect(result).toHaveLength(1);
    if (result[0].type === "for-each-group") {
      expect(result[0].iterations).toHaveLength(1);
      expect(result[0].iterations[0].logs).toEqual([stepA, stepB, stepC]);
    }
  });

  it("correctly handles body logs appearing before the For Each log in the array", () => {
    const bodyLog = makeLog({
      nodeId: "body-1",
      forEachNodeId: "fe-1",
      iterationIndex: 0,
    });
    const forEachLog = makeLog({
      nodeId: "fe-1",
      nodeType: "For Each",
    });

    const result = groupLogsByIteration([bodyLog, forEachLog]);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("for-each-group");
    if (result[0].type === "for-each-group") {
      expect(result[0].forEachLog).toBe(forEachLog);
      expect(result[0].iterations[0].logs).toEqual([bodyLog]);
    }
  });

  it("correctly handles a For Each with many iterations and many body steps", () => {
    const forEachLog = makeLog({
      nodeId: "fe-1",
      nodeType: "For Each",
    });

    const bodyLogs: IterationLogFields[] = [];
    for (let iteration = 0; iteration < 5; iteration++) {
      for (let step = 0; step < 3; step++) {
        bodyLogs.push(
          makeLog({
            nodeId: `step-${step}`,
            forEachNodeId: "fe-1",
            iterationIndex: iteration,
            startedAt: new Date(`2025-01-01T00:0${iteration}:0${step}Z`),
          })
        );
      }
    }

    const result = groupLogsByIteration([forEachLog, ...bodyLogs]);

    expect(result).toHaveLength(1);
    if (result[0].type === "for-each-group") {
      expect(result[0].iterations).toHaveLength(5);
      for (const group of result[0].iterations) {
        expect(group.logs).toHaveLength(3);
      }
      const indices = result[0].iterations.map((g) => g.iterationIndex);
      expect(indices).toEqual([0, 1, 2, 3, 4]);
    }
  });

  it("does not treat a non-For-Each node as a group even if children reference it", () => {
    const actionLog = makeLog({
      nodeId: "action-1",
      nodeType: "action",
    });
    const childLog = makeLog({
      nodeId: "child-1",
      forEachNodeId: "action-1",
      iterationIndex: 0,
    });

    const result = groupLogsByIteration([actionLog, childLog]);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("standalone");
    if (result[0].type === "standalone") {
      expect(result[0].log).toBe(actionLog);
    }
  });

  it("attaches Collect log to its For Each group and skips it from standalone", () => {
    const forEachLog = makeLog({
      nodeId: "fe-1",
      nodeType: "For Each",
    });
    const bodyLog = makeLog({
      nodeId: "body-1",
      forEachNodeId: "fe-1",
      iterationIndex: 0,
    });
    const collectLog = makeLog({
      nodeId: "collect-1",
      nodeType: "Collect",
      forEachNodeId: "fe-1",
      iterationIndex: null,
    });

    const result = groupLogsByIteration([forEachLog, bodyLog, collectLog]);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("for-each-group");
    if (result[0].type === "for-each-group") {
      expect(result[0].collectLog).toBe(collectLog);
      expect(result[0].iterations).toHaveLength(1);
    }
  });

  it("nested For Each finds inner children when lookup is provided", () => {
    const outerFe = makeLog({
      nodeId: "fe-outer",
      nodeType: "For Each",
    });
    const innerFe = makeLog({
      nodeId: "fe-inner",
      nodeType: "For Each",
      forEachNodeId: "fe-outer",
      iterationIndex: 0,
      startedAt: new Date("2025-01-01T00:00:01Z"),
    });
    const innerBody0 = makeLog({
      nodeId: "http-1",
      forEachNodeId: "fe-inner",
      iterationIndex: 0,
      startedAt: new Date("2025-01-01T00:00:02Z"),
    });
    const innerBody1 = makeLog({
      nodeId: "http-1",
      forEachNodeId: "fe-inner",
      iterationIndex: 1,
      startedAt: new Date("2025-01-01T00:00:03Z"),
    });
    const innerCollect = makeLog({
      nodeId: "collect-inner",
      nodeType: "Collect",
      forEachNodeId: "fe-inner",
      iterationIndex: null,
    });
    const outerCollect = makeLog({
      nodeId: "collect-outer",
      nodeType: "Collect",
      forEachNodeId: "fe-outer",
      iterationIndex: null,
    });

    const allLogs = [
      outerFe,
      innerFe,
      innerBody0,
      innerBody1,
      innerCollect,
      outerCollect,
    ];
    const lookup = buildChildLogsLookup(allLogs);

    // Top level: outer For Each group with collectLog
    const topResult = groupLogsByIteration(allLogs, lookup);
    expect(topResult).toHaveLength(1);
    expect(topResult[0].type).toBe("for-each-group");
    if (topResult[0].type === "for-each-group") {
      expect(topResult[0].forEachLog).toBe(outerFe);
      expect(topResult[0].collectLog).toBe(outerCollect);
      expect(topResult[0].iterations).toHaveLength(1);

      // Recursive: inner For Each inside outer iteration 0
      const outerIterLogs = topResult[0].iterations[0].logs;
      expect(outerIterLogs).toEqual([innerFe]);

      const innerResult = groupLogsByIteration(outerIterLogs, lookup);
      expect(innerResult).toHaveLength(1);
      expect(innerResult[0].type).toBe("for-each-group");
      if (innerResult[0].type === "for-each-group") {
        expect(innerResult[0].forEachLog).toBe(innerFe);
        expect(innerResult[0].collectLog).toBe(innerCollect);
        expect(innerResult[0].iterations).toHaveLength(2);
        expect(innerResult[0].iterations[0].logs).toEqual([innerBody0]);
        expect(innerResult[0].iterations[1].logs).toEqual([innerBody1]);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// buildChildLogsLookup
// ---------------------------------------------------------------------------

describe("buildChildLogsLookup", () => {
  it("builds child and collect maps from a flat log array", () => {
    const forEachLog = makeLog({
      nodeId: "fe-1",
      nodeType: "For Each",
    });
    const bodyLog = makeLog({
      nodeId: "body-1",
      forEachNodeId: "fe-1",
      iterationIndex: 0,
    });
    const collectLog = makeLog({
      nodeId: "collect-1",
      nodeType: "Collect",
      forEachNodeId: "fe-1",
      iterationIndex: null,
    });
    const standalone = makeLog({ nodeType: "action" });

    const lookup = buildChildLogsLookup([
      forEachLog,
      bodyLog,
      collectLog,
      standalone,
    ]);

    expect(lookup.childLogs.get("fe-1")).toEqual([bodyLog]);
    expect(lookup.collectLogs.get("fe-1")).toEqual([collectLog]);
    expect(lookup.childLogs.size).toBe(1);
    expect(lookup.collectLogs.size).toBe(1);
    expect(lookup.invocations.get("fe-1")).toEqual([forEachLog]);
  });

  it("partitions multi-invocation child logs by time window", () => {
    const outerFe = makeLog({
      nodeId: "fe-outer",
      nodeType: "For Each",
      startedAt: new Date("2025-01-01T00:00:00Z"),
    });
    // Inner For Each invocation 1 (outer iteration 0)
    const innerFe1 = makeLog({
      nodeId: "fe-inner",
      nodeType: "For Each",
      forEachNodeId: "fe-outer",
      iterationIndex: 0,
      startedAt: new Date("2025-01-01T00:01:00Z"),
    });
    const innerBody1a = makeLog({
      nodeId: "http-1",
      forEachNodeId: "fe-inner",
      iterationIndex: 0,
      startedAt: new Date("2025-01-01T00:01:01Z"),
    });
    const innerBody1b = makeLog({
      nodeId: "http-1",
      forEachNodeId: "fe-inner",
      iterationIndex: 1,
      startedAt: new Date("2025-01-01T00:01:02Z"),
    });
    const innerCollect1 = makeLog({
      nodeId: "collect-inner",
      nodeType: "Collect",
      forEachNodeId: "fe-inner",
      iterationIndex: null,
      startedAt: new Date("2025-01-01T00:01:03Z"),
    });
    // Inner For Each invocation 2 (outer iteration 1)
    const innerFe2 = makeLog({
      nodeId: "fe-inner",
      nodeType: "For Each",
      forEachNodeId: "fe-outer",
      iterationIndex: 1,
      startedAt: new Date("2025-01-01T00:02:00Z"),
    });
    const innerBody2a = makeLog({
      nodeId: "http-1",
      forEachNodeId: "fe-inner",
      iterationIndex: 0,
      startedAt: new Date("2025-01-01T00:02:01Z"),
    });
    const innerBody2b = makeLog({
      nodeId: "http-1",
      forEachNodeId: "fe-inner",
      iterationIndex: 1,
      startedAt: new Date("2025-01-01T00:02:02Z"),
    });
    const innerBody2c = makeLog({
      nodeId: "http-1",
      forEachNodeId: "fe-inner",
      iterationIndex: 2,
      startedAt: new Date("2025-01-01T00:02:03Z"),
    });
    const innerCollect2 = makeLog({
      nodeId: "collect-inner",
      nodeType: "Collect",
      forEachNodeId: "fe-inner",
      iterationIndex: null,
      startedAt: new Date("2025-01-01T00:02:04Z"),
    });
    const outerCollect = makeLog({
      nodeId: "collect-outer",
      nodeType: "Collect",
      forEachNodeId: "fe-outer",
      iterationIndex: null,
      startedAt: new Date("2025-01-01T00:03:00Z"),
    });

    const allLogs = [
      outerFe,
      innerFe1,
      innerBody1a,
      innerBody1b,
      innerCollect1,
      innerFe2,
      innerBody2a,
      innerBody2b,
      innerBody2c,
      innerCollect2,
      outerCollect,
    ];
    const lookup = buildChildLogsLookup(allLogs);

    // Top level: outer For Each with 2 iterations
    const topResult = groupLogsByIteration(allLogs, lookup);
    expect(topResult).toHaveLength(1);
    if (topResult[0].type !== "for-each-group") {
      throw new Error("Expected for-each-group");
    }
    expect(topResult[0].collectLog).toBe(outerCollect);
    expect(topResult[0].iterations).toHaveLength(2);

    // Outer iteration 0: contains innerFe1
    const outerIter0 = topResult[0].iterations[0].logs;
    expect(outerIter0).toEqual([innerFe1]);
    const innerResult1 = groupLogsByIteration(outerIter0, lookup);
    expect(innerResult1).toHaveLength(1);
    if (innerResult1[0].type !== "for-each-group") {
      throw new Error("Expected for-each-group");
    }
    // Invocation 1: 2 inner iterations
    expect(innerResult1[0].iterations).toHaveLength(2);
    expect(innerResult1[0].iterations[0].logs).toEqual([innerBody1a]);
    expect(innerResult1[0].iterations[1].logs).toEqual([innerBody1b]);
    expect(innerResult1[0].collectLog).toBe(innerCollect1);

    // Outer iteration 1: contains innerFe2
    const outerIter1 = topResult[0].iterations[1].logs;
    expect(outerIter1).toEqual([innerFe2]);
    const innerResult2 = groupLogsByIteration(outerIter1, lookup);
    expect(innerResult2).toHaveLength(1);
    if (innerResult2[0].type !== "for-each-group") {
      throw new Error("Expected for-each-group");
    }
    // Invocation 2: 3 inner iterations
    expect(innerResult2[0].iterations).toHaveLength(3);
    expect(innerResult2[0].iterations[0].logs).toEqual([innerBody2a]);
    expect(innerResult2[0].iterations[1].logs).toEqual([innerBody2b]);
    expect(innerResult2[0].iterations[2].logs).toEqual([innerBody2c]);
    expect(innerResult2[0].collectLog).toBe(innerCollect2);
  });

  it("returns empty maps for logs with no For Each relationships", () => {
    const logA = makeLog({ nodeType: "action" });
    const logB = makeLog({ nodeType: "action" });

    const lookup = buildChildLogsLookup([logA, logB]);

    expect(lookup.childLogs.size).toBe(0);
    expect(lookup.collectLogs.size).toBe(0);
  });
});
