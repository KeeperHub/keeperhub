/**
 * KEEP-468 edge cases surfaced during PR review:
 *
 * #1 NULL passthrough — `extractTemplateParameters` previously could not
 *    distinguish "the reference truly did not resolve" from "the reference
 *    resolved cleanly to a legitimate null upstream value." A workflow that
 *    queried a SQL row whose column was NULL would have false-tripped the
 *    strict gate. The discriminated `*Checked` resolvers fix this by
 *    returning `{found: false, reason}` only for genuine miss-paths and
 *    `{found: true, value: null}` for real null values.
 *
 * #3 Condition expressions — only stored-format tokens are substituted in
 *    condition expressions; display-format and legacy `$` tokens that slip
 *    through fed into the JS evaluator and surfaced as a misleading
 *    "Unexpected token '{'" syntax error. The new post-substitution scan
 *    fails closed with a clear "unresolved template reference" message
 *    before the unsafe eval ever runs.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  evaluateConditionExpression,
  extractTemplateParameters,
  resolveDisplayTemplateChecked,
  resolveTemplateToRawValueChecked,
} from "@/lib/workflow/executor/executor.workflow";
import type { TemplateResolutionTracker } from "@/lib/workflow/executor/template-resolution";

type NodeOutputs = Record<string, { label: string; data: unknown }>;

const DISPLAY_REF_ERROR =
  /unresolved template reference\(s\): \{\{Trigger\.value\}\}/;
const DOLLAR_REF_ERROR =
  /unresolved template reference\(s\): \{\{\$n1\.value\}\}/;
const MULTI_LEFTOVER_ERROR =
  /\{\{Trigger\.x\}\}.*\{\{Trigger\.y\}\}|\{\{Trigger\.y\}\}.*\{\{Trigger\.x\}\}/;

describe("KEEP-468 #1: legitimate NULL upstream value is not unresolved", () => {
  const outputsWithNullColumn: NodeOutputs = {
    db_query_1: {
      label: "DB Query",
      data: { rows: [{ id: 1, optional_field: null }] },
    },
  };

  it("resolveTemplateToRawValueChecked returns {found:true,value:null} for a real null", () => {
    const result = resolveTemplateToRawValueChecked(
      "db_query_1",
      "DB Query.rows[0].optional_field",
      outputsWithNullColumn
    );
    expect(result).toEqual({ found: true, value: null });
  });

  it("resolveTemplateToRawValueChecked distinguishes no-node, no-data, no-path", () => {
    expect(
      resolveTemplateToRawValueChecked(
        "missing_node",
        "X.y",
        outputsWithNullColumn
      )
    ).toEqual({ found: false, reason: "no-node" });

    const outputsWithNullData: NodeOutputs = {
      n1: { label: "Step", data: null },
    };
    expect(
      resolveTemplateToRawValueChecked("n1", "Step.x", outputsWithNullData)
    ).toEqual({
      found: false,
      reason: "no-data",
    });

    expect(
      resolveTemplateToRawValueChecked(
        "db_query_1",
        "DB Query.does_not_exist",
        outputsWithNullColumn
      )
    ).toEqual({ found: false, reason: "no-path" });
  });

  it("resolveDisplayTemplateChecked returns {found:true,value:null} for a real null", () => {
    const result = resolveDisplayTemplateChecked(
      "DB Query.rows[0].optional_field",
      outputsWithNullColumn
    );
    expect(result).toEqual({ found: true, value: null });
  });

  it("extractTemplateParameters does NOT flag a legitimate null in the tracker", () => {
    const tracker: TemplateResolutionTracker = { unresolved: [] };
    const { paramValues } = extractTemplateParameters(
      "UPDATE t SET col = {{@db_query_1:DB Query.rows[0].optional_field}}",
      outputsWithNullColumn,
      tracker
    );
    // Real null is preserved as a SQL parameter and the tracker stays empty.
    expect(paramValues).toEqual([null]);
    expect(tracker.unresolved).toHaveLength(0);
  });

  it("extractTemplateParameters DOES flag a truly missing reference", () => {
    const tracker: TemplateResolutionTracker = { unresolved: [] };
    extractTemplateParameters(
      "UPDATE t SET col = {{@db_query_1:DB Query.missing_field}}",
      outputsWithNullColumn,
      tracker
    );
    expect(tracker.unresolved.length).toBeGreaterThan(0);
    expect(tracker.unresolved[0]?.reason).toBe("no-path");
  });
});

describe("KEEP-468 #3: condition expressions reject non-stored leftover tokens", () => {
  const outputs: NodeOutputs = {
    n1: { label: "Trigger", data: { value: 5 } },
  };

  it("throws a clear error when a display-format token is used in a condition", () => {
    expect(() =>
      evaluateConditionExpression(
        "{{Trigger.value}} > 10",
        outputs,
        new Map(),
        {}
      )
    ).toThrow(DISPLAY_REF_ERROR);
  });

  it("throws on legacy `$`-format tokens too", () => {
    expect(() =>
      evaluateConditionExpression("{{$n1.value}} === 5", outputs, new Map(), {})
    ).toThrow(DOLLAR_REF_ERROR);
  });

  it("does NOT throw when only stored-format tokens are present", () => {
    // The condition evaluates fine because the stored token is substituted
    // and the leftover scan finds nothing.
    expect(
      evaluateConditionExpression(
        "{{@n1:Trigger.value}} > 1",
        outputs,
        new Map([["n1", {}]]),
        { n1: { success: true, data: outputs.n1.data } }
      ).result
    ).toBe(true);
  });

  it("collects multiple distinct leftover tokens in a single error", () => {
    expect(() =>
      evaluateConditionExpression(
        "{{Trigger.x}} === 1 && {{Trigger.y}} === 2",
        outputs,
        new Map(),
        {}
      )
    ).toThrow(MULTI_LEFTOVER_ERROR);
  });
});
