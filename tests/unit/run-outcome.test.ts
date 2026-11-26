import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { workflowExecutionLogs } from "@/lib/db/schema";
import {
  NO_RUN_OUTCOME_SIGNALS,
  runOutcomeLogSql,
  runOutcomeOf,
  signalsOfStep,
} from "@/lib/workflow/executor/run-outcome";
import type { StepContext } from "@/lib/workflow/executor/step-handler";
import {
  clearExecution,
  getRunOutcomeSignals,
  recordRunOutcomeIfPresent,
} from "@/lib/workflow/executor/step-success-tracker";

const WRITE = "web3/write-contract";
const executionId = "exec_run_outcome";
const context: StepContext = {
  executionId,
  nodeId: "write-contract-1",
  nodeName: "Write Contract",
  nodeType: WRITE,
};

afterEach(() => {
  clearExecution(executionId);
});

describe("signalsOfStep", () => {
  it.each([
    [{ route: "skipped-in-flight" }, true, false],
    [{ included: false, notIncludedReason: "not-picked" }, false, true],
    [{ notIncludedReason: " " }, false, false],
    [{ notIncludedReason: "" }, false, false],
    [{ notIncludedReason: 1 }, false, false],
    [{ route: "bundle", included: true }, false, false],
    [{ data: { route: "skipped-in-flight" } }, false, false],
    [[{ route: "skipped-in-flight" }], false, false],
    [null, false, false],
    ["skipped-in-flight", false, false],
  ])("%j", (output, skippedInFlight, notIncluded) => {
    expect(signalsOfStep(WRITE, output)).toEqual({
      skippedInFlight,
      notIncluded,
    });
  });

  it("reads the legacy Write Contract name", () => {
    expect(
      signalsOfStep("Write Contract", { route: "skipped-in-flight" })
    ).toEqual({ skippedInFlight: true, notIncluded: false });
  });

  it.each(["http-request", "code/run-code", "web3/read-contract", "Condition"])(
    "ignores the keys on a %s step",
    (nodeType) => {
      expect(
        signalsOfStep(nodeType, {
          route: "skipped-in-flight",
          notIncludedReason: "not-picked",
        })
      ).toEqual(NO_RUN_OUTCOME_SIGNALS);
    }
  );
});

describe("runOutcomeOf", () => {
  const signals = (skippedInFlight: boolean, notIncluded: boolean) => ({
    skippedInFlight,
    notIncluded,
  });

  it("is skipped only when nothing was sent", () => {
    expect(runOutcomeOf(signals(true, false), false)).toBe("skipped");
    expect(runOutcomeOf(signals(true, false), true)).toBe("not_landed");
  });

  it("is not_landed for any not-included step, sent or not", () => {
    expect(runOutcomeOf(signals(false, true), false)).toBe("not_landed");
    expect(runOutcomeOf(signals(true, true), false)).toBe("not_landed");
  });

  it("is nothing without a signal", () => {
    expect(runOutcomeOf(NO_RUN_OUTCOME_SIGNALS, true)).toBeUndefined();
  });
});

describe("runOutcomeLogSql", () => {
  it("limits the log scan to Write Contract rows with either key", () => {
    const { sql } = new PgDialect().sqlToQuery(
      runOutcomeLogSql(workflowExecutionLogs)
    );
    expect(sql).toContain(
      `"node_type" IN ('web3/write-contract', 'Write Contract')`
    );
    expect(sql).toContain(`->>'route' = 'skipped-in-flight'`);
    expect(sql).toContain(
      `btrim("workflow_execution_logs"."output_raw"->>'notIncludedReason', U&' \\0009\\000A\\000B\\000C\\000D\\200B\\200C\\200D\\FEFF') <> ''`
    );
  });
});

describe("blank not-included reasons", () => {
  const zeroWidth = [0x20_0b, 0x20_0c, 0x20_0d, 0xfe_ff].map((point) =>
    String.fromCodePoint(point)
  );

  it.each([
    ["a tab", "\t"],
    ["a newline and spaces", " \n "],
    ...zeroWidth.map((char, i): [string, string] => [`zero-width ${i}`, char]),
    ["all zero-width characters", zeroWidth.join("")],
  ])("%s is no reason", (_label, reason) => {
    expect(
      signalsOfStep(WRITE, { notIncludedReason: reason }).notIncluded
    ).toBe(false);
  });

  it("text around a zero-width character is a reason", () => {
    expect(
      signalsOfStep(WRITE, { notIncludedReason: `${zeroWidth[0]}x` })
        .notIncluded
    ).toBe(true);
  });
});

describe("recordRunOutcomeIfPresent", () => {
  it("merges the signals of every step and clears with the execution", () => {
    recordRunOutcomeIfPresent(context, { notIncludedReason: "not-picked" });
    recordRunOutcomeIfPresent(context, { route: "public", included: true });
    recordRunOutcomeIfPresent(context, { route: "skipped-in-flight" });
    expect(getRunOutcomeSignals(executionId)).toEqual({
      skippedInFlight: true,
      notIncluded: true,
    });
    clearExecution(executionId);
    expect(getRunOutcomeSignals(executionId)).toEqual(NO_RUN_OUTCOME_SIGNALS);
  });

  it("records nothing for another action's output or without an execution", () => {
    recordRunOutcomeIfPresent(
      { ...context, nodeType: "http-request" },
      { route: "skipped-in-flight" }
    );
    recordRunOutcomeIfPresent(
      { ...context, executionId: undefined },
      { notIncludedReason: "not-picked" }
    );
    expect(getRunOutcomeSignals(executionId)).toEqual(NO_RUN_OUTCOME_SIGNALS);
  });
});
