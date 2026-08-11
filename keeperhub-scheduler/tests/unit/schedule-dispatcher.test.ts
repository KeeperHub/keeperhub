import {
  SendMessageCommand,
  type SendMessageCommandOutput,
} from "@aws-sdk/client-sqs";
import { CronExpressionParser } from "cron-parser";
import {
  type MockInstance,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Mock the sqs-client module so importing dispatch.ts does not instantiate
// a real SQS client. The mock object's `send` is replaced per-test via
// vi.mocked(sqs.send) so each test can choose its own behavior.
vi.mock("../../lib/sqs-client.js", () => ({
  sqs: {
    send: vi.fn(),
  },
}));

// KEEP-693: stub the phantom helpers so dispatch tests assert the wiring (id
// carried on the message, failure marked) without real internal-API calls.
const { createPhantomExecution, failPhantomExecution } = vi.hoisted(() => ({
  createPhantomExecution: vi.fn(),
  failPhantomExecution: vi.fn(),
}));
vi.mock("../../lib/phantom.js", () => ({
  createPhantomExecution,
  failPhantomExecution,
}));

import { sqs } from "../../lib/sqs-client.js";
import {
  cronOccurrencesBetween,
  dispatch,
  fetchSchedules,
  intervalOccurrencesBetween,
  sendToQueue,
  shouldTriggerInterval,
  shouldTriggerNow,
} from "../../schedule-dispatcher/dispatch.js";

const mockedSqsSend = vi.mocked(sqs.send);

// `sqs.send` is overloaded per-command and infers a wide return union;
// concrete output for SendMessageCommand is the only one the dispatcher
// uses, so type the mock resolution to that rather than `as never`.
const sqsOkResponse = {} as SendMessageCommandOutput;

// Silence the dispatcher's console output -- every dispatch run logs
// half a dozen lines per schedule. Restore in afterEach so test failures
// keep their stack traces visible.
let consoleLogSpy: MockInstance;
let consoleErrorSpy: MockInstance;

beforeEach(() => {
  consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {
    /* swallow */
  });
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {
    /* swallow */
  });
  mockedSqsSend.mockReset();
});

