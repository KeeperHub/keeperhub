import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./config", () => ({
  CONFIG: {
    keeperhubApiUrl: "https://api.test.local",
  },
}));

const { executeViaApi } = await import("./api-execute");

const API_CALL_FAILED_500 = /API call failed: 500/;

describe("executeViaApi", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ executionId: "exec-1" }),
      } as Response)
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function getFetchInit(): RequestInit {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const call = fetchMock.mock.calls[0];
    return call[1] as RequestInit;
  }

  function getHeader(
    headers: HeadersInit | undefined,
    name: string
  ): string | undefined {
    if (!headers) {
      return undefined;
    }
    // The implementation passes a plain Record<string, string>, so simple lookup is sufficient.
    return (headers as Record<string, string>)[name];
  }

  it("sends X-Trigger-Type=block when triggerType is block", async () => {
    await executeViaApi({
      workflowId: "wf-1",
      executionId: "exec-1",
      input: {},
      triggerType: "block",
    });

    const init = getFetchInit();
    expect(getHeader(init.headers, "X-Trigger-Type")).toBe("block");
    expect(getHeader(init.headers, "X-KH-Caller")).toBe("executor");
    expect(getHeader(init.headers, "X-KH-Timestamp")).toMatch(/^\d+$/);
    expect(getHeader(init.headers, "X-KH-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sends X-Trigger-Type=schedule when triggerType is schedule", async () => {
    await executeViaApi({
      workflowId: "wf-2",
      executionId: "exec-2",
      input: {},
      triggerType: "schedule",
    });

    expect(getHeader(getFetchInit().headers, "X-Trigger-Type")).toBe(
      "schedule"
    );
  });

  it("sends X-Trigger-Type=event when triggerType is event", async () => {
    await executeViaApi({
      workflowId: "wf-3",
      executionId: "exec-3",
      input: { foo: "bar" },
      triggerType: "event",
    });

    expect(getHeader(getFetchInit().headers, "X-Trigger-Type")).toBe("event");
  });

  it("throws if the API responds non-ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("boom"),
      } as Response)
    );

    await expect(
      executeViaApi({
        workflowId: "wf-4",
        executionId: "exec-4",
        input: {},
        triggerType: "block",
      })
    ).rejects.toThrow(API_CALL_FAILED_500);
  });
});
