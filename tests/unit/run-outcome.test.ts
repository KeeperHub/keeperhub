import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { workflowExecutionLogs, workflowExecutions } from "@/lib/db/schema";
import {
  billableAfterSettle,
  isOtherWorkStep,
  NO_RUN_OUTCOME_SIGNALS,
  otherWorkSql,
  runOutcomeCode,
  runOutcomeLogSql,
  runOutcomeOf,
  runOutcomeReason,
  runOutcomeSignalSql,
  signalsOfStep,
  stepOutcomeKeysSql,
} from "@/lib/workflow/executor/run-outcome";
import {
  BUNDLE_ROUTES,
  bundleReservationEnd,
  bundleSignalsOfStep,
  isBundleRoute,
  isUnbilledOutcome,
  nodeOutcomeOf,
  RUN_OUTCOME_REASON,
  SKIP_REASON,
  SKIPPED_WHILE_RUNNING_REASON,
  skippedMetricReason,
  skipReasonOf,
  WAITING_STEP_TEXT,
  waitingStepSentence,
} from "@/lib/workflow/executor/run-outcome-keys";
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
// The bundleSent condition's route list, as rendered SQL.
const BUNDLE_SENT_ROUTES_RE = /->>'route' IN \(([^)]*)\)/;
const NOT_BUNDLE_ROUTES = [
  "public",
  "private-relay",
  "waiting",
  "skipped-in-flight",
  "Bundle",
];
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
    expect(signalsOfStep(WRITE, output)).toMatchObject({
      skippedInFlight,
      notIncluded,
      waiting: false,
    });
  });

  it("reads the legacy Write Contract name", () => {
    expect(
      signalsOfStep("Write Contract", { route: "skipped-in-flight" })
    ).toEqual({
      ...NO_RUN_OUTCOME_SIGNALS,
      skippedInFlight: true,
      otherWork: true,
    });
  });

  it.each([
    ["http-request", true],
    ["code/run-code", true],
    ["web3/read-contract", false],
    ["Condition", false],
  ])("ignores the bundle keys on a %s step", (nodeType, otherWork) => {
    expect(
      signalsOfStep(nodeType, {
        route: "skipped-in-flight",
        notIncludedReason: "not-picked",
      })
    ).toEqual({ ...NO_RUN_OUTCOME_SIGNALS, otherWork });
  });

  it("marks a sent bundle, and only a waiting bundle step as no other work", () => {
    expect(signalsOfStep(WRITE, { route: "bundle", included: true })).toEqual({
      ...NO_RUN_OUTCOME_SIGNALS,
      bundleSent: true,
      otherWork: true,
    });
    expect(signalsOfStep(WRITE, { route: "waiting", included: false })).toEqual(
      { ...NO_RUN_OUTCOME_SIGNALS, waiting: true }
    );
  });

  it("reads a waiting step held back by Max Fee as any other waiting step", () => {
    const feeHeld = {
      route: "waiting",
      included: false,
      bundleTargetsSkipped: [
        { block: 1004, reason: "max-fee-below-projected-base-fee" },
      ],
    };
    expect(signalsOfStep(WRITE, feeHeld)).toEqual({
      ...NO_RUN_OUTCOME_SIGNALS,
      waiting: true,
    });
    expect(isOtherWorkStep(WRITE, feeHeld)).toBe(false);
    expect(waitingStepSentence(feeHeld)).toMatch(/^Max Fee held back/);
    expect(
      waitingStepSentence({
        route: "waiting",
        bundleTargetsSkipped: [{ block: 1004, reason: "target-passed" }],
      })
    ).toBe(WAITING_STEP_TEXT.sentence);
    expect(waitingStepSentence(null)).toBe(WAITING_STEP_TEXT.sentence);
  });
});

