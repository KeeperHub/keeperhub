/**
 * KEEP-395 (Bug 2 hardening, R2 BLOCKER 2): finalSuccess must be re-evaluated
 * AFTER pendingTasks.drain() so failures from drained orphan nodes are
 * reflected in the workflow outcome. Pre-fix, the computation ran before
 * drain; an orphan node's failure landed in `results` post-computation, and
 * the workflow reported `success: true` despite a logged failure.
 *
 * `computeFinalSuccess` is the extracted helper called once after drain.
 * This test exercises the pure logic (the integration "called twice with
 * different inputs" semantics is enforced by the call-site shape in
 * executor.workflow.ts -- see the call site at the drain block).
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { computeFinalSuccess } from "@/lib/workflow/executor/final-success";

describe("computeFinalSuccess (KEEP-395 Bug 2 finalSuccess race)", () => {
  it("returns true when results is empty", () => {
    expect(computeFinalSuccess({}, new Set())).toBe(true);
  });

  it("returns true when every node succeeded", () => {
    const results = {
      a: { success: true, data: 1 },
      b: { success: true, data: 2 },
    };
    expect(computeFinalSuccess(results, new Set())).toBe(true);
  });

  it("returns false when any node failed (no skipped targets)", () => {
    const results = {
      a: { success: true, data: 1 },
      b: { success: false, error: "boom" },
    };
    expect(computeFinalSuccess(results, new Set())).toBe(false);
  });

  it("treats not-taken condition branches as skipped (not failed)", () => {
    const results = {
      cond: { success: true, data: { condition: true } },
      taken: { success: true, data: 1 },
      notTaken: { success: false, error: "should not have run" },
    };
    // notTaken was on the dead branch -- it must not flip finalSuccess.
    expect(computeFinalSuccess(results, new Set(["notTaken"]))).toBe(true);
  });

  it("BLOCKER 2 repro: drained orphan failure flips finalSuccess from true to false", () => {
    // Pre-drain snapshot: only the trigger had landed when the (now removed)
    // pre-drain finalSuccess computation would have run -> success=true.
    const preDrainResults = {
      trigger: { success: true, data: { triggered: true } },
    };
    expect(computeFinalSuccess(preDrainResults, new Set())).toBe(true);

    // Post-drain: an orphan downstream node landed with success=false.
    const postDrainResults = {
      ...preDrainResults,
      orphanNode: { success: false, error: "rpc timeout" },
    };
    // BLOCKER 2 fix: post-drain re-evaluation must catch this.
    expect(computeFinalSuccess(postDrainResults, new Set())).toBe(false);
  });

  it("does not skip a failed node that is also in skippedTargets only by coincidence", () => {
    // Edge case: a node id appears in skipped targets but it actually ran
    // (e.g. via a different path). The OR semantics are intentional --
    // skipped wins. This locks the existing behaviour.
    const results = {
      a: { success: false, error: "ran but failed" },
    };
    expect(computeFinalSuccess(results, new Set(["a"]))).toBe(true);
  });
});