afterEach(() => {
  consoleLogSpy.mockRestore();
  consoleErrorSpy.mockRestore();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("shouldTriggerNow", () => {
  it("returns true when prev() is within the current minute", () => {
    // 9:00:01 UTC -- prev() of "0 9 * * *" returns 9:00:00, diff=1s.
    const now = new Date("2024-01-15T09:00:01Z");
    expect(shouldTriggerNow("0 9 * * *", "UTC", now)).toBe(true);
  });

  it("returns true at 30 seconds into the matching minute", () => {
    const now = new Date("2024-01-15T09:00:30Z");
    expect(shouldTriggerNow("0 9 * * *", "UTC", now)).toBe(true);
  });

  it("triggers at the exact occurrence boundary (now == cron firing time)", () => {
    // Regression: cron-parser's prev() is strict, so without an epsilon
    // on currentDate a tick landing at exactly 09:00:00.000 with cron
    // "0 9 * * *" returns yesterday's 9am and the schedule is skipped.
    const now = new Date("2024-01-15T09:00:00.000Z");
    expect(shouldTriggerNow("0 9 * * *", "UTC", now)).toBe(true);
  });

  it("triggers at the exact minute boundary for an every-minute cron", () => {
    // Same boundary case as above but for "* * * * *" -- the dispatcher's
    // 60s setInterval can land on minute boundaries depending on startup
    // alignment. Without the epsilon, every such tick was missed.
    const now = new Date("2024-01-15T09:01:00.000Z");
    expect(shouldTriggerNow("* * * * *", "UTC", now)).toBe(true);
  });

  it("returns false at 60 seconds (window is exclusive)", () => {
    // At 9:01:00, diff from 9:00:00 is exactly 60_000ms -- not < 60_000.
    const now = new Date("2024-01-15T09:01:00Z");
    expect(shouldTriggerNow("0 9 * * *", "UTC", now)).toBe(false);
  });

  it("returns false outside the matching minute", () => {
    const now = new Date("2024-01-15T08:30:00Z");
    expect(shouldTriggerNow("0 9 * * *", "UTC", now)).toBe(false);
  });

  it("matches at every minute for '* * * * *'", () => {
    const at = (s: string): Date => new Date(s);
    expect(
      shouldTriggerNow("* * * * *", "UTC", at("2024-01-15T14:37:01Z")),
    ).toBe(true);
    expect(
      shouldTriggerNow("* * * * *", "UTC", at("2024-01-15T03:00:30Z")),
    ).toBe(true);
  });

  it("matches an hourly cron at the top of the hour", () => {
    expect(
      shouldTriggerNow("0 * * * *", "UTC", new Date("2024-01-15T14:00:01Z")),
    ).toBe(true);
    expect(
      shouldTriggerNow("0 * * * *", "UTC", new Date("2024-01-15T14:30:00Z")),
    ).toBe(false);
  });

  it("respects the timezone parameter (NY 9am = 14:00 UTC in January)", () => {
    // EST is UTC-5 in January, so 9 AM NY == 14:00 UTC.
    expect(
      shouldTriggerNow(
        "0 9 * * *",
        "America/New_York",
        new Date("2024-01-15T14:00:01Z"),
      ),
    ).toBe(true);
    // 9 AM UTC is not 9 AM NY -- should not trigger.
    expect(
      shouldTriggerNow(
        "0 9 * * *",
        "America/New_York",
        new Date("2024-01-15T09:00:00Z"),
      ),
    ).toBe(false);
  });

  it("returns false and logs on an invalid cron expression", () => {
    const now = new Date("2024-01-15T09:00:00Z");
    expect(shouldTriggerNow("not a cron", "UTC", now)).toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid cron expression: not a cron"),
      expect.anything(),
    );
  });

  it("returns false and logs when interval.prev() throws at runtime", () => {
    // cron-parser can throw on prev() for expressions that parse but have
    // no past occurrence in the supported range. Mock the parser to force
    // that branch so the test does not depend on which exact expressions
    // trigger that condition in the current cron-parser version.
    vi.spyOn(CronExpressionParser, "parse").mockReturnValueOnce({
      prev: () => {
        throw new Error("Out of the timespan range");
      },
    } as never);

    const now = new Date("2024-01-15T09:00:00Z");
    expect(shouldTriggerNow("0 9 * * *", "UTC", now)).toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid cron expression: 0 9 * * *"),
      expect.anything(),
    );
  });

  it("respects day-of-week constraints", () => {
    // 2024-01-15 is a Monday at 9:00:01.
    const monday = new Date("2024-01-15T09:00:01Z");
    expect(shouldTriggerNow("0 9 * * 1", "UTC", monday)).toBe(true);
    // Tuesday-only cron should not match on Monday.
    expect(shouldTriggerNow("0 9 * * 2", "UTC", monday)).toBe(false);
  });

  it("respects step values", () => {
    // Every 15 minutes -- triggers at :00, :15, :30, :45 (+1s).
    expect(
      shouldTriggerNow("*/15 * * * *", "UTC", new Date("2024-01-15T09:00:01Z")),
    ).toBe(true);
    expect(
      shouldTriggerNow("*/15 * * * *", "UTC", new Date("2024-01-15T09:15:01Z")),
    ).toBe(true);
    // :10 is mid-window -- prev() returns :00, diff is ~10min -> false.
    expect(
      shouldTriggerNow("*/15 * * * *", "UTC", new Date("2024-01-15T09:10:01Z")),
    ).toBe(false);
  });
});

