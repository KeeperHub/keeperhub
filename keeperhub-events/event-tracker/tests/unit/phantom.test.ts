import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/utils/logger", () => ({
  logger: { warn: vi.fn(), log: vi.fn() },
}));

// HMAC signing reads INTERNAL_SERVICE_HMAC_SECRET and parses the request URL;
// stub it so the unit test asserts the request shape without a real base
// URL/secret.
vi.mock("../../lib/utils/fetch-utils", () => ({
  // Plain function (not vi.fn) so restoreAllMocks in beforeEach can't neutralise it.
  signHmacHeaders: () => ({
    "X-KH-Caller": "events",
    "X-KH-Timestamp": "1",
    "X-KH-Signature": "sig",
  }),
}));

import {
  createPhantomExecution,
  failPhantomExecution,
} from "../../lib/phantom";

const KEY = `event:wf_1:1:0x${"a".repeat(64)}:0`;

function reply(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

/** A fetch that never answers until the client's own timeout aborts it. */
function hangUntilAborted(): (
  url: string,
  init: RequestInit,
) => Promise<never> {
  return (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () =>
        reject(new Error("aborted")),
      );
    });
}

describe("createPhantomExecution (event-tracker)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("POSTs a phantom row keyed by the dispatch key and returns the execution id", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        reply(201, { executionId: "exec_evt", alreadyExisted: false }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await createPhantomExecution("wf_1", "owner_1", KEY);

    expect(result).toEqual({ executionId: "exec_evt", alreadyExisted: false });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/internal\/executions$/);
    expect(init.method).toBe("POST");
    expect(init.headers["X-KH-Caller"]).toBe("events");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body)).toEqual({
      workflowId: "wf_1",
      userId: "owner_1",
      status: "phantom",
      triggerSource: "event",
      dispatchKey: KEY,
    });
  });

  it("reports alreadyExisted on a first-attempt dedup hit", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          reply(200, { executionId: "exec_existing", alreadyExisted: true }),
        ),
    );

    await expect(
      createPhantomExecution("wf_1", "owner_1", KEY),
    ).resolves.toEqual({ executionId: "exec_existing", alreadyExisted: true });
  });

  // After a retry the existing row may be this listener's own, created by an
  // attempt whose reply was lost and therefore never enqueued. Reporting it as
  // fresh makes the caller enqueue; the executor's claim CAS absorbs the rare
  // genuine duplicate, whereas a skip would strand the phantom for the reaper.
  it("does not trust alreadyExisted from a retried attempt", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce(
        reply(200, { executionId: "exec_mine", alreadyExisted: true }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const pending = createPhantomExecution("wf_1", "owner_1", KEY);
    await vi.advanceTimersByTimeAsync(500);

    await expect(pending).resolves.toEqual({
      executionId: "exec_mine",
      alreadyExisted: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 4xx: returns no id and no refusal (best-effort)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(reply(404, { error: "Workflow not found" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createPhantomExecution("wf_1", "owner_1", KEY),
    ).resolves.toEqual({ alreadyExisted: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a 5xx after 500ms and 1s, then returns no id and no refusal", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(reply(503, {}));
    vi.stubGlobal("fetch", fetchMock);

    const pending = createPhantomExecution("wf_1", "owner_1", KEY);
    await vi.advanceTimersByTimeAsync(499);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual({ alreadyExisted: false });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries when fetch rejects and gives up after the third attempt", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(new Error("network"));
    vi.stubGlobal("fetch", fetchMock);

    const pending = createPhantomExecution("wf_1", "owner_1", KEY);
    await vi.advanceTimersByTimeAsync(1_500);

    await expect(pending).resolves.toEqual({ alreadyExisted: false });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("aborts an attempt that exceeds 5s and retries it", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(hangUntilAborted())
      .mockResolvedValueOnce(reply(201, { executionId: "exec_late" }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = createPhantomExecution("wf_1", "owner_1", KEY);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The abort fires at 5s; the retry follows after the 500ms backoff.
    await vi.advanceTimersByTimeAsync(1 + 500);

    await expect(pending).resolves.toEqual({
      executionId: "exec_late",
      alreadyExisted: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // A transport failure and a refusal must stay distinguishable: the first
  // still falls back to the id-less enqueue, the second must not enqueue.
  it("reports a refusal instead of an id when the platform declines", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        reply(200, {
          refused: true,
          reason: "execution_limit",
          error: "limit reached",
        }),
      ),
    );

    await expect(
      createPhantomExecution("wf_1", "owner_1", KEY),
    ).resolves.toEqual({ alreadyExisted: false, refused: "execution_limit" });
  });
});

describe("failPhantomExecution (event-tracker)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("PATCHes the phantom row to a coded error", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    await failPhantomExecution("exec_evt", "ES-0001", "dispatch failed");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/internal\/executions\/exec_evt$/);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({
      status: "system_error",
      error: "dispatch failed",
      errorCode: "ES-0001",
    });
  });

  it("retries a transport failure, then swallows it (the reaper is the backstop)", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(new Error("network"));
    vi.stubGlobal("fetch", fetchMock);

    const pending = failPhantomExecution("exec_evt", "ES-0001", "x");
    await vi.advanceTimersByTimeAsync(1_500);

    await expect(pending).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
