import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AnalyticsStreamDeps,
  type AnalyticsStreamOpts,
  createAnalyticsStreamStart,
} from "@/lib/analytics/stream-start";
import type { AnalyticsSummary } from "@/lib/analytics/types";

const EMPTY_SUMMARY: AnalyticsSummary = {
  totalRuns: 0,
  successCount: 0,
  errorCount: 0,
  cancelledCount: 0,
  successRate: 0,
  avgDurationMs: null,
  totalGasWei: "0",
  sponsoredGasWei: "0",
  activeRuns: 0,
  previousPeriod: null,
};

function makeDeps(): AnalyticsStreamDeps {
  return {
    getChecksum: vi.fn(async () => "stable-checksum"),
    getSummary: vi.fn(async () => EMPTY_SUMMARY),
  };
}

function makeController(): ReadableStreamDefaultController<Uint8Array> {
  return {
    enqueue: vi.fn(),
    close: vi.fn(),
    error: vi.fn(),
    desiredSize: 1,
  } as unknown as ReadableStreamDefaultController<Uint8Array>;
}

function makeOpts(overrides: Partial<AnalyticsStreamOpts> = {}): {
  opts: AnalyticsStreamOpts;
  abortController: AbortController;
} {
  const abortController = new AbortController();
  const opts: AnalyticsStreamOpts = {
    signal: abortController.signal,
    organizationId: "org-1",
    range: "7d",
    deps: makeDeps(),
    config: {
      pollIntervalMs: 100,
      heartbeatIntervalMs: 10_000,
      maxLifetimeMs: 500,
      minEventIntervalMs: 50,
    },
    ...overrides,
  };
  return { opts, abortController };
}

describe("createAnalyticsStreamStart", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers the abort listener with { once: true }", () => {
    const { opts, abortController } = makeOpts();
    const addSpy = vi.spyOn(abortController.signal, "addEventListener");

    const start = createAnalyticsStreamStart(opts);
    start(makeController());

    expect(addSpy).toHaveBeenCalledWith("abort", expect.any(Function), {
      once: true,
    });
  });

  it("removes the listener and closes the controller when abort fires", async () => {
    const { opts, abortController } = makeOpts();
    const removeSpy = vi.spyOn(abortController.signal, "removeEventListener");
    const controller = makeController();

    const start = createAnalyticsStreamStart(opts);
    start(controller);

    abortController.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(controller.close).toHaveBeenCalledTimes(1);
  });

  it("removes the listener and closes the controller on natural lifetime expiry", async () => {
    const { opts, abortController } = makeOpts();
    const removeSpy = vi.spyOn(abortController.signal, "removeEventListener");
    const controller = makeController();

    const start = createAnalyticsStreamStart(opts);
    start(controller);

    // pollIntervalMs=100, maxLifetimeMs=500. Tick past the threshold so the
    // poll handler observes Date.now() - startTime > maxLifetime and triggers safeClose.
    await vi.advanceTimersByTimeAsync(700);

    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(controller.close).toHaveBeenCalledTimes(1);
  });

  it("safeClose is idempotent when both abort and timeout occur", async () => {
    const { opts, abortController } = makeOpts();
    const controller = makeController();

    const start = createAnalyticsStreamStart(opts);
    start(controller);

    abortController.abort();
    await vi.advanceTimersByTimeAsync(700);

    expect(controller.close).toHaveBeenCalledTimes(1);
  });
});
