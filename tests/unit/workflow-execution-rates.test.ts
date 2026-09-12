/**
 * Which workflows the per-workflow execution rate gauge keeps. The gauge feeds
 * an alert meant to catch one runaway workflow, so the pick has to keep both
 * the busiest workflows and the ones piling up errors, and stay bounded.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  pickWorkflowExecutionRates,
  type WorkflowExecutionRate,
} from "@/lib/metrics/db-metrics";

const rate = (
  workflowId: string,
  runs: number,
  errored: number
): WorkflowExecutionRate => ({ workflowId, orgSlug: "acme", runs, errored });

const ids = (rows: WorkflowExecutionRate[]): string[] =>
  rows.map((row) => row.workflowId).sort();

describe("pickWorkflowExecutionRates", () => {
  it("keeps the busiest workflows by runs", () => {
    const rows = [rate("a", 10, 0), rate("b", 500, 0), rate("c", 90, 0)];
    expect(ids(pickWorkflowExecutionRates(rows, 2))).toEqual(["b", "c"]);
  });

  it("also keeps a workflow that errors a lot but runs less than the busiest", () => {
    const rows = [
      rate("busy", 900, 0),
      rate("busier", 950, 1),
      rate("bad", 60, 60),
    ];
    expect(ids(pickWorkflowExecutionRates(rows, 2))).toEqual([
      "bad",
      "busier",
      "busy",
    ]);
  });

  it("lists a workflow once when it leads both lists", () => {
    const rows = [rate("runaway", 4200, 3900), rate("quiet", 3, 0)];
    const picked = pickWorkflowExecutionRates(rows, 1);
    expect(ids(picked)).toEqual(["runaway"]);
  });

  it("does not pick a workflow for errors it does not have", () => {
    const rows = [rate("a", 5, 0), rate("b", 4, 0), rate("c", 3, 0)];
    expect(ids(pickWorkflowExecutionRates(rows, 1))).toEqual(["a"]);
  });

  it("returns nothing when nothing ran", () => {
    expect(pickWorkflowExecutionRates([])).toEqual([]);
  });
});
