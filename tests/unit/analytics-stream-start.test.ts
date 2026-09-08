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
  skippedCount: 0,
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

  // The client already has the summary from its own HTTP fetch on mount, and
  // maxLifetimeMs forces a reconnect every few minutes. Pushing on the first
  // checksum therefore made every viewer recompute the summary on a fixed
  // interval regardless of activity.
  it("primes on the first poll without computing a summary", async () => {
    const { opts } = makeOpts();
    const controller = makeController();

    const start = createAnalyticsStreamStart(opts);
    start(controller);

    await vi.advanceTimersByTimeAsync(150);

    expect(opts.deps.getChecksum).toHaveBeenCalledTimes(1);
    expect(opts.deps.getSummary).not.toHaveBeenCalled();
    expect(controller.enqueue).not.toHaveBeenCalled();
  });

  it("pushes a summary once the checksum moves off the primed value", async () => {
    const checksums = ["first", "second"];
    const { opts } = makeOpts({
      deps: {
        getChecksum: vi.fn(async () => checksums.shift() ?? "second"),
        getSummary: vi.fn(async () => EMPTY_SUMMARY),
      },
    });
    const controller = makeController();

    const start = createAnalyticsStreamStart(opts);
    start(controller);

    await vi.advanceTimersByTimeAsync(250);

    expect(opts.deps.getSummary).toHaveBeenCalledTimes(1);
    expect(controller.enqueue).toHaveBeenCalledTimes(1);
  });

  it("keeps the stream open when a single poll fails", async () => {
    const getChecksum = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("statement timeout"))
      .mockResolvedValue("recovered");
    const { opts } = makeOpts({
      deps: { getChecksum, getSummary: vi.fn(async () => EMPTY_SUMMARY) },
    });
    const controller = makeController();

    const start = createAnalyticsStreamStart(opts);
    start(controller);

    await vi.advanceTimersByTimeAsync(250);

    expect(getChecksum).toHaveBeenCalledTimes(2);
    expect(controller.close).not.toHaveBeenCalled();
  });

  it("closes once the checksum has failed maxConsecutiveFailures times", async () => {
    const { opts } = makeOpts({
      deps: {
        getChecksum: vi.fn(() =>
          Promise.reject(new Error("statement timeout"))
        ),
        getSummary: vi.fn(async () => EMPTY_SUMMARY),
      },
      config: {
        pollIntervalMs: 100,
        heartbeatIntervalMs: 10_000,
        maxLifetimeMs: 5000,
        minEventIntervalMs: 50,
        maxConsecutiveFailures: 3,
      },
    });
    const controller = makeController();

    const start = createAnalyticsStreamStart(opts);
    start(controller);

    await vi.advanceTimersByTimeAsync(250);
    expect(controller.close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    expect(controller.close).toHaveBeenCalledTimes(1);
  });

  // A failing summary is the case that caused the outage. Closing on it sent the
  // browser into a reconnect that recomputes the very query that just failed, so
  // only the checksum read counts towards giving up.
  it("does not close when the summary keeps failing but the checksum works", async () => {
    let n = 0;
    const { opts } = makeOpts({
      deps: {
        getChecksum: vi.fn(async () => {
          n += 1;
          return `checksum-${n}`;
        }),
        getSummary: vi.fn(() => Promise.reject(new Error("statement timeout"))),
      },
      config: {
        pollIntervalMs: 100,
        heartbeatIntervalMs: 10_000,
        maxLifetimeMs: 5000,
        minEventIntervalMs: 50,
        maxConsecutiveFailures: 3,
      },
    });
    const controller = makeController();

    const start = createAnalyticsStreamStart(opts);
    start(controller);

    await vi.advanceTimersByTimeAsync(650);

    expect(opts.deps.getSummary).toHaveBeenCalled();
    expect(controller.close).not.toHaveBeenCalled();
  });
});
