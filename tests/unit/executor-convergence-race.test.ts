/**
 * KEEP-395 (Bug 1): convergence template renders chain-dep predecessor as null.
 *
 * Tests the `mergeFromTracker` helper used at the convergence-target
 * template-render call site. The closure-captured `outputs` map can carry a
 * stale snapshot for the LAST predecessor under "use workflow" SDK replay;
 * the in-process step-success-tracker is the authoritative source for
 * completed steps.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { mergeFromTracker } from "@/lib/workflow/executor/convergence-tracker-merge";
import type { WorkflowNode } from "@/lib/workflow/store";

type FakeNodeOpts = {
  id: string;
  label?: string;
};

function makeNode({ id, label }: FakeNodeOpts): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      type: "action",
      label: label ?? id,
      config: {},
    },
  } as unknown as WorkflowNode;
}

const getNodeName = (n: WorkflowNode): string =>
  (n.data.label as string) ?? n.id;

describe("mergeFromTracker (KEEP-395 Bug 1)", () => {
  it("returns the original outputs when executionId is undefined", () => {
    const outputs = { a: { label: "A", data: 1 } };
    const result = mergeFromTracker({
      outputs,
      executionId: undefined,
      predecessorIds: ["a"],
      nodeMap: new Map([["a", makeNode({ id: "a" })]]),
      getTracker: () => new Map([["a", 999]]),
      getNodeName,
    });
    expect(result).toBe(outputs);
  });

  it("returns the original outputs when predecessorIds is empty", () => {
    const outputs = { a: { label: "A", data: 1 } };
    const result = mergeFromTracker({
      outputs,
      executionId: "exec-1",
      predecessorIds: [],
      nodeMap: new Map([["a", makeNode({ id: "a" })]]),
      getTracker: () => new Map([["a", 999]]),
      getNodeName,
    });
    expect(result).toBe(outputs);
  });

  it("returns the original outputs when tracker has no entries for execution", () => {
    const outputs = { a: { label: "A", data: 1 } };
    const result = mergeFromTracker({
      outputs,
      executionId: "exec-1",
      predecessorIds: ["a"],
      nodeMap: new Map([["a", makeNode({ id: "a" })]]),
      getTracker: () => undefined,
      getNodeName,
    });
    expect(result).toBe(outputs);
  });

  it("returns the original outputs when tracker has no entry for any predecessor", () => {
    const outputs = { a: { label: "A", data: 1 } };
    const result = mergeFromTracker({
      outputs,
      executionId: "exec-1",
      predecessorIds: ["a", "b"],
      nodeMap: new Map([
        ["a", makeNode({ id: "a" })],
        ["b", makeNode({ id: "b" })],
      ]),
      getTracker: () => new Map([["c", 42]]),
      getNodeName,
    });
    expect(result).toBe(outputs);
  });

  it("overrides closure entry with tracker entry when both exist", () => {
    // The closure has a STALE null for `cmpRate` (the bug: SDK replay sees
    // the snapshot before the post-await mutation lands). The tracker has
    // the real recorded output. Tracker must win.
    const stale = { label: "cmpRate", data: null };
    const outputs = {
      cmpRate: stale,
      otherPred: { label: "OP", data: { x: 1 } },
    };
    const fresh = { rate: 4.5, source: "compound" };

    const result = mergeFromTracker({
      outputs,
      executionId: "exec-1",
      predecessorIds: ["cmpRate", "otherPred"],
      nodeMap: new Map([
        ["cmpRate", makeNode({ id: "cmpRate", label: "cmpRate" })],
        ["otherPred", makeNode({ id: "otherPred", label: "OP" })],
      ]),
      getTracker: () => new Map<string, unknown>([["cmpRate", fresh]]),
      getNodeName,
    });

    expect(result).not.toBe(outputs);
    expect(result.cmpRate).toEqual({ label: "cmpRate", data: fresh });
    // Predecessors with no tracker entry are left untouched.
    expect(result.otherPred).toBe(outputs.otherPred);
    // Original outputs map is NOT mutated.
    expect(outputs.cmpRate).toBe(stale);
    expect(outputs.cmpRate.data).toBeNull();
  });

  it("sanitises non-alphanumeric chars in node IDs the same way the executor does", () => {
    // Executor stores outputs under sanitized keys (id.replace(/[^a-zA-Z0-9]/g, "_")).
    // The tracker keys are the raw node IDs. Merge MUST produce a sanitized key.
    const rawId = "node-with-dashes.and.dots";
    const sanitized = "node_with_dashes_and_dots";
    const outputs = {
      [sanitized]: { label: "raw", data: null },
    };
    const fresh = { ok: true };

    const result = mergeFromTracker({
      outputs,
      executionId: "exec-1",
      predecessorIds: [rawId],
      nodeMap: new Map([[rawId, makeNode({ id: rawId, label: "raw" })]]),
      getTracker: () => new Map<string, unknown>([[rawId, fresh]]),
      getNodeName,
    });

    expect(result[sanitized]).toEqual({ label: "raw", data: fresh });
  });

  it("merges last-arriving predecessor in a 4-fan-in convergence (regression)", () => {
    // Repro of the original bug shape: 4 predecessors -> combine. D is the
    // slowest and is the LAST to arrive. The closure captured the snapshot
    // when D was still null. Tracker has D's real result.
    const outputs = {
      A: { label: "A", data: 0.05 },
      B: { label: "B", data: 0.06 },
      C: { label: "C", data: 0.04 },
      D: { label: "D", data: null },
    };
    const dFresh = 0.075;

    const result = mergeFromTracker({
      outputs,
      executionId: "exec-fanin",
      predecessorIds: ["A", "B", "C", "D"],
      nodeMap: new Map([
        ["A", makeNode({ id: "A" })],
        ["B", makeNode({ id: "B" })],
        ["C", makeNode({ id: "C" })],
        ["D", makeNode({ id: "D" })],
      ]),
      getTracker: () => new Map<string, unknown>([["D", dFresh]]),
      getNodeName,
    });

    expect(result.D.data).toBe(dFresh);
    // The other predecessors are not touched (no tracker entry).
    expect(result.A).toBe(outputs.A);
    expect(result.B).toBe(outputs.B);
    expect(result.C).toBe(outputs.C);
  });

  it("skips predecessors that are not in nodeMap (defensive)", () => {
    // If a node has been removed from nodeMap mid-flight (defensive guard),
    // the tracker entry is ignored rather than throwing.
    const outputs = { a: { label: "A", data: null } };
    const result = mergeFromTracker({
      outputs,
      executionId: "exec-1",
      predecessorIds: ["a"],
      nodeMap: new Map(),
      getTracker: () => new Map<string, unknown>([["a", 1]]),
      getNodeName,
    });
    expect(result).toBe(outputs);
  });
});
