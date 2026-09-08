/**
 * Process Memory Instrumentation
 *
 * Tracks Node.js process memory and the container's cgroup accounting, and
 * exposes both as per-pod gauges.
 *
 * Why a sampler rather than a plain read at scrape time: prod containers have
 * been OOM-killed between two consecutive cadvisor samples, which are 60s
 * apart. A gauge read only when Prometheus scrapes has the same blind spot at
 * its own 30s interval - the allocation that crosses the limit starts and ends
 * inside one gap, so nothing records it. This module samples every second and
 * keeps a high-water mark, so a spike that lasts a few seconds still reaches
 * the scrape that follows it.
 *
 * The per-bucket peaks are still sampled and can still miss a spike shorter
 * than the interval. The cgroup peak cannot: the kernel maintains it
 * continuously. Read the cgroup peak for "how close did this container get to
 * its limit" and the buckets for "which part of the process grew".
 *
 * Neither survives the process. A container killed mid-burst never reaches the
 * scrape that would have carried its window, so a threshold crossing also
 * writes one log line. That line is shipped as it is written and outlives the
 * kill, which is the only signal available for a burst that turns out to be
 * fatal.
 *
 * Started lazily on the first /api/metrics/api scrape, the same way
 * startRpcHealthProbe() is.
 */

import "server-only";

import { logWarn } from "@/lib/logging";
import { readCgroupMemory, readCgroupOomKills } from "../cgroup-memory";
import { processMemoryMetrics } from "../collectors/prometheus";

const SAMPLE_INTERVAL_MS = 1000;

// Fraction of the cgroup limit that arms a log line, and the lower fraction
// that re-arms it. The gap is what stops a container sitting just above the
// line from logging every second. 0.75 sits above every non-fatal excursion
// observed so far (the worst reached about 0.78 of the old 4Gi limit, which is
// 0.52 of the new one), so a crossing means a genuinely unusual burst.
const LOG_THRESHOLD_FRACTION = 0.75;
const LOG_REARM_FRACTION = 0.65;

type MemoryPeak = {
  rss: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
};

// Hot-reload safe: keep the timer, the running peak and the latch on
// globalThis so a dev restart does not spawn a second sampler, lose the
// window, or re-fire a log line that already went out.
const globalForMemory = globalThis as unknown as {
  processMemoryTimer: ReturnType<typeof setInterval> | undefined;
  processMemoryPeak: MemoryPeak | undefined;
  processMemoryLogArmed: boolean | undefined;
};

function readUsage(): MemoryPeak {
  const usage = process.memoryUsage();
  return {
    rss: usage.rss,
    heapUsed: usage.heapUsed,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
  };
}

function mergePeak(
  peak: MemoryPeak | undefined,
  sample: MemoryPeak
): MemoryPeak {
  if (!peak) {
    return sample;
  }
  return {
    rss: Math.max(peak.rss, sample.rss),
    heapUsed: Math.max(peak.heapUsed, sample.heapUsed),
    external: Math.max(peak.external, sample.external),
    arrayBuffers: Math.max(peak.arrayBuffers, sample.arrayBuffers),
  };
}

function mib(bytes: number): string {
  return String(Math.round(bytes / 1024 / 1024));
}

/**
 * Write one line when the container crosses the threshold, and stay quiet
 * until it has dropped back below the re-arm level.
 *
 * The line carries the bucket split, because the bucket that grew is the whole
 * question and the cgroup number alone cannot answer it. Anything read here is
 * already in hand, so the line costs one formatted string.
 */
function checkLogThreshold(usage: MemoryPeak, current: number, limit: number) {
  const armed = globalForMemory.processMemoryLogArmed ?? true;
  const fraction = current / limit;

  if (armed && fraction >= LOG_THRESHOLD_FRACTION) {
    globalForMemory.processMemoryLogArmed = false;
    logWarn("[ProcessMemory] Container memory crossed the alert threshold", {
      container_current_mib: mib(current),
      container_limit_mib: mib(limit),
      container_used_percent: (fraction * 100).toFixed(1),
      rss_mib: mib(usage.rss),
      heap_used_mib: mib(usage.heapUsed),
      external_mib: mib(usage.external),
      array_buffers_mib: mib(usage.arrayBuffers),
    });
    return;
  }

  if (!armed && fraction < LOG_REARM_FRACTION) {
    globalForMemory.processMemoryLogArmed = true;
    logWarn("[ProcessMemory] Container memory returned below the threshold", {
      container_current_mib: mib(current),
      container_limit_mib: mib(limit),
      container_used_percent: (fraction * 100).toFixed(1),
    });
  }
}

/**
 * Take one sample, fold it into the running peak, and log a threshold
 * crossing. Never throws: a failure here would take down the scrape path.
 */
export function sampleProcessMemory(): void {
  const usage = readUsage();
  globalForMemory.processMemoryPeak = mergePeak(
    globalForMemory.processMemoryPeak,
    usage
  );

  const cgroup = readCgroupMemory();
  if (cgroup?.limit) {
    checkLogThreshold(usage, cgroup.current, cgroup.limit);
  }
}

/**
 * Start the 1s sampler. Idempotent, so repeated scrapes do not stack timers.
 * The timer is unref'd, so it never keeps the process alive on its own.
 */
export function startProcessMemorySampler(): void {
  if (globalForMemory.processMemoryTimer !== undefined) {
    return;
  }

  sampleProcessMemory();
  globalForMemory.processMemoryTimer = setInterval(
    sampleProcessMemory,
    SAMPLE_INTERVAL_MS
  );
  globalForMemory.processMemoryTimer.unref();
}

/**
 * Stop the sampler and drop the running peak and the latch. Used by tests.
 */
export function stopProcessMemorySampler(): void {
  if (globalForMemory.processMemoryTimer !== undefined) {
    clearInterval(globalForMemory.processMemoryTimer);
    globalForMemory.processMemoryTimer = undefined;
  }
  globalForMemory.processMemoryPeak = undefined;
  globalForMemory.processMemoryLogArmed = undefined;
}

/**
 * Publish the current reading and the peak of the window that just ended, then
 * open a new window.
 *
 * The new window is seeded with the reading taken here rather than with zero,
 * so the peak gauges never report below the instantaneous ones when a scrape
 * lands before the first tick of the next window.
 */
export function updateProcessMemoryGauges(): void {
  const current = readUsage();
  const peak = mergePeak(globalForMemory.processMemoryPeak, current);

  processMemoryMetrics.rss.set(current.rss);
  processMemoryMetrics.heapUsed.set(current.heapUsed);
  processMemoryMetrics.external.set(current.external);
  processMemoryMetrics.arrayBuffers.set(current.arrayBuffers);

  processMemoryMetrics.rssPeak.set(peak.rss);
  processMemoryMetrics.heapUsedPeak.set(peak.heapUsed);
  processMemoryMetrics.externalPeak.set(peak.external);
  processMemoryMetrics.arrayBuffersPeak.set(peak.arrayBuffers);

  globalForMemory.processMemoryPeak = current;

  const cgroup = readCgroupMemory();
  if (cgroup) {
    processMemoryMetrics.cgroupCurrent.set(cgroup.current);
    if (cgroup.peak !== null) {
      processMemoryMetrics.cgroupPeak.set(cgroup.peak);
    }
    if (cgroup.limit !== null) {
      processMemoryMetrics.cgroupLimit.set(cgroup.limit);
    }
  }

  const oomKills = readCgroupOomKills();
  if (oomKills !== null) {
    processMemoryMetrics.cgroupOomKills.set(oomKills);
  }
}
