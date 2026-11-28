import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { workflowExecutionLogs } from "@/lib/db/schema";
import {
  NO_RUN_OUTCOME_SIGNALS,
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
  FALLBACK_NOT_SENT_REASONS,
  FALLBACK_NOT_SENT_TEXT,
  fallbackNotSentText,
  isBundleRoute,
  NEVER_MINED_RUN_ERROR,
  NOT_INCLUDED_REASON_TEXT,
  nodeOutcomeOf,
  PUBLIC_COPY_DROPPED_REASON,
  PUBLIC_COPY_ERRORS,
  PUBLIC_COPY_EXPIRED_TEXT,
  publicCopyNotLandedReason,
  publicPendingSentence,
  RUN_OUTCOME_REASON,
  SKIP_REASON,
  SKIPPED_WHILE_RUNNING_REASON,
  STEP_OUTCOME_TEXT,
  settledPendingReason,
  skippedBehindPublicCopy,
  skippedMetricReason,
  skippedStepSentence,
  skippedStepTitle,
  skipReasonOf,
  stepOutcomeOf,
  unconfirmedRunNote,
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
    });
  });

  it.each(["http-request", "code/run-code", "web3/read-contract", "Condition"])(
    "ignores the bundle keys on a %s step",
    (nodeType) => {
      expect(
        signalsOfStep(nodeType, {
          route: "skipped-in-flight",
          notIncludedReason: "not-picked",
        })
      ).toEqual(NO_RUN_OUTCOME_SIGNALS);
    }
  );

  it("marks a sent bundle and a waiting bundle step", () => {
    expect(signalsOfStep(WRITE, { route: "bundle", included: true })).toEqual({
      ...NO_RUN_OUTCOME_SIGNALS,
      bundleSent: true,
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
    expect(signalsOfStep(WRITE, { route }).bundleSent).toBe(false);
  });
});