// KEEP-575: interval mode lets us express "every N minutes" accurately
// even when N doesn't divide 60. `*/55 * * * *` only fires at :00 and :55
// of each hour (55-min then 5-min gap); the interval path fires every
// 55 minutes from the anchor regardless of clock alignment.
describe("shouldTriggerInterval", () => {
  it("does NOT fire at the anchor itself (first fire is anchor + interval)", () => {
    const anchor = new Date("2026-05-18T10:00:00Z");
    expect(shouldTriggerInterval(3300, anchor, anchor)).toBe(false);
  });

  it("does NOT fire within the 60s window after the anchor", () => {
    // KEEP-575: saving a schedule must not cause an immediate run. The
    // first fire is `anchor + 1 * interval`, not the anchor itself.
    const anchor = new Date("2026-05-18T10:00:00Z");
    expect(
      shouldTriggerInterval(3300, anchor, new Date("2026-05-18T10:00:30Z")),
    ).toBe(false);
  });

  it("does not fire mid-interval", () => {
    const anchor = new Date("2026-05-18T10:00:00Z");
    // 30 minutes in -- nowhere near a 55-minute boundary.
    expect(
      shouldTriggerInterval(3300, anchor, new Date("2026-05-18T10:30:00Z")),
    ).toBe(false);
  });

  it("fires at the first occurrence: anchor + 1 * interval (55 min later)", () => {
    const anchor = new Date("2026-05-18T10:00:00Z");
    expect(
      shouldTriggerInterval(3300, anchor, new Date("2026-05-18T10:55:00Z")),
    ).toBe(true);
  });

  it("fires within the 60s window of anchor + 1 * interval", () => {
    const anchor = new Date("2026-05-18T10:00:00Z");
    expect(
      shouldTriggerInterval(3300, anchor, new Date("2026-05-18T10:55:30Z")),
    ).toBe(true);
  });

  it("fires at anchor + 2 * interval (110 min later)", () => {
    const anchor = new Date("2026-05-18T10:00:00Z");
    // 110 min from 10:00 is 11:50 -- which `*/55` would NOT hit.
    expect(
      shouldTriggerInterval(3300, anchor, new Date("2026-05-18T11:50:00Z")),
    ).toBe(true);
  });

  it("does not fire 5 minutes after the anchor (anti-cron regression)", () => {
    const anchor = new Date("2026-05-18T10:00:00Z");
    // This is the exact regression we're fixing: `*/55 * * * *` would
    // double-fire here because it also matches the next hour's :05 etc.
    // Interval mode must not.
    expect(
      shouldTriggerInterval(3300, anchor, new Date("2026-05-18T10:05:00Z")),
    ).toBe(false);
  });

  it("does not fire 65 minutes after the anchor (anti-cron regression)", () => {
    const anchor = new Date("2026-05-18T10:00:00Z");
    // 65min mark = 11:05; `*/55` would match this and trigger a duplicate
    // fire 5min after the legitimate 11:00 cron tick. Interval mode aligns
    // to the anchor, not the wall clock.
    expect(
      shouldTriggerInterval(3300, anchor, new Date("2026-05-18T11:05:00Z")),
    ).toBe(false);
  });

  it("does not fire before the anchor", () => {
    const anchor = new Date("2026-05-18T10:00:00Z");
    expect(
      shouldTriggerInterval(3300, anchor, new Date("2026-05-18T09:30:00Z")),
    ).toBe(false);
  });

  it("returns false for non-positive interval", () => {
    const anchor = new Date("2026-05-18T10:00:00Z");
    expect(shouldTriggerInterval(0, anchor, anchor)).toBe(false);
    expect(shouldTriggerInterval(-10, anchor, anchor)).toBe(false);
  });

  it("returns false for non-finite interval", () => {
    const anchor = new Date("2026-05-18T10:00:00Z");
    expect(shouldTriggerInterval(Number.NaN, anchor, anchor)).toBe(false);
    expect(
      shouldTriggerInterval(Number.POSITIVE_INFINITY, anchor, anchor),
    ).toBe(false);
  });

  it("returns false for an Invalid Date anchor (anchorAt.getTime() is NaN)", () => {
    // KEEP-575: the dispatcher constructs anchor via `new Date(schedule.anchorAt)`
    // where schedule.anchorAt is a string from the JSON API. A malformed
    // string yields Invalid Date; without the guard, every comparison below
    // is silently false and the schedule never fires.
    const badAnchor = new Date("not-a-real-date");
    expect(Number.isNaN(badAnchor.getTime())).toBe(true);
    expect(
      shouldTriggerInterval(3300, badAnchor, new Date("2026-05-18T11:00:00Z")),
    ).toBe(false);
  });
});

describe("fetchSchedules", () => {
  it("returns the schedules array on a 200 response", async () => {
    const schedules = [
      {
        id: "s1",
        workflowId: "w1",
        cronExpression: "* * * * *",
        timezone: "UTC",
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ schedules }),
      }),
    );

    await expect(fetchSchedules()).resolves.toEqual(schedules);
  });

  it("returns an empty array when the API returns no schedules", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ schedules: [] }),
      }),
    );

    await expect(fetchSchedules()).resolves.toEqual([]);
  });

  it("throws including the status and body on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: async () => "service unavailable",
      }),
    );

    await expect(fetchSchedules()).rejects.toThrow(
      /API GET \/api\/internal\/schedules failed: 503 service unavailable/,
    );
  });

  it("propagates fetch network errors to the caller", async () => {
    // fetch itself rejecting (DNS failure, TLS error, socket reset) is a
    // distinct branch from the non-2xx path -- no `response` object exists
    // to inspect, so the error reaches the caller unwrapped.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    );

    await expect(fetchSchedules()).rejects.toThrow("ECONNREFUSED");
  });

  it("calls fetch with the schedules path and HMAC headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ schedules: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await fetchSchedules();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/api\/internal\/schedules$/);
    expect(init.headers).toMatchObject({
      "X-KH-Caller": "scheduler",
      "X-KH-Timestamp": expect.stringMatching(/^\d+$/),
      "X-KH-Signature": expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });
});

