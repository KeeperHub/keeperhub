/**
 * For Each stop-on-failure: post-loop Collect / done-targets must not run
 * after any failed iteration.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/step-registry", () => ({
  getActionLabel: (actionType: string) => actionType,
  getStepImporter: () => undefined,
}));

import {
  countIterationFailures,
  findFirstIterationFailure,
  isForEachBodyFailureResult,
  markCollectSkippedOnForEachFailure,
  resolveBodyFailureNodeId,
  settleForEachPostLoop,
} from "@/lib/workflow/executor/executor.workflow";
import { FOR_EACH_BODY_FAILURE_MARKER } from "@/lib/workflow/nodes/for-each/iteration-failure";

const markedFailure = {
  [FOR_EACH_BODY_FAILURE_MARKER]: true as const,
  success: false as const,
  error: "boom",
  nodeId: "step-a",
};

const mappedFailure = { error: "boom", nodeId: "step-a" };

describe("findFirstIterationFailure", () => {
  it("returns undefined when all iterations succeeded", () => {
    expect(
      findFirstIterationFailure([
        { success: true, data: 1 },
        { success: true, data: 2 },
      ])
    ).toBeUndefined();
  });

  it("returns the first marked body failure", () => {
    expect(
      findFirstIterationFailure([
        { success: true },
        markedFailure,
        {
          [FOR_EACH_BODY_FAILURE_MARKER]: true as const,
          success: false as const,
          error: "later",
        },
      ])
    ).toEqual(markedFailure);
  });

  it("ignores bare success:false shapes without the marker", () => {
    expect(
      findFirstIterationFailure([
        { success: false, error: "api error object" },
        markedFailure,
      ])
    ).toEqual(markedFailure);
    expect(
      findFirstIterationFailure([{ success: false, error: "api error object" }])
    ).toBeUndefined();
  });

  it("ignores null and non-object results", () => {
    expect(findFirstIterationFailure([null, "x", markedFailure])).toEqual(
      markedFailure
    );
  });
});

describe("countIterationFailures", () => {
  it("counts only marked body failures", () => {
    const results = Array.from({ length: 500 }, (_, index) => {
      if (index === 1 || index === 50 || index === 400) {
        return {
          [FOR_EACH_BODY_FAILURE_MARKER]: true as const,
          success: false as const,
          error: `fail-${index}`,
        };
      }
      if (index === 10) {
        return { success: false, error: "api-shaped output" };
      }
      return { ok: index };
    });

    expect(countIterationFailures(results)).toBe(3);
  });
});

describe("isForEachBodyFailureResult", () => {
  it("accepts only the shared marker", () => {
    expect(isForEachBodyFailureResult(markedFailure)).toBe(true);
    expect(
      isForEachBodyFailureResult({ success: false, error: "api-shaped" })
    ).toBe(false);
    expect(isForEachBodyFailureResult(null)).toBe(false);
  });
});

describe("markCollectSkippedOnForEachFailure", () => {
  it("marks aggregate Collect visited and records explicit failure with data", () => {
    const visited = new Set<string>();
    const attempted = new Set<string>();
    const results: Record<
      string,
      { success: boolean; error?: string; data?: unknown }
    > = {};
    const iterationResults = [markedFailure, { ok: 2 }];

    markCollectSkippedOnForEachFailure({
      aggregateCollectNodeId: "done-collect",
      collectNodeId: "legacy-collect",
      doneCollectNodeId: "done-collect",
      error: "body failed",
      iterationResults,
      currentVisited: visited,
      currentResults: results,
      attemptedNodes: attempted,
    });

    expect(visited.has("done-collect")).toBe(true);
    expect(visited.has("legacy-collect")).toBe(true);
    expect(attempted.has("done-collect")).toBe(true);
    expect(attempted.has("legacy-collect")).toBe(true);
    expect(results["done-collect"]).toEqual({
      success: false,
      error: "body failed",
      data: {
        results: [mappedFailure, { ok: 2 }],
        count: 2,
        skipped: true,
      },
    });
  });

  it("does not mark legacy in-body Collect when it is the done Collect", () => {
    const visited = new Set<string>();
    const attempted = new Set<string>();
    const results: Record<
      string,
      { success: boolean; error?: string; data?: unknown }
    > = {};

    markCollectSkippedOnForEachFailure({
      aggregateCollectNodeId: "collect-1",
      collectNodeId: "collect-1",
      doneCollectNodeId: "collect-1",
      error: "body failed",
      iterationResults: [markedFailure],
      currentVisited: visited,
      currentResults: results,
      attemptedNodes: attempted,
    });

    expect([...visited]).toEqual(["collect-1"]);
    expect([...attempted]).toEqual(["collect-1"]);
    expect(results["collect-1"]?.success).toBe(false);
    expect(results["collect-1"]?.data).toEqual({
      results: [mappedFailure],
      count: 1,
      skipped: true,
    });
  });
});

describe("resolveBodyFailureNodeId", () => {
  it("prefers nested summary firstFailureNodeId over the bodyResults key", () => {
    expect(
      resolveBodyFailureNodeId([
        "inner-fe",
        {
          success: false,
          error: "inner body failed",
          data: {
            firstFailureNodeId: "fail-step",
            failedIterations: 1,
          },
        },
      ])
    ).toBe("fail-step");
  });

  it("falls back to the bodyResults key when summary has no firstFailureNodeId", () => {
    expect(
      resolveBodyFailureNodeId(["step-a", { success: false, error: "boom" }])
    ).toBe("step-a");
  });
});

describe("settleForEachPostLoop", () => {
  const emptyVisited = () => ({
    visited: new Set<string>(),
    attempted: new Set<string>(),
    results: {} as Record<
      string,
      { success: boolean; error?: string; data?: unknown }
    >,
  });

  it("skips Collect and done-targets when an iteration failed", async () => {
    const onAggregateCollect = vi.fn();
    const onDoneTargets = vi.fn();
    const { visited, attempted, results } = emptyVisited();

    const result = await settleForEachPostLoop({
      firstIterationFailure: markedFailure,
      continuation: { kind: "aggregate-collect", collectNodeId: "collect-1" },
      onAggregateCollect,
      onDoneTargets,
      collectNodeId: "collect-1",
      doneCollectNodeId: "collect-1",
      iterationResults: [markedFailure],
      currentVisited: visited,
      currentResults: results,
      attemptedNodes: attempted,
    });

    expect(result).toBe("skipped");
    expect(onAggregateCollect).not.toHaveBeenCalled();
    expect(onDoneTargets).not.toHaveBeenCalled();
    expect(results["collect-1"]?.data).toEqual({
      results: [mappedFailure],
      count: 1,
      skipped: true,
    });
  });

  it("skips done-targets continuation when an iteration failed", async () => {
    const onAggregateCollect = vi.fn();
    const onDoneTargets = vi.fn();
    const { visited, attempted, results } = emptyVisited();

    const result = await settleForEachPostLoop({
      firstIterationFailure: markedFailure,
      continuation: { kind: "done-targets", targets: ["after-1"] },
      onAggregateCollect,
      onDoneTargets,
      collectNodeId: undefined,
      doneCollectNodeId: undefined,
      iterationResults: [markedFailure],
      currentVisited: visited,
      currentResults: results,
      attemptedNodes: attempted,
    });

    expect(result).toBe("skipped");
    expect(onDoneTargets).not.toHaveBeenCalled();
  });

  it("runs aggregate-collect when all iterations succeeded", async () => {
    const onAggregateCollect = vi.fn().mockResolvedValue(undefined);
    const onDoneTargets = vi.fn();
    const { visited, attempted, results } = emptyVisited();

    const result = await settleForEachPostLoop({
      firstIterationFailure: undefined,
      continuation: { kind: "aggregate-collect", collectNodeId: "collect-1" },
      onAggregateCollect,
      onDoneTargets,
      collectNodeId: "collect-1",
      doneCollectNodeId: "collect-1",
      iterationResults: [{ ok: true }],
      currentVisited: visited,
      currentResults: results,
      attemptedNodes: attempted,
    });

    expect(result).toBe("aggregate-collect");
    expect(onAggregateCollect).toHaveBeenCalledWith("collect-1");
    expect(onDoneTargets).not.toHaveBeenCalled();
  });

  it("runs done-targets when all iterations succeeded", async () => {
    const onAggregateCollect = vi.fn();
    const onDoneTargets = vi.fn().mockResolvedValue(undefined);
    const { visited, attempted, results } = emptyVisited();

    const result = await settleForEachPostLoop({
      firstIterationFailure: undefined,
      continuation: { kind: "done-targets", targets: ["a", "b"] },
      onAggregateCollect,
      onDoneTargets,
      collectNodeId: undefined,
      doneCollectNodeId: undefined,
      iterationResults: [{ ok: true }],
      currentVisited: visited,
      currentResults: results,
      attemptedNodes: attempted,
    });

    expect(result).toBe("done-targets");
    expect(onDoneTargets).toHaveBeenCalledWith(["a", "b"]);
    expect(onAggregateCollect).not.toHaveBeenCalled();
  });

  it("returns none when there is no post-loop continuation", async () => {
    const onAggregateCollect = vi.fn();
    const onDoneTargets = vi.fn();
    const { visited, attempted, results } = emptyVisited();

    const result = await settleForEachPostLoop({
      firstIterationFailure: undefined,
      continuation: { kind: "none" },
      onAggregateCollect,
      onDoneTargets,
      collectNodeId: undefined,
      doneCollectNodeId: undefined,
      iterationResults: [{ ok: true }],
      currentVisited: visited,
      currentResults: results,
      attemptedNodes: attempted,
    });

    expect(result).toBe("none");
    expect(onAggregateCollect).not.toHaveBeenCalled();
    expect(onDoneTargets).not.toHaveBeenCalled();
  });

  it("skips Collect dispatch and marks Collect skipped with data", async () => {
    const onAggregateCollect = vi.fn();
    const onDoneTargets = vi.fn();
    const visited = new Set<string>();
    const attempted = new Set<string>();
    const results: Record<
      string,
      { success: boolean; error?: string; data?: unknown }
    > = {
      "for-each": { success: false, error: "body failed" },
    };
    const iterationResults = [markedFailure];

    const outcome = await settleForEachPostLoop({
      firstIterationFailure: markedFailure,
      continuation: { kind: "aggregate-collect", collectNodeId: "collect-1" },
      onAggregateCollect,
      onDoneTargets,
      collectNodeId: "collect-1",
      doneCollectNodeId: "collect-1",
      iterationResults,
      currentVisited: visited,
      currentResults: results,
      attemptedNodes: attempted,
    });

    expect(outcome).toBe("skipped");
    expect(onAggregateCollect).not.toHaveBeenCalled();
    expect(visited.has("collect-1")).toBe(true);
    expect(attempted.has("collect-1")).toBe(true);
    expect(results["collect-1"]?.data).toEqual({
      results: [mappedFailure],
      count: 1,
      skipped: true,
    });
    expect(Object.values(results).at(-1)?.data).toEqual({
      results: [mappedFailure],
      count: 1,
      skipped: true,
    });
  });
});