describe("Bundle and public outputs", () => {
  it("lists bundle-and-public as a sent bundle route", () => {
    expect([...BUNDLE_ROUTES]).toEqual(["bundle", "bundle-and-public"]);
  });

  it("a public copy not mined yet is sent, not Not included, and keeps its charge", () => {
    const output = {
      success: true,
      route: "bundle-and-public",
      included: false,
      pending: true,
      transactionHash: "0xab",
    };
    expect(signalsOfStep(WRITE, output)).toMatchObject({
      bundleSent: true,
      notIncluded: false,
    });
    const step = { nodeId: "n", nodeType: WRITE, status: "success", output };
    // Shown Pending (neutral) while the run is unconfirmed, never Completed.
    expect(nodeOutcomeOf(step)).toBe("public-pending");
    expect(nodeOutcomeOf(step, { status: "unconfirmed" })).toBe(
      "public-pending"
    );
    expect(bundleReservationEnd(output)).toBe("settle");
  });

  describe("a public copy not mined when its step ended, once the run settles", () => {
    const output = {
      success: true,
      route: "bundle",
      included: false,
      pending: true,
      transactionHash: "0xab",
    };
    const step = { nodeId: "n", nodeType: WRITE, status: "success", output };
    const hashEntry = (receiptStatus: string) => ({
      nodeId: "n",
      receiptStatus,
    });

    it("mined later: landed late (the reconciler's Success)", () => {
      expect(
        stepOutcomeOf(step, {
          status: "success",
          transactionHashes: [hashEntry("success")],
        })
      ).toBe("landed-late");
    });

    it("mined later and reverted: reverted late, gas paid", () => {
      expect(
        stepOutcomeOf(step, {
          status: "error",
          transactionHashes: [hashEntry("reverted")],
        })
      ).toBe("landed-late-reverted");
      expect(STEP_OUTCOME_TEXT["landed-late-reverted"].sentence).toContain(
        "paid gas"
      );
    });

    it("its own unread hash is not a landing: still pending while unconfirmed", () => {
      expect(
        stepOutcomeOf(step, {
          status: "unconfirmed",
          transactionHashes: [hashEntry("not_found")],
        })
      ).toBe("public-pending");
    });

    it("dropped or never found: not included", () => {
      expect(stepOutcomeOf(step, { status: "not_landed" })).toBe(
        "not-included"
      );
      expect(
        stepOutcomeOf(step, {
          status: "error",
          transactionHashes: [hashEntry("not_found")],
        })
      ).toBe("not-included");
    });

    it("needs a bundle route and a JSON true", () => {
      expect(
        stepOutcomeOf({ ...step, output: { ...output, pending: "true" } })
      ).toBeUndefined();
      expect(
        stepOutcomeOf({ ...step, output: { ...output, route: "public" } })
      ).toBeUndefined();
    });

    it("the Unconfirmed sentence says it is sent publicly, settles later, and is paid for once mined", () => {
      expect(STEP_OUTCOME_TEXT["public-pending"]).toEqual({
        label: "Unconfirmed",
        sentence:
          "this step's transaction was sent publicly and is not mined yet; KeeperHub settles the run once it is mined or dropped. If it is mined, the wallet pays its gas, even if it reverts.",
      });
    });
  });

  it("a paid revert releases; a refused fallback holds", () => {
    expect(
      bundleReservationEnd({
        success: false,
        route: "bundle-and-public",
        included: true,
        broadcastAttempted: true,
      })
    ).toBe("release");
    expect(
      bundleReservationEnd({
        success: false,
        route: "bundle",
        included: false,
        broadcastAttempted: true,
      })
    ).toBe("hold");
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

describe("waiting runs: skip reason, metrics, node outcome", () => {
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

  it("labels the skipped metric by code or reason", () => {
    expect(skippedMetricReason("bundle-waiting", "x")).toBe("bundle_waiting");
    expect(skippedMetricReason(null, RUN_OUTCOME_REASON.waiting)).toBe(
      "bundle_waiting"
    );
    expect(skippedMetricReason(null, RUN_OUTCOME_REASON.skipped)).toBe(
      "bundle_in_flight"
    );
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

describe("review round 1 texts", () => {
  it("has a plain sentence for every fallbackNotSentReason; check-failed never says the call would work", () => {
    for (const reason of FALLBACK_NOT_SENT_REASONS) {
      expect(FALLBACK_NOT_SENT_TEXT[reason]).toMatch(
        /^The public fallback was not sent: /
      );
    }
    expect(fallbackNotSentText({ fallbackNotSentReason: "check-failed" })).toBe(
      "The public fallback was not sent: the call could not be checked."
    );
    expect(fallbackNotSentText({ fallbackNotSentReason: "toString" })).toBe(
      undefined
    );
    expect(fallbackNotSentText({})).toBeUndefined();
  });

  it("says a dropped public copy's nonce is used again", () => {
    expect(NOT_INCLUDED_REASON_TEXT["public-copy-dropped"]).toBe(
      "Its public copy was not found on any RPC for three checks, so KeeperHub treats it as dropped; nothing was mined and the nonce is used again. Most often its fee cap was below the base fee, or an RPC rejected it (for example for too little balance): raise Max Fee or leave it empty, and check the wallet's balance."
    );
  });

  it("names the public copy a skipped step waited behind", () => {
    expect(skippedStepSentence({ inFlightHash: "0xab" })).toBe(
      "an earlier run's public copy (0xab) is not mined yet, so this step sent nothing; no gas was paid. KeeperHub checks it every few minutes and stops waiting after a day."
    );
    expect(skippedStepSentence({ inFlightUntilBlock: 5 })).toBe(
      STEP_OUTCOME_TEXT["skipped-in-flight"].sentence
    );
  });
});

describe("review round 2 texts and outcomes", () => {
  const COPY = `0x${"ab".repeat(32)}`;
  const behind = {
    success: true,
    route: "skipped-in-flight",
    included: false,
    inFlightHash: COPY,
  };

  it("a skip behind a public copy carries its own reason, grouped and billed as a bundle skip", () => {
    const signals = signalsOfStep(WRITE, behind);
    expect(signals).toMatchObject({
      skippedInFlight: true,
      skippedPublicCopy: true,
    });
    expect(runOutcomeOf(signals)).toBe("skipped");
    expect(runOutcomeReason("skipped", signals)).toBe(
      RUN_OUTCOME_REASON.skippedPublicCopy
    );
    expect(RUN_OUTCOME_REASON.skippedPublicCopy).toBe(
      "Skipped: an earlier run's public copy is not mined yet, so the bundle step sent no transaction."
    );
    expect(runOutcomeCode("skipped", signals)).toBeNull();
    expect(
      skipReasonOf({
        status: "skipped",
        error: RUN_OUTCOME_REASON.skippedPublicCopy,
      })
    ).toBe(SKIP_REASON.bundleInFlight);
    expect(
      skippedMetricReason(null, RUN_OUTCOME_REASON.skippedPublicCopy)
    ).toBe("bundle_in_flight");
  });

  it("a skip behind a bundle keeps the bundle reason; the flag is only set when true", () => {
    const signals = signalsOfStep(WRITE, {
      route: "skipped-in-flight",
      inFlightUntilBlock: 9,
    });
    expect(signals).not.toHaveProperty("skippedPublicCopy");
    expect(runOutcomeReason("skipped", signals)).toBe(
      RUN_OUTCOME_REASON.skipped
    );
    // A non-string hash is not a public copy.
    expect(
      signalsOfStep(WRITE, { route: "skipped-in-flight", inFlightHash: 5 })
    ).not.toHaveProperty("skippedPublicCopy");
    // Only Write Contract carries it.
    expect(signalsOfStep("HTTP Request", behind)).not.toHaveProperty(
      "skippedPublicCopy"
    );
  });

  it("the SQL signal reads the same keys as the TS one", () => {
    const rendered = new PgDialect().sqlToQuery(
      runOutcomeSignalSql({
        nodeType: workflowExecutionLogs.nodeType,
        outputRaw: workflowExecutionLogs.outputRaw,
      }).skippedPublicCopy
    ).sql;
    expect(rendered).toContain("'skipped-in-flight'");
    expect(rendered).toContain("jsonb_typeof(");
    expect(rendered).toContain("->'inFlightHash') = 'string', false)");
  });

  it("says when no RPC confirmed taking a pending copy, in the step sentence and the run note", () => {
    const sure = {
      pending: true,
      transactionHash: COPY,
      publicCopy: { hash: COPY, accepted: true },
    };
    const unclear = { ...sure, publicCopy: { hash: COPY, accepted: null } };
    expect(publicPendingSentence(sure)).toBe(
      STEP_OUTCOME_TEXT["public-pending"].sentence
    );
    expect(publicPendingSentence(unclear)).toBe(
      "this step's transaction was sent publicly (no RPC confirmed taking it) and is not mined yet; KeeperHub settles the run once it is mined or dropped. If it is mined, the wallet pays its gas, even if it reverts."
    );
    expect(unconfirmedRunNote([{ triggered: true }, sure])).toBe(
      `A transaction (${COPY}) was sent and is not mined yet; KeeperHub settles the run once it is mined or dropped. If it is mined, the wallet pays its gas, even if it reverts.`
    );
    expect(unconfirmedRunNote([unclear])).toContain(
      `A transaction (${COPY}) was sent (no RPC confirmed taking it) and`
    );
    expect(unconfirmedRunNote([{ success: true }])).toBe(
      "A transaction was sent and is not mined yet; KeeperHub settles the run once it is mined or dropped. If it is mined, the wallet pays its gas, even if it reverts."
    );
  });

  it("names the skipped step's copy in its tooltip and finds the step that skipped behind one", () => {
    expect(skippedStepTitle(behind)).toBe(
      `Skipped: ${skippedStepSentence(behind)}`
    );
    expect(skippedStepTitle(undefined)).toBe(
      `Skipped: ${STEP_OUTCOME_TEXT["skipped-in-flight"].sentence}`
    );
    expect(
      skippedBehindPublicCopy([
        { route: "skipped-in-flight", inFlightUntilBlock: 4 },
        behind,
      ])
    ).toBe(behind);
    expect(
      skippedBehindPublicCopy([{ route: "bundle", inFlightHash: COPY }])
    ).toBeUndefined();
  });

  it("says why a pending step's run settled without it", () => {
    const pending = { pending: true, transactionHash: COPY };
    expect(
      settledPendingReason(pending, {
        status: "not_landed",
        error: PUBLIC_COPY_DROPPED_REASON,
      })
    ).toBe(NOT_INCLUDED_REASON_TEXT["public-copy-dropped"]);
    expect(
      settledPendingReason(pending, {
        status: "not_landed",
        error: publicCopyNotLandedReason("public-copy-replaced"),
      })
    ).toBe(
      "Another transaction from the wallet used its nonce first, so its public copy can no longer be mined; no gas was paid for it."
    );
    expect(
      settledPendingReason(pending, {
        status: "error",
        error: `${NEVER_MINED_RUN_ERROR}; treating them as dropped after 24h`,
      })
    ).toBe(PUBLIC_COPY_EXPIRED_TEXT);
    expect(PUBLIC_COPY_EXPIRED_TEXT).toBe(
      "Its public copy was not mined within a day; it stays valid until the wallet's next transaction, and KeeperHub no longer watches it."
    );
    // Another error, or a step that was not pending, adds nothing.
    expect(
      settledPendingReason(pending, { status: "error", error: "boom" })
    ).toBeUndefined();
    expect(
      settledPendingReason(
        { notIncludedReason: "not-picked" },
        { status: "not_landed", error: PUBLIC_COPY_DROPPED_REASON }
      )
    ).toBeUndefined();
  });

  it("refused and nonce-used say what happened", () => {
    expect(PUBLIC_COPY_ERRORS.refused).toBe(
      "no public RPC could be reached or every RPC rejected it"
    );
    expect(PUBLIC_COPY_ERRORS.nonceUsed).toBe(
      "another transaction holds this nonce"
    );
    expect(FALLBACK_NOT_SENT_TEXT["nonce-used"]).toBe(
      "The public fallback was not sent: another transaction holds this nonce."
    );
    expect(FALLBACK_NOT_SENT_TEXT.refused).toContain(
      "every RPC rejected it (for example for too little balance)"
    );
    expect(FALLBACK_NOT_SENT_TEXT["no-public-rpc"]).toBe(
      "The public fallback was not sent: the network's RPC for this step is a private relay, so there is nowhere public to send it."
    );
  });
});