describe("sendToQueue", () => {
  it("sends one SendMessageCommand with the correct body and attributes", async () => {
    mockedSqsSend.mockResolvedValue(sqsOkResponse);

    await sendToQueue({
      workflowId: "wf-1",
      scheduleId: "sched-1",
      triggerTime: "2024-01-15T09:00:00.000Z",
      triggerType: "schedule",
    });

    expect(mockedSqsSend).toHaveBeenCalledOnce();
    const command = mockedSqsSend.mock.calls[0][0];
    // instanceof check is the public API contract; .input is the documented
    // public field on AWS SDK v3 commands.
    expect(command).toBeInstanceOf(SendMessageCommand);
    const { input } = command as SendMessageCommand;
    expect(input.QueueUrl).toBeTruthy();
    expect(JSON.parse(input.MessageBody ?? "")).toEqual({
      workflowId: "wf-1",
      scheduleId: "sched-1",
      triggerTime: "2024-01-15T09:00:00.000Z",
      triggerType: "schedule",
    });
    expect(input.MessageAttributes?.TriggerType).toEqual({
      DataType: "String",
      StringValue: "schedule",
    });
    expect(input.MessageAttributes?.WorkflowId).toEqual({
      DataType: "String",
      StringValue: "wf-1",
    });
  });

  it("propagates errors from sqs.send", async () => {
    mockedSqsSend.mockRejectedValue(new Error("SQS unavailable"));

    await expect(
      sendToQueue({
        workflowId: "wf-1",
        scheduleId: "sched-1",
        triggerTime: "2024-01-15T09:00:00.000Z",
        triggerType: "schedule",
      }),
    ).rejects.toThrow("SQS unavailable");
  });
});

