import { createHash, createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RPC_USAGE_INGEST_PATH,
  RpcOrigin,
  RpcTransport,
  RpcUsageCounter,
} from "../../lib/rpc-route.js";
import {
  type RpcUsageBucket,
  RpcUsageReporter,
  type RpcUsageSource,
} from "../../lib/rpc-usage.js";

const HOUR_MS = 3_600_000;
const T0 = Date.UTC(2026, 10, 25, 14, 12, 30);

function source(overrides?: Partial<RpcUsageSource>): RpcUsageSource {
  return {
    organizationId: "org-1",
    configId: "cfg-1",
    origin: RpcOrigin.ORG,
    chainId: 1,
    transport: RpcTransport.WSS,
    ...overrides,
  };
}

function bodies(send: ReturnType<typeof vi.fn>): RpcUsageBucket[][] {
  return send.mock.calls.map(
    ([body]) =>
      (JSON.parse(body as string) as { buckets: RpcUsageBucket[] }).buckets,
  );
}

describe("RpcUsageReporter", () => {
  let now: number;
  let send: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    now = T0;
    send = vi.fn().mockResolvedValue(200);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function reporter(maxRetainedBuckets?: number): RpcUsageReporter {
    return new RpcUsageReporter({ send, now: () => now, maxRetainedBuckets });
  }

  it("aggregates counters per source and UTC hour", async () => {
    const usage = reporter();
    usage.record(source(), RpcUsageCounter.REQUESTS);
    usage.record(source(), RpcUsageCounter.REQUESTS);
    usage.record(source(), RpcUsageCounter.WS_CONNECTS);
    usage.record(
      source({ configId: null, origin: RpcOrigin.PLATFORM }),
      RpcUsageCounter.EVENTS_RECEIVED,
    );
    now = T0 + HOUR_MS;
    usage.record(source(), RpcUsageCounter.ERRORS);

    await usage.flush();

    expect(send).toHaveBeenCalledTimes(1);
    expect(bodies(send)[0]).toEqual([
      {
        ...source(),
        hour: "2026-11-25T14:00:00.000Z",
        counters: { requests: 2, wsConnects: 1 },
      },
      {
        ...source({ configId: null, origin: RpcOrigin.PLATFORM }),
        hour: "2026-11-25T14:00:00.000Z",
        counters: { eventsReceived: 1 },
      },
      {
        ...source(),
        hour: "2026-11-25T15:00:00.000Z",
        counters: { errors: 1 },
      },
    ]);
    expect(usage.pendingBuckets()).toEqual([]);
  });

  it("sends nothing when no usage was recorded", async () => {
    await reporter().flush();
    expect(send).not.toHaveBeenCalled();
  });

  it("splits reports into requests of at most 1000 buckets", async () => {
    const usage = reporter();
    for (let chainId = 1; chainId <= 2500; chainId++) {
      usage.record(source({ chainId }), RpcUsageCounter.REQUESTS);
    }

    await usage.flush();

    expect(bodies(send).map((batch) => batch.length)).toEqual([
      1000, 1000, 500,
    ]);
  });

  it("sends an unanswered report again, unchanged, before the next one", async () => {
    const usage = reporter();
    usage.record(source(), RpcUsageCounter.REQUESTS);
    send.mockResolvedValueOnce(503);

    await usage.flush();
    usage.record(source(), RpcUsageCounter.REQUESTS);
    await usage.flush();

    expect(send).toHaveBeenCalledTimes(3);
    const [first, again, next] = send.mock.calls.map(
      ([body]) => JSON.parse(body as string) as { reportId: string },
    );
    expect(again).toEqual(first);
    expect(next.reportId).not.toBe(first.reportId);
    expect(bodies(send)[2]).toEqual([
      {
        ...source(),
        hour: "2026-11-25T14:00:00.000Z",
        counters: { requests: 1 },
      },
    ]);
  });

  it("drops a report the app refuses instead of sending it forever", async () => {
    const usage = reporter();
    usage.record(source(), RpcUsageCounter.REQUESTS);
    send.mockResolvedValueOnce(400);

    await usage.flush();

    expect(usage.pendingBuckets()).toEqual([]);
  });

  it("bounds the retained buckets by dropping the oldest hours", async () => {
    const usage = reporter(2);
    send.mockRejectedValue(new Error("down"));
    for (let hour = 0; hour < 4; hour++) {
      now = T0 + hour * HOUR_MS;
      usage.record(source(), RpcUsageCounter.REQUESTS);
    }

    await usage.flush();

    expect(usage.pendingBuckets().map((bucket) => bucket.hour)).toEqual([
      "2026-11-25T16:00:00.000Z",
      "2026-11-25T17:00:00.000Z",
    ]);
  });

  it("reports on its interval and once more on stop", async () => {
    vi.useFakeTimers();
    try {
      const usage = reporter();
      usage.start(30_000);
      usage.record(source(), RpcUsageCounter.REQUESTS);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(send).toHaveBeenCalledTimes(1);

      usage.record(source(), RpcUsageCounter.WS_RECONNECTS);
      await usage.stop();
      expect(send).toHaveBeenCalledTimes(2);
      expect(bodies(send)[1][0].counters).toEqual({ wsReconnects: 1 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("RpcUsageReporter default transport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("posts to the ingest path once, signing the exact raw body", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ accepted: 1 }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchMock);
    const usage = new RpcUsageReporter();
    usage.record(source(), RpcUsageCounter.REQUESTS);

    await usage.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe(RPC_USAGE_INGEST_PATH);
    expect(init.method).toBe("POST");
    const body = init.body as string;
    expect(JSON.parse(body).buckets[0].counters).toEqual({ requests: 1 });
    const headers = init.headers as Record<string, string>;
    const digest = createHash("sha256").update(body).digest("hex");
    const expected = createHmac("sha256", "test-hmac-secret")
      .update(
        `POST\n${RPC_USAGE_INGEST_PATH}\nscheduler\n${digest}\n${headers["X-KH-Timestamp"]}`,
      )
      .digest("hex");
    expect(headers["X-KH-Signature"]).toBe(expected);
  });

  it("does not retry a failed report within one flush", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
      text: async () => "unavailable",
    });
    vi.stubGlobal("fetch", fetchMock);
    const usage = new RpcUsageReporter();
    usage.record(source(), RpcUsageCounter.REQUESTS);

    await usage.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(usage.pendingBuckets()).toHaveLength(1);
  });
});
