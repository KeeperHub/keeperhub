import {
  type MockInstance,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { apiRequest, apiRequestWithAttempts } from "../../lib/http-client.js";

function reply(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
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

// The phantom POST is only safe to retry because its dispatch key makes a
// repeat a no-op on the server, so the schedule here (one attempt, then 500ms
// and 1s backoffs, 5s per attempt, 5xx and transport failures only) is part of
// the exactly-once contract and is pinned as such.
describe("apiRequest retry policy", () => {
  let warnSpy: MockInstance;

  beforeEach(() => {
    vi.useFakeTimers();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    warnSpy.mockRestore();
  });

  it("answers from the first attempt when the API replies 2xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(200, { schedules: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      apiRequestWithAttempts("/api/internal/schedules"),
    ).resolves.toEqual({ data: { schedules: [] }, attempts: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("retries a 5xx after 500ms and reports the attempt that was answered", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(503, "unavailable"))
      .mockResolvedValueOnce(reply(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = apiRequestWithAttempts("/api/internal/executions", {
      method: "POST",
      body: "{}",
    });
    await vi.advanceTimersByTimeAsync(499);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ data: { ok: true }, attempts: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("waits 1s before the third and final attempt, then rethrows the last error", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", fetchMock);

    const rejection = expect(apiRequest("/x")).rejects.toThrow("ECONNREFUSED");
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry a 4xx", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(reply(404, { error: "Workflow not found" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      apiRequest("/api/internal/executions", { method: "POST", body: "{}" }),
    ).rejects.toThrow(/API POST \/api\/internal\/executions failed: 404/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("aborts an attempt that exceeds 5s and retries it", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(hangUntilAborted())
      .mockResolvedValueOnce(reply(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = apiRequestWithAttempts("/x");
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The abort fires at 5s; the retry follows after the 500ms backoff.
    await vi.advanceTimersByTimeAsync(1 + 500);
    await expect(pending).resolves.toEqual({ data: { ok: true }, attempts: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("signs every request with the scheduler's HMAC headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(200, {}));
    vi.stubGlobal("fetch", fetchMock);

    await apiRequest("/api/internal/schedules");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["X-KH-Caller"]).toBe("scheduler");
    expect(headers["X-KH-Timestamp"]).toMatch(/^\d+$/);
    expect(headers["X-KH-Signature"]).toMatch(/^[0-9a-f]{64}$/);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
