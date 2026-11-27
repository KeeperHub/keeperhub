import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { workflowExecutionLogs } from "@/lib/db/schema";
import {
  NO_RUN_OUTCOME_SIGNALS,
  runOutcomeLogSql,
  runOutcomeOf,
  runOutcomeReason,
  signalsOfStep,
  stepOutcomeKeysSql,
} from "@/lib/workflow/executor/run-outcome";
import type { StepContext } from "@/lib/workflow/executor/step-handler";
import {
  clearExecution,
  getRunOutcomeSignals,
  recordRunOutcomeIfPresent,
} from "@/lib/workflow/executor/step-success-tracker";
import {
  runLogsDue,
  selectedRunPollMs,
  selectedRunPollMsAfterError,
} from "@/lib/workflow/run-polling";

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

  it("is skipped for a skipped bundle step, whatever other steps sent", () => {
    expect(runOutcomeOf(signals(true, false))).toBe("skipped");
  });

  it("is not_landed for any not-included step, a skip beside it too", () => {
    expect(runOutcomeOf(signals(false, true))).toBe("not_landed");
    expect(runOutcomeOf(signals(true, true))).toBe("not_landed");
  });

  it("is nothing without a signal", () => {
    expect(runOutcomeOf(NO_RUN_OUTCOME_SIGNALS)).toBeUndefined();
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

describe("runOutcomeReason", () => {
  it("says the skipped step sent no transaction, and nothing about other steps", () => {
    expect(runOutcomeReason("skipped")).toBe(
      "Skipped: this workflow's earlier bundle could still land, so the bundle step sent no transaction."
    );
  });

  it("says a missed bundle pays no gas unless it lands", () => {
    expect(runOutcomeReason("not_landed")).toContain(
      "No gas is paid for a bundle that does not land"
    );
    // A not-checked bundle may have landed: the reason never claims it did not.
    expect(runOutcomeReason("not_landed")).toContain("or could not be checked");
  });

  it("matches what a step's output signals", () => {
    const skip = signalsOfStep(WRITE, { route: "skipped-in-flight" });
    expect(runOutcomeReason(runOutcomeOf(skip) ?? "not_landed")).toMatch(
      /^Skipped:/
    );
  });
});

describe("stepOutcomeKeysSql", () => {
  it("reads each key only on a Write Contract row, and only when it holds a JSON string, as signalsOfStep does", () => {
    const keys = stepOutcomeKeysSql(workflowExecutionLogs);
    const dialect = new PgDialect();
    for (const [part, key] of [
      [keys.route, "route"],
      [keys.notIncludedReason, "notIncludedReason"],
    ] as const) {
      const text = dialect.sqlToQuery(part).sql.replace(/\s+/g, " ");
      // The node type is checked first, so no other row's output is read.
      expect(text).toBe(
        `CASE WHEN "workflow_execution_logs"."node_type" IN ('web3/write-contract', 'Write Contract') THEN CASE WHEN jsonb_typeof("workflow_execution_logs"."output"->'${key}') = 'string' THEN "workflow_execution_logs"."output"->>'${key}' END END`
      );
    }
  });
});

describe("run views reading a not landed run again", () => {
  it("reads a selected not landed run slowly, a pending or running one fast, and stops otherwise", () => {
    expect(selectedRunPollMs("running")).toBe(500);
    expect(selectedRunPollMs("pending")).toBe(500);
    expect(selectedRunPollMs("not_landed")).toBe(60_000);
    for (const status of ["success", "error", "skipped", "cancelled"]) {
      expect(selectedRunPollMs(status)).toBeNull();
    }
  });

  it("stops after a refused read and retries other failed reads slowly", () => {
    for (const status of [400, 401, 403, 404, 410]) {
      expect(selectedRunPollMsAfterError(status)).toBeNull();
    }
    for (const status of [undefined, 408, 429, 500, 502, 503]) {
      expect(selectedRunPollMsAfterError(status)).toBe(60_000);
    }
  });

  it("loads an open run's steps again once for each end status it reaches", () => {
    expect(runLogsDue("running", false, undefined)).toBe(true);
    expect(runLogsDue("not_landed", true, undefined)).toBe(true);
    expect(runLogsDue("not_landed", true, "not_landed")).toBe(false);
    // Re-settled by a late landing: the steps are read again, then not again.
    expect(runLogsDue("success", true, "not_landed")).toBe(true);
    expect(runLogsDue("success", true, "success")).toBe(false);
  });
});