describe("isOtherWorkStep", () => {
  it.each([
    ["trigger", { triggeredAt: "x", triggerGasUsed: "21000" }, false],
    ["web3/read-contract", { success: true, result: "1" }, false],
    ["Read Contract", { success: true }, false],
    ["Condition", { result: false }, false],
    ["For Each", {}, true],
    ["Collect", { count: 2 }, true],
    ["web3/batch-read-contract", { results: [] }, true],
    ["web3/decode-calldata", { functionName: "transfer" }, true],
    ["web3/check-balance", { balance: "1" }, false],
    [WRITE, { route: "waiting", included: false }, false],
    [WRITE, { route: "waiting", transactionHash: "0xabc" }, true],
    [WRITE, { route: "waiting", gasUsed: "21000" }, true],
    ["web3/read-contract", { gasUsed: "1" }, true],
    [WRITE, { route: "public", transactionHash: "0xabc" }, true],
    [WRITE, { success: false }, true],
    [WRITE, null, true],
    ["HTTP Request", { status: 200 }, true],
    ["discord/send-message", { success: true }, true],
    ["code/run-code", { result: 1 }, true],
    ["web3/transfer-funds", { success: false }, true],
  ])("%s %j: %s", (nodeType, output, expected) => {
    expect(isOtherWorkStep(nodeType, output)).toBe(expected);
  });
});

describe("runOutcomeOf", () => {
  const signals = (
    skippedInFlight: boolean,
    notIncluded: boolean,
    waiting = false
  ) => ({
    ...NO_RUN_OUTCOME_SIGNALS,
    skippedInFlight,
    notIncluded,
    waiting,
  });

  it("is skipped for a waiting bundle step, and not_landed beats it", () => {
    expect(runOutcomeOf(signals(false, false, true))).toBe("skipped");
    expect(runOutcomeOf(signals(false, true, true))).toBe("not_landed");
  });

  it("lets a sent bundle's landing beat a waiting step (For Each)", () => {
    expect(
      runOutcomeOf({ ...signals(false, false, true), bundleSent: true })
    ).toBeUndefined();
    expect(
      runOutcomeOf({
        ...signals(false, false, true),
        bundleSent: true,
        otherWork: true,
      })
    ).toBeUndefined();
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
    expect(sql).toContain(`->>'route' = 'waiting'`);
    expect(sql).toContain(
      `btrim("workflow_execution_logs"."output_raw"->>'notIncludedReason', U&' \\0009\\000A\\000B\\000C\\000D\\200B\\200C\\200D\\FEFF') <> ''`
    );
  });
});

describe("bundle routes: TS and SQL agree", () => {
  it("the SQL bundleSent signal lists exactly BUNDLE_ROUTES", () => {
    const text = new PgDialect()
      .sqlToQuery(runOutcomeSignalSql(workflowExecutionLogs).bundleSent)
      .sql.replace(/\s+/g, " ");
    const listed = BUNDLE_SENT_ROUTES_RE.exec(text)?.[1]
      .split(", ")
      .map((quoted) => quoted.slice(1, -1));
    expect(listed).toEqual([...BUNDLE_ROUTES]);
  });

  it.each(BUNDLE_ROUTES)("route %s is a sent bundle in TS", (route) => {
    expect(isBundleRoute(route)).toBe(true);
    expect(bundleSignalsOfStep(WRITE, { route }).bundleSent).toBe(true);
    expect(signalsOfStep(WRITE, { route }).bundleSent).toBe(true);
    expect(
      bundleReservationEnd({ success: true, route, included: false })
    ).toBe("settle");
    expect(
      bundleReservationEnd({
        success: true,
        route,
        included: false,
        notIncludedReason: "not-picked",
      })
    ).toBe("hold");
  });

  it.each(NOT_BUNDLE_ROUTES)("route %s is no sent bundle", (route) => {
    expect(isBundleRoute(route)).toBe(false);
    expect(bundleSignalsOfStep(WRITE, { route }).bundleSent).toBe(false);
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
      ...NO_RUN_OUTCOME_SIGNALS,
      skippedInFlight: true,
      notIncluded: true,
      otherWork: true,
    });
    clearExecution(executionId);
    expect(getRunOutcomeSignals(executionId)).toEqual(NO_RUN_OUTCOME_SIGNALS);
  });

  it("records only other work for another action's output, nothing without an execution", () => {
    recordRunOutcomeIfPresent(
      { ...context, nodeType: "http-request" },
      { route: "skipped-in-flight" }
    );
    recordRunOutcomeIfPresent(
      { ...context, executionId: undefined },
      { notIncludedReason: "not-picked" }
    );
    expect(getRunOutcomeSignals(executionId)).toEqual({
      ...NO_RUN_OUTCOME_SIGNALS,
      otherWork: true,
    });
    recordRunOutcomeIfPresent(
      { ...context, nodeType: "web3/read-contract" },
      { result: "1" }
    );
    expect(getRunOutcomeSignals(executionId).otherWork).toBe(true);
  });
});

