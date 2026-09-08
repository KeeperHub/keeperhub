import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `server-only` throws on import outside a React Server Component, which is the
// whole point of the marker. Stub it so the guard stays in the source.
vi.mock("server-only", () => ({}));

// vi.mock is hoisted above the imports, so the stubs have to be hoisted with
// it rather than declared as ordinary top-level consts.
const { processMemoryMetrics, cgroup, logWarn } = vi.hoisted(() => {
  const gauge = () => ({ set: vi.fn() });
  return {
    processMemoryMetrics: {
      rss: gauge(),
      heapUsed: gauge(),
      external: gauge(),
      arrayBuffers: gauge(),
      rssPeak: gauge(),
      heapUsedPeak: gauge(),
      externalPeak: gauge(),
      arrayBuffersPeak: gauge(),
      cgroupCurrent: gauge(),
      cgroupPeak: gauge(),
      cgroupLimit: gauge(),
      cgroupOomKills: gauge(),
    },
    cgroup: {
      readCgroupMemory: vi.fn(),
      readCgroupOomKills: vi.fn(),
    },
    logWarn: vi.fn(),
  };
});

// The real module pulls in prom-client and `server-only`. The sampler logic is
// what this suite covers, so the gauges are stubbed out entirely.
vi.mock("@/lib/metrics/collectors/prometheus", () => ({
  processMemoryMetrics,
}));

// The cgroup files exist only inside a container, so the reader is stubbed and
// its own behaviour is covered separately.
vi.mock("@/lib/metrics/cgroup-memory", () => cgroup);

vi.mock("@/lib/logging", () => ({ logWarn }));

const LIMIT = 6 * 1024 * 1024 * 1024;

function cgroupAt(fraction: number): void {
  cgroup.readCgroupMemory.mockReturnValue({
    current: Math.round(LIMIT * fraction),
    peak: Math.round(LIMIT * fraction),
    limit: LIMIT,
  });
}

import {
  sampleProcessMemory,
  startProcessMemorySampler,
  stopProcessMemorySampler,
  updateProcessMemoryGauges,
} from "@/lib/metrics/instrumentation/process-memory";

type Usage = {
  rss: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
};

function usage(u: Usage): NodeJS.MemoryUsage {
  return {
    rss: u.rss,
    heapTotal: u.heapUsed * 2,
    heapUsed: u.heapUsed,
    external: u.external,
    arrayBuffers: u.arrayBuffers,
  };
}

function mockUsage(u: Usage): void {
  vi.spyOn(process, "memoryUsage").mockReturnValue(usage(u));
}

const BASE: Usage = {
  rss: 700,
  heapUsed: 300,
  external: 80,
  arrayBuffers: 40,
};

const SPIKE: Usage = {
  rss: 4000,
  heapUsed: 900,
  external: 2600,
  arrayBuffers: 2400,
};