describe("dispatch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // 9:00:01 UTC -- inside the matching minute for "0 9 * * *".
    vi.setSystemTime(new Date("2024-01-15T09:00:01Z"));
    createPhantomExecution.mockReset();
    failPhantomExecution.mockReset();
    // Default: a fresh phantom row, no dedup hit. Tests that assert the id or
    // the dedup-skip path override this.
    createPhantomExecution.mockResolvedValue({ alreadyExisted: false });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function stubFetch(schedules: unknown[]): void {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ schedules }),
      }),
    );
  }

  it("returns zero counts when no schedules are returned", async () => {
    stubFetch([]);

    await expect(dispatch()).resolves.toEqual({
      evaluated: 0,
      triggered: 0,
      errors: 0,
    });
    expect(mockedSqsSend).not.toHaveBeenCalled();
  });

  it("triggers a matching schedule, counts it once, and logs the trigger", async () => {
    stubFetch([
      {
        id: "sched-1",
        workflowId: "wf-1",
        cronExpression: "0 9 * * *",
        timezone: "UTC",
      },
    ]);
    mockedSqsSend.mockResolvedValue(sqsOkResponse);

    const result = await dispatch();

    expect(result).toEqual({ evaluated: 1, triggered: 1, errors: 0 });
    expect(mockedSqsSend).toHaveBeenCalledOnce();
    // Logging is the primary operational signal for stuck workflows;
    // pin that the trigger line includes the workflow id and cron, so a
    // future "drop the logs" refactor surfaces as a test failure.
    const triggerLog = consoleLogSpy.mock.calls.find((call) =>
      String(call[0]).includes("Triggering workflow wf-1"),
    );
    expect(triggerLog).toBeDefined();
    expect(String(triggerLog?.[0])).toContain("0 9 * * *");
  });

  it("does not enqueue a schedule that is not due", async () => {
    stubFetch([
      {
        id: "sched-1",
        workflowId: "wf-1",
        cronExpression: "0 10 * * *",
        timezone: "UTC",
      },
    ]);

    const result = await dispatch();

    expect(result).toEqual({ evaluated: 1, triggered: 0, errors: 0 });
    expect(mockedSqsSend).not.toHaveBeenCalled();
  });

  it("counts SQS failures as errors but keeps processing", async () => {
    stubFetch([
      {
        id: "sched-1",
        workflowId: "wf-1",
        cronExpression: "0 9 * * *",
        timezone: "UTC",
      },
      {
        id: "sched-2",
        workflowId: "wf-2",
        cronExpression: "0 9 * * *",
        timezone: "UTC",
      },
    ]);
    mockedSqsSend
      .mockRejectedValueOnce(new Error("SQS down"))
      .mockResolvedValueOnce(sqsOkResponse);

    const result = await dispatch();

    expect(result).toEqual({ evaluated: 2, triggered: 1, errors: 1 });
    expect(mockedSqsSend).toHaveBeenCalledTimes(2);
  });

  it("counts every failure when SQS is down for the whole batch", async () => {
    // No successful triggers -- distinct from the partial-failure case
    // because triggered=0 means the result tuple is (evaluated, 0, N).
    stubFetch([
      {
        id: "s1",
        workflowId: "wf-1",
        cronExpression: "0 9 * * *",
        timezone: "UTC",
      },
      {
        id: "s2",
        workflowId: "wf-2",
        cronExpression: "0 9 * * *",
        timezone: "UTC",
      },
      {
        id: "s3",
        workflowId: "wf-3",
        cronExpression: "0 9 * * *",
        timezone: "UTC",
      },
    ]);
    mockedSqsSend.mockRejectedValue(new Error("SQS down for the whole batch"));

    const result = await dispatch();

    expect(result).toEqual({ evaluated: 3, triggered: 0, errors: 3 });
    expect(mockedSqsSend).toHaveBeenCalledTimes(3);
  });

  it("pins current behavior: malformed cron is silently skipped, not counted as an error", async () => {
    // shouldTriggerNow logs the parse failure and returns false; dispatch
    // sees that as "not due" and does not increment errors. This is the
    // current behavior -- pinned so a future change is a deliberate
    // decision, not an accident. Worth revisiting whether silent skip is
    // the desired prod behavior (a misconfigured workflow never fires
    // and only shows up in logs).
    stubFetch([
      {
        id: "sched-1",
        workflowId: "wf-1",
        cronExpression: "this is not cron",
        timezone: "UTC",
      },
    ]);

    const result = await dispatch();

    expect(result).toEqual({ evaluated: 1, triggered: 0, errors: 0 });
    expect(mockedSqsSend).not.toHaveBeenCalled();
  });

  it("processes a mixed batch (due, not-due, due-but-sqs-fails)", async () => {
    stubFetch([
      {
        id: "s-ok",
        workflowId: "wf-ok",
        cronExpression: "0 9 * * *",
        timezone: "UTC",
      },
      {
        id: "s-skip",
        workflowId: "wf-skip",
        cronExpression: "0 10 * * *",
        timezone: "UTC",
      },
      {
        id: "s-fail",
        workflowId: "wf-fail",
        cronExpression: "0 9 * * *",
        timezone: "UTC",
      },
    ]);
    mockedSqsSend
      .mockResolvedValueOnce(sqsOkResponse)
      .mockRejectedValueOnce(new Error("SQS down"));

    const result = await dispatch();

    expect(result).toEqual({ evaluated: 3, triggered: 1, errors: 1 });
    expect(mockedSqsSend).toHaveBeenCalledTimes(2);
  });

  it("captures `now` once per pass (clock advance mid-batch does not change evaluation)", async () => {
    // dispatch() does `const now = new Date()` once before the loop. If
    // a future refactor moves `new Date()` into the loop body, schedules
    // late in a slow batch could fall outside the trigger window. Pin the
    // current behavior: advance the wall clock by 2 minutes between
    // sends -- both schedules still trigger because they are evaluated
    // against the original `now` snapshot.
    stubFetch([
      {
        id: "s1",
        workflowId: "wf-1",
        cronExpression: "0 9 * * *",
        timezone: "UTC",
      },
      {
        id: "s2",
        workflowId: "wf-2",
        cronExpression: "0 9 * * *",
        timezone: "UTC",
      },
    ]);
    mockedSqsSend
      .mockImplementationOnce(async () => {
        // Jump past the matching minute. If `now` were re-read per
        // iteration, sched-2 would no longer be due.
        vi.setSystemTime(new Date("2024-01-15T09:02:30Z"));
        return sqsOkResponse;
      })
      .mockResolvedValueOnce(sqsOkResponse);

    const result = await dispatch();

    expect(result).toEqual({ evaluated: 2, triggered: 2, errors: 0 });
    expect(mockedSqsSend).toHaveBeenCalledTimes(2);
  });

  it("propagates fetchSchedules failures to the caller", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "boom",
      }),
    );

    await expect(dispatch()).rejects.toThrow(
      /API GET \/api\/internal\/schedules failed: 500/,
    );
    expect(mockedSqsSend).not.toHaveBeenCalled();
  });

  // KEEP-575: when intervalSeconds is set, the dispatcher must take the
  // interval path and ignore the (synthetic placeholder) cronExpression.
  it("fires an interval schedule via the interval path, ignoring its synthetic cron", () => {
    // Anchor is 10:00; with a 3300s (55min) interval, the next fire is
    // exactly at 10:55. Pin the clock there and confirm dispatch enqueues.
    vi.setSystemTime(new Date("2026-05-18T10:55:00Z"));

    stubFetch([
      {
        id: "s-interval",
        workflowId: "wf-interval",
        // Synthetic placeholder cron. If the dispatcher accidentally used
        // this it would NOT match the current time (`*/55` only fires at
        // :00 and :55) -- which happens to be 10:55, so this test is a
        // weak distinguisher. Use a cron that explicitly does NOT match
        // 10:55:00 so any regression toward the cron path would skip the
        // fire.
        cronExpression: "0 0 1 1 *",
        timezone: "UTC",
        intervalSeconds: 3300,
        anchorAt: "2026-05-18T10:00:00.000Z",
      },
    ]);
    mockedSqsSend.mockResolvedValue(sqsOkResponse);

    return dispatch().then((result) => {
      expect(result).toEqual({ evaluated: 1, triggered: 1, errors: 0 });
      expect(mockedSqsSend).toHaveBeenCalledOnce();
    });
  });

  // KEEP-575: the regression case. With the old cron-only dispatch path,
  // a `*/55` schedule fires at :05 in the next hour (because :05 ≡ 0 mod 5
  // never -- but :60 % 55 = 5, so cron-parser counts H+1:05 as a hit).
  // Interval mode must NOT fire there.
  it("does not fire an interval schedule 5 min into the next hour (no */N double-fire)", () => {
    vi.setSystemTime(new Date("2026-05-18T11:05:00Z"));

    stubFetch([
      {
        id: "s-interval",
        workflowId: "wf-interval",
        cronExpression: "*/55 * * * *",
        timezone: "UTC",
        intervalSeconds: 3300,
        anchorAt: "2026-05-18T10:00:00.000Z",
      },
    ]);
    mockedSqsSend.mockResolvedValue(sqsOkResponse);

    return dispatch().then((result) => {
      expect(result).toEqual({ evaluated: 1, triggered: 0, errors: 0 });
      expect(mockedSqsSend).not.toHaveBeenCalled();
    });
  });

  // KEEP-693: phantom pre-creation wiring.
  it("pre-creates a phantom row and carries its id on the message", async () => {
    createPhantomExecution.mockResolvedValue({
      executionId: "exec_ph",
      alreadyExisted: false,
    });
    stubFetch([
      {
        id: "sched-1",
        workflowId: "wf-1",
        cronExpression: "0 9 * * *",
        timezone: "UTC",
      },
    ]);
    mockedSqsSend.mockResolvedValue(sqsOkResponse);

    await dispatch();

    expect(createPhantomExecution).toHaveBeenCalledWith(
      "wf-1",
      "schedule",
      undefined,
      expect.stringMatching(/^schedule:sched-1:2024-01-15T09:00:00/),
    );
    const command = mockedSqsSend.mock.calls[0][0] as SendMessageCommand;
    expect(JSON.parse(command.input.MessageBody ?? "")).toMatchObject({
      executionId: "exec_ph",
    });
  });

  // An overlapping leader / catch-up window that recomputes the same occurrence
  // gets alreadyExisted and must not enqueue a second message.
  it("skips the enqueue when the dispatch key already exists (dedup)", async () => {
    createPhantomExecution.mockResolvedValue({
      executionId: "exec_existing",
      alreadyExisted: true,
    });
    stubFetch([
      {
        id: "sched-1",
        workflowId: "wf-1",
        cronExpression: "0 9 * * *",
        timezone: "UTC",
      },
    ]);
    mockedSqsSend.mockResolvedValue(sqsOkResponse);

    const result = await dispatch();

    expect(result).toEqual({ evaluated: 1, triggered: 0, errors: 0 });
    expect(mockedSqsSend).not.toHaveBeenCalled();
    expect(failPhantomExecution).not.toHaveBeenCalled();
  });

  it("marks the phantom failed with CS-0001 when the enqueue fails", async () => {
    createPhantomExecution.mockResolvedValue({
      executionId: "exec_ph",
      alreadyExisted: false,
    });
    stubFetch([
      {
        id: "sched-1",
        workflowId: "wf-1",
        cronExpression: "0 9 * * *",
        timezone: "UTC",
      },
    ]);
    mockedSqsSend.mockRejectedValue(new Error("SQS down"));

    const result = await dispatch();

    expect(result).toEqual({ evaluated: 1, triggered: 0, errors: 1 });
    expect(failPhantomExecution).toHaveBeenCalledWith(
      "exec_ph",
      "CS-0001",
      expect.stringContaining("SQS down"),
    );
  });

  it("still enqueues (id-less) when phantom creation fails", async () => {
    createPhantomExecution.mockResolvedValue({ alreadyExisted: false });
    stubFetch([
      {
        id: "sched-1",
        workflowId: "wf-1",
        cronExpression: "0 9 * * *",
        timezone: "UTC",
      },
    ]);
    mockedSqsSend.mockResolvedValue(sqsOkResponse);

    const result = await dispatch();

    expect(result).toEqual({ evaluated: 1, triggered: 1, errors: 0 });
    const command = mockedSqsSend.mock.calls[0][0] as SendMessageCommand;
    expect(JSON.parse(command.input.MessageBody ?? "")).not.toHaveProperty(
      "executionId",
    );
    expect(failPhantomExecution).not.toHaveBeenCalled();
  });

  it("catch-up: fires multiple occurrences when lastTickAt is provided and window spans multiple cron hits", async () => {
    // Two hourly occurrences at 09:00 and 10:00 land in (08:30, 10:01].
    vi.setSystemTime(new Date("2024-01-15T10:00:01Z"));
    stubFetch([
      {
        id: "sched-1",
        workflowId: "wf-1",
        cronExpression: "0 * * * *",
        timezone: "UTC",
      },
    ]);
    mockedSqsSend.mockResolvedValue(sqsOkResponse);

    const lastTickAt = new Date("2024-01-15T08:30:00Z");
    const result = await dispatch(lastTickAt);

    // window (08:30, 10:00:01] contains 09:00:00 and 10:00:00
    expect(result).toEqual({ evaluated: 1, triggered: 2, errors: 0 });
    expect(mockedSqsSend).toHaveBeenCalledTimes(2);
    const bodies = mockedSqsSend.mock.calls.map((c) =>
      JSON.parse((c[0] as SendMessageCommand).input.MessageBody ?? ""),
    );
    expect(bodies[0].triggerTime).toBe("2024-01-15T09:00:00.000Z");
    expect(bodies[1].triggerTime).toBe("2024-01-15T10:00:00.000Z");
  });

  it("triggerTime is the occurrence timestamp, not now", async () => {
    // now = 09:00:30, occurrence = 09:00:00 — these differ by 30s.
    vi.setSystemTime(new Date("2024-01-15T09:00:30Z"));
    stubFetch([
      {
        id: "sched-1",
        workflowId: "wf-1",
        cronExpression: "0 9 * * *",
        timezone: "UTC",
      },
    ]);
    mockedSqsSend.mockResolvedValue(sqsOkResponse);

    await dispatch();

    const body = JSON.parse(
      (mockedSqsSend.mock.calls[0][0] as SendMessageCommand).input
        .MessageBody ?? "",
    );
    expect(body.triggerTime).toBe("2024-01-15T09:00:00.000Z");
  });
});

