import { describe, expect, it } from "vitest";
import {
  computeTrulyFailedNodes,
  type TrulyFailedLogRow,
} from "@/lib/workflow/executor/truly-failed-nodes";

function row(
  partial: Partial<TrulyFailedLogRow> & { nodeId: string; status: string }
): TrulyFailedLogRow {
  return {
    iterationIndex: null,
    forEachNodeId: null,
    ...partial,
  };
}

describe("computeTrulyFailedNodes", () => {
  it("returns empty when every top-level node has a success row", () => {
    expect(
      computeTrulyFailedNodes([
        row({ nodeId: "a", status: "success" }),
        row({ nodeId: "b", status: "success" }),
      ])
    ).toEqual([]);
  });

  it("flags a top-level node that has only an error row", () => {
    expect(
      computeTrulyFailedNodes([row({ nodeId: "a", status: "error" })])
    ).toEqual(["a"]);
  });

  it("flags a top-level node with only a running row (no success)", () => {
    expect(
      computeTrulyFailedNodes([row({ nodeId: "a", status: "running" })])
    ).toEqual(["a"]);
  });

  it("treats a top-level node as succeeded if ANY row succeeded (cross-pod orphan)", () => {
    expect(
      computeTrulyFailedNodes([
        row({ nodeId: "a", status: "error" }),
        row({ nodeId: "a", status: "success" }),
      ])
    ).toEqual([]);
  });

  it("treats absent (undefined) loop fields as a top-level row, not an iteration row", () => {
    // Mirrors rows that omit the loop columns: must NOT be misread as an
    // iteration row, otherwise a genuinely failed top-level node is dropped.
    const logs = [
      {
        nodeId: "a",
        status: "error",
        iterationIndex: undefined,
        forEachNodeId: undefined,
      },
    ] satisfies TrulyFailedLogRow[];
    expect(computeTrulyFailedNodes(logs)).toEqual(["a"]);
  });

  it("flags the parent For Each when an iteration-body step has no success row", () => {
    const logs = [
      // forEachStep pre-logs the parent as success before iterations run.
      row({ nodeId: "loop", status: "success" }),
      row({
        nodeId: "scan",
        status: "error",
        iterationIndex: 0,
        forEachNodeId: "loop",
      }),
    ];
    expect(computeTrulyFailedNodes(logs)).toEqual(["loop"]);
  });

  it("does NOT flag the For Each when the iteration step was recovered (success row present)", () => {
    const logs = [
      row({ nodeId: "loop", status: "success" }),
      row({
        nodeId: "scan",
        status: "error",
        iterationIndex: 0,
        forEachNodeId: "loop",
      }),
      row({
        nodeId: "scan",
        status: "success",
        iterationIndex: 0,
        forEachNodeId: "loop",
      }),
    ];
    expect(computeTrulyFailedNodes(logs)).toEqual([]);
  });

  it("does not let a sibling iteration's success mask a different iteration's failure", () => {
    const logs = [
      row({
        nodeId: "scan",
        status: "success",
        iterationIndex: 0,
        forEachNodeId: "loop",
      }),
      row({
        nodeId: "scan",
        status: "error",
        iterationIndex: 1,
        forEachNodeId: "loop",
      }),
    ];
    expect(computeTrulyFailedNodes(logs)).toEqual(["loop"]);
  });

  it("reports both a failed top-level node and a failed loop, de-duplicated", () => {
    const logs = [
      row({ nodeId: "http", status: "error" }),
      row({
        nodeId: "scan",
        status: "error",
        iterationIndex: 0,
        forEachNodeId: "loop",
      }),
      row({
        nodeId: "other",
        status: "error",
        iterationIndex: 1,
        forEachNodeId: "loop",
      }),
    ];
    expect(computeTrulyFailedNodes(logs).sort()).toEqual(["http", "loop"]);
  });
});