describe("Process Memory Instrumentation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stopProcessMemorySampler();
    for (const g of Object.values(processMemoryMetrics)) {
      g.set.mockClear();
    }
    logWarn.mockClear();
    // Default: no cgroup, which is the off-cluster case.
    cgroup.readCgroupMemory.mockReturnValue(null);
    cgroup.readCgroupOomKills.mockReturnValue(null);
  });

  afterEach(() => {
    stopProcessMemorySampler();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe("peak tracking", () => {
    it("reports a spike that has already passed by the time of the scrape", () => {
      mockUsage(BASE);
      startProcessMemorySampler();

      // The spike opens and closes entirely between two scrapes.
      mockUsage(SPIKE);
      vi.advanceTimersByTime(2000);
      mockUsage(BASE);
      vi.advanceTimersByTime(2000);

      updateProcessMemoryGauges();

      expect(processMemoryMetrics.rss.set).toHaveBeenCalledWith(BASE.rss);
      expect(processMemoryMetrics.rssPeak.set).toHaveBeenCalledWith(SPIKE.rss);
      expect(processMemoryMetrics.arrayBuffersPeak.set).toHaveBeenCalledWith(
        SPIKE.arrayBuffers
      );
    });

    it("tracks each bucket independently", () => {
      mockUsage(BASE);
      startProcessMemorySampler();

      mockUsage({ ...BASE, external: 5000 });
      vi.advanceTimersByTime(1000);
      mockUsage({ ...BASE, heapUsed: 2500 });
      vi.advanceTimersByTime(1000);

      updateProcessMemoryGauges();

      expect(processMemoryMetrics.externalPeak.set).toHaveBeenCalledWith(5000);
      expect(processMemoryMetrics.heapUsedPeak.set).toHaveBeenCalledWith(2500);
      expect(processMemoryMetrics.rssPeak.set).toHaveBeenCalledWith(BASE.rss);
    });

    it("opens a new window on each export so an old spike does not persist", () => {
      mockUsage(BASE);
      startProcessMemorySampler();

      mockUsage(SPIKE);
      vi.advanceTimersByTime(1000);
      mockUsage(BASE);
      updateProcessMemoryGauges();

      expect(processMemoryMetrics.rssPeak.set).toHaveBeenLastCalledWith(
        SPIKE.rss
      );

      vi.advanceTimersByTime(2000);
      updateProcessMemoryGauges();

      expect(processMemoryMetrics.rssPeak.set).toHaveBeenLastCalledWith(
        BASE.rss
      );
    });

    it("never reports a peak below the instantaneous reading", () => {
      mockUsage(BASE);
      startProcessMemorySampler();
      updateProcessMemoryGauges();

      // No tick has run in the new window yet.
      mockUsage(SPIKE);
      updateProcessMemoryGauges();

      expect(processMemoryMetrics.rss.set).toHaveBeenLastCalledWith(SPIKE.rss);
      expect(processMemoryMetrics.rssPeak.set).toHaveBeenLastCalledWith(
        SPIKE.rss
      );
    });

    it("exports without a running sampler", () => {
      mockUsage(BASE);

      updateProcessMemoryGauges();

      expect(processMemoryMetrics.rss.set).toHaveBeenCalledWith(BASE.rss);
      expect(processMemoryMetrics.rssPeak.set).toHaveBeenCalledWith(BASE.rss);
    });
  });

  describe("threshold logging", () => {
    it("writes one line when the container crosses the threshold", () => {
      mockUsage(SPIKE);
      cgroupAt(0.8);

      sampleProcessMemory();

      expect(logWarn).toHaveBeenCalledTimes(1);
      const [message, labels] = logWarn.mock.calls[0];
      expect(message).toContain("crossed the alert threshold");
      expect(labels.container_used_percent).toBe("80.0");
      // The bucket split is the point: the cgroup number alone cannot say
      // which part of the process grew.
      expect(labels.array_buffers_mib).toBe(
        String(Math.round(2400 / 1_048_576))
      );
      expect(labels.rss_mib).toBeDefined();
      expect(labels.heap_used_mib).toBeDefined();
      expect(labels.external_mib).toBeDefined();
    });

    it("does not repeat while the container stays above the threshold", () => {
      mockUsage(SPIKE);
      cgroupAt(0.8);
      startProcessMemorySampler();

      vi.advanceTimersByTime(10_000);

      expect(logWarn).toHaveBeenCalledTimes(1);
    });

    it("stays latched in the hysteresis band", () => {
      mockUsage(SPIKE);
      cgroupAt(0.8);
      sampleProcessMemory();
      logWarn.mockClear();

      // Below the threshold but above the re-arm level.
      cgroupAt(0.7);
      sampleProcessMemory();

      expect(logWarn).not.toHaveBeenCalled();
    });

    it("re-arms after dropping below the re-arm level, and can fire again", () => {
      mockUsage(SPIKE);
      cgroupAt(0.8);
      sampleProcessMemory();
      expect(logWarn).toHaveBeenCalledTimes(1);

      cgroupAt(0.5);
      sampleProcessMemory();
      expect(logWarn).toHaveBeenCalledTimes(2);
      expect(logWarn.mock.calls[1][0]).toContain(
        "returned below the threshold"
      );

      cgroupAt(0.9);
      sampleProcessMemory();
      expect(logWarn).toHaveBeenCalledTimes(3);
      expect(logWarn.mock.calls[2][0]).toContain("crossed the alert threshold");
    });

    it("stays silent below the threshold", () => {
      mockUsage(BASE);
      cgroupAt(0.3);
      startProcessMemorySampler();

      vi.advanceTimersByTime(10_000);

      expect(logWarn).not.toHaveBeenCalled();
    });

    it("stays silent when there is no cgroup limit to compare against", () => {
      mockUsage(SPIKE);
      cgroup.readCgroupMemory.mockReturnValue({
        current: 5_000_000_000,
        peak: 5_000_000_000,
        limit: null,
      });

      sampleProcessMemory();

      expect(logWarn).not.toHaveBeenCalled();
    });

    it("samples normally when the cgroup is unreadable", () => {
      mockUsage(BASE);
      cgroup.readCgroupMemory.mockReturnValue(null);
      startProcessMemorySampler();

      mockUsage(SPIKE);
      vi.advanceTimersByTime(1000);
      mockUsage(BASE);
      updateProcessMemoryGauges();

      expect(logWarn).not.toHaveBeenCalled();
      expect(processMemoryMetrics.rssPeak.set).toHaveBeenCalledWith(SPIKE.rss);
      expect(processMemoryMetrics.cgroupCurrent.set).not.toHaveBeenCalled();
    });
  });

  describe("cgroup gauges", () => {
    it("publishes current, peak, limit and oom kills", () => {
      mockUsage(BASE);
      cgroup.readCgroupMemory.mockReturnValue({
        current: 1000,
        peak: 3500,
        limit: LIMIT,
      });
      cgroup.readCgroupOomKills.mockReturnValue(2);

      updateProcessMemoryGauges();

      expect(processMemoryMetrics.cgroupCurrent.set).toHaveBeenCalledWith(1000);
      expect(processMemoryMetrics.cgroupPeak.set).toHaveBeenCalledWith(3500);
      expect(processMemoryMetrics.cgroupLimit.set).toHaveBeenCalledWith(LIMIT);
      expect(processMemoryMetrics.cgroupOomKills.set).toHaveBeenCalledWith(2);
    });

    it("skips the peak and limit gauges when the kernel does not expose them", () => {
      mockUsage(BASE);
      cgroup.readCgroupMemory.mockReturnValue({
        current: 1000,
        peak: null,
        limit: null,
      });

      updateProcessMemoryGauges();

      expect(processMemoryMetrics.cgroupCurrent.set).toHaveBeenCalledWith(1000);
      expect(processMemoryMetrics.cgroupPeak.set).not.toHaveBeenCalled();
      expect(processMemoryMetrics.cgroupLimit.set).not.toHaveBeenCalled();
    });
  });

  describe("sampler lifecycle", () => {
    it("starts one timer no matter how many scrapes call it", () => {
      mockUsage(BASE);
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

      startProcessMemorySampler();
      startProcessMemorySampler();
      startProcessMemorySampler();

      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    });

    it("unrefs the timer so it cannot hold the process open", () => {
      mockUsage(BASE);
      startProcessMemorySampler();
      const unref = vi.fn();
      const setIntervalSpy = vi
        .spyOn(globalThis, "setInterval")
        .mockReturnValue({ unref } as unknown as NodeJS.Timeout);

      stopProcessMemorySampler();
      startProcessMemorySampler();

      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      expect(unref).toHaveBeenCalledTimes(1);
    });

    it("drops the running peak when stopped", () => {
      mockUsage(BASE);
      startProcessMemorySampler();
      mockUsage(SPIKE);
      sampleProcessMemory();

      stopProcessMemorySampler();

      mockUsage(BASE);
      updateProcessMemoryGauges();

      expect(processMemoryMetrics.rssPeak.set).toHaveBeenCalledWith(BASE.rss);
    });

    it("stops sampling after stopProcessMemorySampler", () => {
      mockUsage(BASE);
      startProcessMemorySampler();
      stopProcessMemorySampler();

      mockUsage(SPIKE);
      vi.advanceTimersByTime(5000);
      mockUsage(BASE);
      updateProcessMemoryGauges();

      expect(processMemoryMetrics.rssPeak.set).toHaveBeenCalledWith(BASE.rss);
    });
  });
});