describe("cronOccurrencesBetween", () => {
  it("returns the occurrence when it falls at the exact upper bound (to)", () => {
    const from = new Date("2024-01-15T08:59:00Z");
    const to = new Date("2024-01-15T09:00:00Z");
    const result = cronOccurrencesBetween("0 9 * * *", "UTC", from, to);
    expect(result).toHaveLength(1);
    expect(result[0].toISOString()).toBe("2024-01-15T09:00:00.000Z");
  });

  it("excludes occurrences at or before the lower bound (from)", () => {
    // from = 09:00:00 exactly; the 09:00:00 occurrence must not be returned
    // because the window is (from, to], not [from, to].
    const from = new Date("2024-01-15T09:00:00Z");
    const to = new Date("2024-01-15T09:00:30Z");
    const result = cronOccurrencesBetween("0 9 * * *", "UTC", from, to);
    expect(result).toHaveLength(0);
  });

  it("returns multiple occurrences across a wide window", () => {
    const from = new Date("2024-01-15T00:00:00Z");
    const to = new Date("2024-01-15T03:00:00Z");
    // every hour: 01:00, 02:00, 03:00
    const result = cronOccurrencesBetween("0 * * * *", "UTC", from, to);
    expect(result).toHaveLength(3);
    expect(result.map((d) => d.toISOString())).toEqual([
      "2024-01-15T01:00:00.000Z",
      "2024-01-15T02:00:00.000Z",
      "2024-01-15T03:00:00.000Z",
    ]);
  });

  it("returns empty array when no occurrence falls in the window", () => {
    const from = new Date("2024-01-15T09:01:00Z");
    const to = new Date("2024-01-15T09:59:00Z");
    const result = cronOccurrencesBetween("0 9 * * *", "UTC", from, to);
    expect(result).toHaveLength(0);
  });

  it("returns empty array and logs on an invalid cron expression", () => {
    const from = new Date("2024-01-15T08:59:00Z");
    const to = new Date("2024-01-15T09:01:00Z");
    const result = cronOccurrencesBetween("not-a-cron", "UTC", from, to);
    expect(result).toHaveLength(0);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid cron expression: not-a-cron"),
      expect.anything(),
    );
  });

  it("respects timezone: NY 9am occurrence inside UTC window", () => {
    // 2024-01-15 09:00 EST = 14:00 UTC (January = EST = UTC-5)
    const from = new Date("2024-01-15T13:59:00Z");
    const to = new Date("2024-01-15T14:01:00Z");
    const result = cronOccurrencesBetween(
      "0 9 * * *",
      "America/New_York",
      from,
      to,
    );
    expect(result).toHaveLength(1);
    expect(result[0].toISOString()).toBe("2024-01-15T14:00:00.000Z");
  });

  it("returns empty array when from >= to", () => {
    const t = new Date("2024-01-15T09:00:00Z");
    expect(cronOccurrencesBetween("* * * * *", "UTC", t, t)).toHaveLength(0);
  });
});

