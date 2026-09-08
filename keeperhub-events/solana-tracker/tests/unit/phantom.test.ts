import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/utils/logger", () => ({
  logger: { warn: vi.fn(), log: vi.fn() },
}));

// HMAC signing reads INTERNAL_SERVICE_HMAC_SECRET and parses the request URL;
// stub it so the unit test asserts the request shape without a real base
// URL/secret. The caller is echoed so the test can see which one was signed.
vi.mock("../../lib/utils/fetch-utils", () => ({
  signHmacHeaders: (
    _method: string,
    _url: string,
    _body: string,
    caller: string,
  ) => ({
    "X-KH-Caller": caller,
    "X-KH-Timestamp": "1",
    "X-KH-Signature": "sig",
  }),
}));

import {
  createPhantomExecution,
  failPhantomExecution,
} from "../../lib/phantom";

const EVENT_KEY = "event:wf_1:101:sig_1";
const BLOCK_KEY = "block:wf_1:101:4242";

function reply(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe("createPhantomExecution (solana-tracker)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("POSTs an event phantom keyed by the dispatch key as caller events", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        reply(201, { executionId: "exec_evt", alreadyExisted: false }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await createPhantomExecution(
      "wf_1",
      "owner_1",
      "event",
      "events",
      EVENT_KEY,
    );

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
      dispatchKey: EVENT_KEY,
    });
  });

  it("POSTs a block phantom as caller scheduler with source block", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(reply(201, { executionId: "exec_blk" }));
    vi.stubGlobal("fetch", fetchMock);

    await createPhantomExecution(
      "wf_1",
      "owner_1",
      "block",
      "scheduler",
      BLOCK_KEY,
    );

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers["X-KH-Caller"]).toBe("scheduler");
    expect(JSON.parse(init.body)).toMatchObject({
      triggerSource: "block",
      dispatchKey: BLOCK_KEY,
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
      createPhantomExecution("wf_1", "owner_1", "event", "events", EVENT_KEY),
    ).resolves.toEqual({ executionId: "exec_existing", alreadyExisted: true });
  });

  // After a retry the existing row may be this ingestor's own, created by an
  // attempt whose reply was lost and therefore never enqueued. Reporting it as
  // fresh makes the caller enqueue; the executor's claim CAS absorbs the rare
  // genuine duplicate, whereas a skip would strand the phantom for the reaper.
  it("does not trust alreadyExisted from a retried attempt", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(502, {}))
      .mockResolvedValueOnce(
        reply(200, { executionId: "exec_mine", alreadyExisted: true }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const pending = createPhantomExecution(
      "wf_1",
      "owner_1",
      "event",
      "events",
      EVENT_KEY,
    );
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
      createPhantomExecution("wf_1", "owner_1", "event", "events", EVENT_KEY),
    ).resolves.toEqual({ alreadyExisted: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a 5xx after 500ms and 1s, then returns no id and no refusal", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(reply(503, {}));
    vi.stubGlobal("fetch", fetchMock);

    const pending = createPhantomExecution(
      "wf_1",
      "owner_1",
      "block",
      "scheduler",
      BLOCK_KEY,
    );
    await vi.advanceTimersByTimeAsync(499);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toEqual({ alreadyExisted: false });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries when fetch rejects and gives up after the third attempt", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(new Error("network"));
    vi.stubGlobal("fetch", fetchMock);

    const pending = createPhantomExecution(
      "wf_1",
      "owner_1",
      "event",
      "events",
      EVENT_KEY,
    );
    await vi.advanceTimersByTimeAsync(1_500);

    await expect(pending).resolves.toEqual({ alreadyExisted: false });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  // A transport failure and a refusal must stay distinguishable: the first
  // still falls back to the id-less enqueue, the second must not enqueue.
  it("reports a refusal instead of an id when the platform declines", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        reply(200, {
          refused: true,
          reason: "plan_feature",
          error: "gated action",
        }),
      ),
    );

    await expect(
      createPhantomExecution("wf_1", "owner_1", "event", "events", EVENT_KEY),
    ).resolves.toEqual({ alreadyExisted: false, refused: "plan_feature" });
  });
});

describe("failPhantomExecution (solana-tracker)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("PATCHes the phantom row to a coded error under the given caller", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    await failPhantomExecution(
      "exec_blk",
      "BS-0001",
      "dispatch failed",
      "scheduler",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/internal\/executions\/exec_blk$/);
    expect(init.method).toBe("PATCH");
    expect(init.headers["X-KH-Caller"]).toBe("scheduler");
    expect(JSON.parse(init.body)).toEqual({
      status: "system_error",
      error: "dispatch failed",
      errorCode: "BS-0001",
    });
  });

  it("retries a transport failure, then swallows it (the reaper is the backstop)", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(new Error("network"));
    vi.stubGlobal("fetch", fetchMock);

    const pending = failPhantomExecution("exec_evt", "ES-0001", "x", "events");
    await vi.advanceTimersByTimeAsync(1_500);

    await expect(pending).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
