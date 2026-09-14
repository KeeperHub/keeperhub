/**
 * Which workflows the per-workflow execution rate gauge exports. The gauge feeds
 * an alert meant to catch one runaway workflow, so it must stay empty in normal
 * operation, export a workflow that reaches either threshold, and stay bounded
 * when many reach one at once.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  pickWorkflowExecutionRates,
  WORKFLOW_EXECUTION_RATE_LIMITS,
  type WorkflowExecutionRate,
} from "@/lib/metrics/db-metrics";

const LIMITS = { runs: 100, errored: 10, maxWorkflows: 2 };

const rate = (
  workflowId: string,
  runs: number,
  errored: number
): WorkflowExecutionRate => ({ workflowId, orgSlug: "acme", runs, errored });

const ids = (rows: WorkflowExecutionRate[]): string[] =>
  rows.map((row) => row.workflowId).sort();

describe("pickWorkflowExecutionRates", () => {
  it("exports nothing while every workflow is below both thresholds", () => {
    const rows = [rate("a", 99, 9), rate("b", 50, 0), rate("c", 1, 1)];
    expect(pickWorkflowExecutionRates(rows, LIMITS)).toEqual([]);
  });

  it("exports a workflow that reaches the runs threshold", () => {
    const rows = [rate("busy", 100, 0), rate("quiet", 99, 0)];
    expect(ids(pickWorkflowExecutionRates(rows, LIMITS))).toEqual(["busy"]);
  });

  it("exports a workflow that reaches the errored threshold on few runs", () => {
    const rows = [rate("bad", 12, 10), rate("fine", 12, 9)];
    expect(ids(pickWorkflowExecutionRates(rows, LIMITS))).toEqual(["bad"]);
  });

  it("keeps the workflows furthest over a threshold when more reach one than the cap", () => {
    // runaway is 9x the runs threshold, failing 6x the errored one, barely 1.01x.
    const rows = [
      rate("barely", 101, 0),
      rate("runaway", 900, 0),
      rate("failing", 20, 60),
    ];
    expect(ids(pickWorkflowExecutionRates(rows, LIMITS))).toEqual([
      "failing",
      "runaway",
    ]);
  });

  it("exports nothing at the default thresholds for ordinary traffic", () => {
    const rows = [rate("steady", 600, 0), rate("flaky", 200, 30)];
    expect(pickWorkflowExecutionRates(rows)).toEqual([]);
    expect(WORKFLOW_EXECUTION_RATE_LIMITS.maxWorkflows).toBeGreaterThan(0);
  });

  it("returns nothing when nothing ran", () => {
    expect(pickWorkflowExecutionRates([])).toEqual([]);
  });
});
