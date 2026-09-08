/**
 * KEEP-543: iteration-aware step-success-tracker.
 *
 * Verifies that the tracker disambiguates body-step successes across parallel
 * For Each iterations so spurious-recovery returns the correct iteration's
 * output instead of whichever iteration was last to write.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  clearExecution,
  getStepSuccess,
  getSuccessfulSteps,
  recordStepSuccess,
} from "@/lib/workflow/executor/step-success-tracker";

const execId = "exec-iter-test";

afterEach(() => {
  clearExecution(execId);
});

describe("step-success-tracker iteration-aware key", () => {
  it("top-level recordStepSuccess remains retrievable without iteration key", () => {
    recordStepSuccess(execId, "node-a", { result: 1 });

    const entry = getStepSuccess(execId, "node-a");
    expect(entry).toEqual({ output: { result: 1 } });
  });

  it("multiple iterations of the same body node coexist without clobbering", () => {
    const fe = "for-each-1";
    const node = "check-debt-ceiling";

    recordStepSuccess(
      execId,
      node,
      { ceiling: 100 },
      {
        forEachNodeId: fe,
        iterationIndex: 0,
      }
    );
    recordStepSuccess(
      execId,
      node,
      { ceiling: 200 },
      {
        forEachNodeId: fe,
        iterationIndex: 1,
      }
    );
    recordStepSuccess(
      execId,
      node,
      { ceiling: 300 },
      {
        forEachNodeId: fe,
        iterationIndex: 2,
      }
    );

    expect(
      getStepSuccess(execId, node, { forEachNodeId: fe, iterationIndex: 0 })
    ).toEqual({ output: { ceiling: 100 } });
    expect(
      getStepSuccess(execId, node, { forEachNodeId: fe, iterationIndex: 1 })
    ).toEqual({ output: { ceiling: 200 } });
    expect(
      getStepSuccess(execId, node, { forEachNodeId: fe, iterationIndex: 2 })
    ).toEqual({ output: { ceiling: 300 } });
  });

  it("top-level and iteration entries with the same nodeId do not collide", () => {
    const fe = "for-each-1";
    recordStepSuccess(execId, "node-x", { top: true });
    recordStepSuccess(
      execId,
      "node-x",
      { iter: 0 },
      {
        forEachNodeId: fe,
        iterationIndex: 0,
      }
    );

    expect(getStepSuccess(execId, "node-x")).toEqual({
      output: { top: true },
    });
    expect(
      getStepSuccess(execId, "node-x", { forEachNodeId: fe, iterationIndex: 0 })
    ).toEqual({ output: { iter: 0 } });
  });

  it("entries from different forEach parents at the same iteration index do not collide", () => {
    recordStepSuccess(
      execId,
      "node-x",
      { from: "fe-a" },
      {
        forEachNodeId: "fe-a",
        iterationIndex: 0,
      }
    );
    recordStepSuccess(
      execId,
      "node-x",
      { from: "fe-b" },
      {
        forEachNodeId: "fe-b",
        iterationIndex: 0,
      }
    );

    expect(
      getStepSuccess(execId, "node-x", {
        forEachNodeId: "fe-a",
        iterationIndex: 0,
      })
    ).toEqual({ output: { from: "fe-a" } });
    expect(
      getStepSuccess(execId, "node-x", {
        forEachNodeId: "fe-b",
        iterationIndex: 0,
      })
    ).toEqual({ output: { from: "fe-b" } });
  });

  it("returns undefined when the iteration entry is missing", () => {
    recordStepSuccess(
      execId,
      "node-x",
      { result: 1 },
      {
        forEachNodeId: "fe-1",
        iterationIndex: 0,
      }
    );

    expect(
      getStepSuccess(execId, "node-x", {
        forEachNodeId: "fe-1",
        iterationIndex: 1,
      })
    ).toBeUndefined();
  });

  it("getSuccessfulSteps returns non-empty Map when only iteration entries exist (cold-pod detection still works)", () => {
    recordStepSuccess(
      execId,
      "node-x",
      { result: 1 },
      {
        forEachNodeId: "fe-1",
        iterationIndex: 0,
      }
    );

    const steps = getSuccessfulSteps(execId);
    expect(steps).toBeDefined();
    expect(steps?.size).toBeGreaterThan(0);
  });

  it("clearExecution removes both top-level and iteration entries", () => {
    recordStepSuccess(execId, "node-x", { top: true });
    recordStepSuccess(
      execId,
      "node-x",
      { iter: 0 },
      {
        forEachNodeId: "fe-1",
        iterationIndex: 0,
      }
    );

    clearExecution(execId);

    expect(getStepSuccess(execId, "node-x")).toBeUndefined();
    expect(
      getStepSuccess(execId, "node-x", {
        forEachNodeId: "fe-1",
        iterationIndex: 0,
      })
    ).toBeUndefined();
    expect(getSuccessfulSteps(execId)).toBeUndefined();
  });

  it("records falsy outputs (null, 0, false) without losing the entry", () => {
    recordStepSuccess(execId, "node-null", null, {
      forEachNodeId: "fe",
      iterationIndex: 0,
    });
    recordStepSuccess(execId, "node-zero", 0, {
      forEachNodeId: "fe",
      iterationIndex: 0,
    });
    recordStepSuccess(execId, "node-false", false, {
      forEachNodeId: "fe",
      iterationIndex: 0,
    });

    expect(
      getStepSuccess(execId, "node-null", {
        forEachNodeId: "fe",
        iterationIndex: 0,
      })
    ).toEqual({ output: null });
    expect(
      getStepSuccess(execId, "node-zero", {
        forEachNodeId: "fe",
        iterationIndex: 0,
      })
    ).toEqual({ output: 0 });
    expect(
      getStepSuccess(execId, "node-false", {
        forEachNodeId: "fe",
        iterationIndex: 0,
      })
    ).toEqual({ output: false });
  });
});
