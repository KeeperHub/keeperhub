import { createHash, createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcUsageAttribution } from "../../src/chains/route-provider-pool";
import {
  RPC_USAGE_INGEST_PATH,
  RpcOrigin,
  RpcTransport,
  RpcUsageCounter,
} from "../../src/chains/rpc-route";
import {
  RpcUsageReporter,
  USAGE_FLUSH_INTERVAL_MS,
  USAGE_MAX_BUCKETS_PER_REQUEST,
} from "../../src/usage/rpc-usage-reporter";

const ORG_ENDPOINT: RpcUsageAttribution = {
  organizationId: "org-1",
  configId: "cfg-1",
  origin: RpcOrigin.ORG,
  chainId: 8453,
  transport: RpcTransport.WSS,
};
const PLATFORM_FALLBACK: RpcUsageAttribution = {
  ...ORG_ENDPOINT,
  configId: null,
  origin: RpcOrigin.PLATFORM,
};

const T_10_05 = Date.UTC(2026, 0, 1, 10, 5);
const T_10_55 = Date.UTC(2026, 0, 1, 10, 55);
const T_11_01 = Date.UTC(2026, 0, 1, 11, 1);

function sentBodies(send: ReturnType<typeof vi.fn>): unknown[] {
  return send.mock.calls.map((call) => JSON.parse(String(call[0])));
}

describe("RpcUsageReporter", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock("../../lib/config/environment");
  });

  it("aggregates per UTC hour and attribution and posts the documented body", async () => {
    let now = T_10_05;
    const send = vi.fn(async (_body: string) => true);
    const reporter = new RpcUsageReporter({ send, now: () => now });

    reporter.record(ORG_ENDPOINT, RpcUsageCounter.REQUESTS, 2);
    reporter.record(ORG_ENDPOINT, RpcUsageCounter.REQUESTS, 3);
    reporter.record(ORG_ENDPOINT, RpcUsageCounter.WS_CONNECTS, 1);
    reporter.record(PLATFORM_FALLBACK, RpcUsageCounter.ERRORS, 1);
    now = T_10_55;
    reporter.record(ORG_ENDPOINT, RpcUsageCounter.EVENTS_RECEIVED, 4);
    now = T_11_01;
    reporter.record(ORG_ENDPOINT, RpcUsageCounter.WS_RECONNECTS, 1);
    reporter.record(ORG_ENDPOINT, RpcUsageCounter.REQUESTS, 0);

    await reporter.flush();

    expect(send).toHaveBeenCalledTimes(1);
    expect(sentBodies(send)[0]).toEqual({
      buckets: [
        {
          ...ORG_ENDPOINT,
          hour: "2026-01-01T10:00:00.000Z",
          counters: { requests: 5, wsConnects: 1, eventsReceived: 4 },
        },
        {
          ...PLATFORM_FALLBACK,
          hour: "2026-01-01T10:00:00.000Z",
          counters: { errors: 1 },
        },
        {
          ...ORG_ENDPOINT,
          hour: "2026-01-01T11:00:00.000Z",
          counters: { wsReconnects: 1 },
        },
      ],
    });
    expect(reporter.pendingBuckets()).toHaveLength(0);
  });

  it("splits large reports into requests of at most 1000 buckets", async () => {
    const send = vi.fn(async (_body: string) => true);
    const reporter = new RpcUsageReporter({ send, now: () => T_10_05 });
    for (let i = 0; i < USAGE_MAX_BUCKETS_PER_REQUEST + 500; i += 1) {
      reporter.record(
        { ...ORG_ENDPOINT, configId: `cfg-${i}` },
        RpcUsageCounter.REQUESTS,
        1,
      );
    }
    await reporter.flush();
    const bodies = sentBodies(send) as { buckets: unknown[] }[];
    expect(bodies.map((body) => body.buckets.length)).toEqual([1000, 500]);
  });

  it("keeps counts from a failed post and merges them into the next one", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const send = vi
      .fn(async (_body: string) => true)
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error("network down"));
    const reporter = new RpcUsageReporter({ send, now: () => T_10_05 });

    reporter.record(ORG_ENDPOINT, RpcUsageCounter.REQUESTS, 2);
    await reporter.flush();
    reporter.record(ORG_ENDPOINT, RpcUsageCounter.REQUESTS, 3);
    await reporter.flush();
    expect(reporter.pendingBuckets()[0].counters).toEqual({ requests: 5 });

    await reporter.flush();
    const bodies = sentBodies(send) as {
      buckets: { counters: unknown }[];
    }[];
    expect(bodies[2].buckets[0].counters).toEqual({ requests: 5 });
    expect(reporter.pendingBuckets()).toHaveLength(0);
  });

  it("caps held buckets by dropping the oldest hours", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let now = T_10_05;
    const reporter = new RpcUsageReporter({
      send: vi.fn(async () => false),
      now: () => now,
      maxHeldBuckets: 2,
    });
    reporter.record(ORG_ENDPOINT, RpcUsageCounter.REQUESTS, 1);
    now = T_11_01;
    reporter.record(ORG_ENDPOINT, RpcUsageCounter.REQUESTS, 1);
    reporter.record(PLATFORM_FALLBACK, RpcUsageCounter.REQUESTS, 1);
    const hours = reporter.pendingBuckets().map((bucket) => bucket.hour);
    expect(hours).toEqual([
      "2026-01-01T11:00:00.000Z",
      "2026-01-01T11:00:00.000Z",
    ]);
  });

  it("posts on its interval and once more on stop", async () => {
    vi.useFakeTimers();
    const send = vi.fn(async (_body: string) => true);
    const reporter = new RpcUsageReporter({ send, now: () => T_10_05 });
    reporter.start();
    reporter.record(ORG_ENDPOINT, RpcUsageCounter.REQUESTS, 1);
    await vi.advanceTimersByTimeAsync(USAGE_FLUSH_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(1);

    reporter.record(ORG_ENDPOINT, RpcUsageCounter.REQUESTS, 1);
    await reporter.stop();
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(USAGE_FLUSH_INTERVAL_MS * 2);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("signs the exact raw body it posts to the ingest path", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const rawBody = JSON.stringify({ buckets: [] });
    vi.doMock("../../lib/config/environment", () => ({
      KEEPERHUB_API_URL: "http://app.test",
    }));
    const { postSignedInternal } = await import("../../lib/utils/fetch-utils");

    await expect(
      postSignedInternal(RPC_USAGE_INGEST_PATH, rawBody),
    ).resolves.toBe(true);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(`http://app.test${RPC_USAGE_INGEST_PATH}`);
    expect(init.method).toBe("POST");
    expect(init.body).toBe(rawBody);
    const headers = init.headers as Record<string, string>;
    const digest = createHash("sha256").update(rawBody).digest("hex");
    const signingString = `POST\n${RPC_USAGE_INGEST_PATH}\nevents\n${digest}\n${headers["X-KH-Timestamp"]}`;
    const expected = createHmac(
      "sha256",
      process.env.INTERNAL_SERVICE_HMAC_SECRET ?? "",
    )
      .update(signingString)
      .digest("hex");
    expect(headers["X-KH-Signature"]).toBe(expected);
    expect(headers["X-KH-Caller"]).toBe("events");
  });
});