describe("intervalOccurrencesBetween", () => {
  const anchor = new Date("2026-05-18T10:00:00Z"); // k=0; k=1 fires at 10:55

  it("returns the first occurrence (k=1) when it falls in the window", () => {
    const from = new Date("2026-05-18T10:54:00Z");
    const to = new Date("2026-05-18T10:55:00Z");
    const result = intervalOccurrencesBetween(3300, anchor, from, to);
    expect(result).toHaveLength(1);
    expect(result[0].toISOString()).toBe("2026-05-18T10:55:00.000Z");
  });

  it("excludes occurrence at the exact lower bound (from is exclusive)", () => {
    const from = new Date("2026-05-18T10:55:00Z"); // exactly k=1
    const to = new Date("2026-05-18T11:00:00Z");
    const result = intervalOccurrencesBetween(3300, anchor, from, to);
    // k=1 is at 10:55 == from, so excluded. k=2 is at 11:50 > to.
    expect(result).toHaveLength(0);
  });

  it("does not fire before k=1 (the anchor itself is not an occurrence)", () => {
    const from = new Date("2026-05-18T09:59:00Z");
    const to = new Date("2026-05-18T10:00:30Z"); // anchor at 10:00 is within this
    const result = intervalOccurrencesBetween(3300, anchor, from, to);
    expect(result).toHaveLength(0);
  });

  it("returns multiple occurrences across a wide window", () => {
    const from = new Date("2026-05-18T10:00:00Z"); // anchor excluded
    const to = new Date("2026-05-18T12:05:00Z"); // covers k=1 (10:55) and k=2 (11:50)
    const result = intervalOccurrencesBetween(3300, anchor, from, to);
    expect(result).toHaveLength(2);
    expect(result[0].toISOString()).toBe("2026-05-18T10:55:00.000Z");
    expect(result[1].toISOString()).toBe("2026-05-18T11:50:00.000Z");
  });

  it("returns empty array for non-positive interval", () => {
    const from = new Date("2026-05-18T10:00:00Z");
    const to = new Date("2026-05-18T12:00:00Z");
    expect(intervalOccurrencesBetween(0, anchor, from, to)).toHaveLength(0);
    expect(intervalOccurrencesBetween(-60, anchor, from, to)).toHaveLength(0);
  });

  it("returns empty array for non-finite interval", () => {
    const from = new Date("2026-05-18T10:00:00Z");
    const to = new Date("2026-05-18T12:00:00Z");
    expect(
      intervalOccurrencesBetween(Number.NaN, anchor, from, to),
    ).toHaveLength(0);
    expect(
      intervalOccurrencesBetween(Number.POSITIVE_INFINITY, anchor, from, to),
    ).toHaveLength(0);
  });

  it("returns empty array for an Invalid Date anchor", () => {
    const badAnchor = new Date("not-a-date");
    const from = new Date("2026-05-18T10:00:00Z");
    const to = new Date("2026-05-18T12:00:00Z");
    expect(intervalOccurrencesBetween(3300, badAnchor, from, to)).toHaveLength(
      0,
    );
  });

  it("returns empty array when from >= to", () => {
    const t = new Date("2026-05-18T10:55:00Z");
    expect(intervalOccurrencesBetween(3300, anchor, t, t)).toHaveLength(0);
  });
});