describe("runOutcomeReason", () => {
  it("says the skipped step sent no transaction, and nothing about other steps", () => {
    expect(runOutcomeReason("skipped", NO_RUN_OUTCOME_SIGNALS)).toBe(
      "Skipped: this workflow's earlier bundle could still land, so the bundle step sent no transaction."
    );
  });

  it("says a missed bundle pays no gas unless it lands", () => {
    expect(runOutcomeReason("not_landed", NO_RUN_OUTCOME_SIGNALS)).toContain(
      "No gas is paid for a bundle that does not land"
    );
    // A not-checked bundle may have landed: the reason never claims it did not.
    expect(runOutcomeReason("not_landed", NO_RUN_OUTCOME_SIGNALS)).toContain(
      "or could not be checked"
    );
  });

  it("matches what a step's output signals", () => {
    const skip = signalsOfStep(WRITE, { route: "skipped-in-flight" });
    expect(runOutcomeReason(runOutcomeOf(skip) ?? "not_landed", skip)).toMatch(
      /^Skipped:/
    );
  });

  it("gives a waiting run its own reason; a skip in flight wins", () => {
    const waiting = signalsOfStep(WRITE, { route: "waiting" });
    expect(waiting).toEqual({ ...NO_RUN_OUTCOME_SIGNALS, waiting: true });
    expect(runOutcomeReason("skipped", waiting)).toBe(
      RUN_OUTCOME_REASON.waiting
    );
    expect(runOutcomeCode("skipped", waiting)).toBe("bundle-waiting");
    expect(
      runOutcomeReason("skipped", { ...waiting, skippedInFlight: true })
    ).toMatch(/^Skipped:/);
    expect(
      runOutcomeCode("skipped", { ...waiting, skippedInFlight: true })
    ).toBeNull();
    expect(runOutcomeReason("not_landed", waiting)).toMatch(/^Not landed:/);
    expect(runOutcomeCode("not_landed", waiting)).toBeNull();
  });

  it("gives a waiting run that ran other steps a reason that names the waiting step only", () => {
    const mixed = { ...NO_RUN_OUTCOME_SIGNALS, waiting: true, otherWork: true };
    expect(runOutcomeCode("skipped", mixed)).toBe("bundle-waiting-other-steps");
    const reason = runOutcomeReason("skipped", mixed);
    expect(reason).toBe(RUN_OUTCOME_REASON.waitingWithOtherSteps);
    expect(reason).not.toContain("no gas was paid");
    expect(reason).toContain("that step sent no transaction");
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

describe("waiting runs: skip reason, billing, metrics, node outcome", () => {
  it("keys a skipped run by its code first, then its exact reason (rows stored before the code)", () => {
    // The code wins over the text, so a reworded reason keeps its key.
    expect(
      skipReasonOf({
        status: "skipped",
        error: "Waiting: reworded later",
        errorCode: "bundle-waiting",
      })
    ).toBe(SKIP_REASON.bundleWaiting);
    expect(
      skipReasonOf({
        status: "skipped",
        error: RUN_OUTCOME_REASON.waiting,
        errorCode: "bundle-waiting-other-steps",
      })
    ).toBeNull();
    expect(
      skipReasonOf({ status: "skipped", error: RUN_OUTCOME_REASON.waiting })
    ).toBe(SKIP_REASON.bundleWaiting);
    expect(
      skipReasonOf({
        status: "skipped",
        error: RUN_OUTCOME_REASON.waiting,
        errorCode: "C-0001",
      })
    ).toBeNull();
    expect(
      skipReasonOf({ status: "skipped", error: RUN_OUTCOME_REASON.skipped })
    ).toBe(SKIP_REASON.bundleInFlight);
    expect(
      skipReasonOf({ status: "skipped", error: SKIPPED_WHILE_RUNNING_REASON })
    ).toBe(SKIP_REASON.whileRunning);
    expect(
      skipReasonOf({ status: "skipped", error: "Skipped while running" })
    ).toBeNull();
    expect(
      skipReasonOf({
        status: "success",
        error: RUN_OUTCOME_REASON.waiting,
        errorCode: "bundle-waiting",
      })
    ).toBeNull();
  });

  it("bills every run but a skip that only waited", () => {
    expect(isUnbilledOutcome("skipped", "bundle-waiting", "x")).toBe(true);
    expect(isUnbilledOutcome("skipped", null, RUN_OUTCOME_REASON.waiting)).toBe(
      true
    );
    expect(
      isUnbilledOutcome(
        "skipped",
        "bundle-waiting-other-steps",
        RUN_OUTCOME_REASON.waitingWithOtherSteps
      )
    ).toBe(false);
    expect(isUnbilledOutcome("skipped", null, RUN_OUTCOME_REASON.skipped)).toBe(
      false
    );
    expect(
      isUnbilledOutcome(
        "not_landed",
        "bundle-waiting",
        RUN_OUTCOME_REASON.waiting
      )
    ).toBe(false);
    expect(isUnbilledOutcome("success", null, null)).toBe(false);
  });

  it("labels the skipped metric by code or reason", () => {
    expect(skippedMetricReason("bundle-waiting", "x")).toBe("bundle_waiting");
    expect(
      skippedMetricReason(
        "bundle-waiting-other-steps",
        RUN_OUTCOME_REASON.waitingWithOtherSteps
      )
    ).toBe("bundle_waiting");
    expect(skippedMetricReason(null, RUN_OUTCOME_REASON.waiting)).toBe(
      "bundle_waiting"
    );
    expect(skippedMetricReason(null, RUN_OUTCOME_REASON.skipped)).toBe(
      "bundle_in_flight"
    );
  });

  it("sets billable false for a settle to a pure waiting run, back to true only from one", () => {
    const dialect = new PgDialect();
    expect(
      billableAfterSettle(workflowExecutions, {
        status: "skipped",
        errorCode: "bundle-waiting",
        error: RUN_OUTCOME_REASON.waiting,
      })
    ).toBe(false);
    const away = billableAfterSettle(workflowExecutions, {
      status: "success",
      errorCode: null,
      error: null,
    });
    expect(away).not.toBe(false);
    const text = dialect
      .sqlToQuery(away as Exclude<typeof away, false>)
      .sql.replace(/\s+/g, " ");
    expect(text).toContain(
      `CASE WHEN ("workflow_executions"."status" = 'skipped' AND ("workflow_executions"."error_code" = 'bundle-waiting'`
    );
    expect(text).toContain(
      `THEN true ELSE "workflow_executions"."billable" END`
    );
  });

  it("puts the other-work rule in SQL, never NULL, the generated read list as one bound text[] parameter", () => {
    const query = new PgDialect().sqlToQuery(
      otherWorkSql(workflowExecutionLogs)
    );
    const text = query.sql.replace(/\s+/g, " ");
    expect(text).toContain(
      `coalesce("workflow_execution_logs"."output_raw"->>'transactionHash', '') <> ''`
    );
    expect(text).toContain(
      `coalesce("workflow_execution_logs"."output_raw"->>'gasUsed', '') <> ''`
    );
    // The type is checked first, so most rows never read their output; the read list is not SQL text.
    expect(text).toMatch(
      /^\(CASE WHEN "workflow_execution_logs"\."node_type" <> ALL\(\$1::text\[\]\) THEN true/
    );
    // The constant bundle types are literals, as in the sibling signal SQL.
    expect(text).toContain(
      `"workflow_execution_logs"."node_type" IN ('web3/write-contract', 'Write Contract')`
    );
    expect(text).not.toContain("web3/read-contract");
    expect(query.params).toHaveLength(1);
    const [quiet] = query.params as string[][];
    expect(quiet).toEqual(
      expect.arrayContaining([
        "web3/write-contract",
        "Write Contract",
        "trigger",
        "web3/read-contract",
        "aave-v3/get-user-account-data",
      ])
    );
    expect(quiet).not.toContain("aave-v3/supply");
    expect(quiet).not.toContain("web3/query-events");
    expect(quiet).not.toContain("For Each");
  });

  it("gives a waiting Write Contract step the node outcome waiting", () => {
    const step = (output: unknown, status = "success", nodeType = WRITE) => ({
      nodeId: "w",
      nodeType,
      status,
      output,
    });
    expect(nodeOutcomeOf(step({ route: "waiting" }))).toBe("waiting");
    expect(nodeOutcomeOf(step({ route: "waiting" }, "error"))).toBeUndefined();
    expect(
      nodeOutcomeOf(step({ route: "waiting" }, "success", "http-request"))
    ).toBeUndefined();
    expect(nodeOutcomeOf(step({ route: "skipped-in-flight" }))).toBe(
      "skipped-in-flight"
    );
    expect(nodeOutcomeOf(step({ route: "bundle", included: true }))).toBe(
      undefined
    );
  });
});
