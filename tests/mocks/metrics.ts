import { vi } from "vitest";
import type { MetricsCollector } from "@/lib/metrics/types";

/**
 * Build a fully-stubbed MetricsCollector with vi.fn() for every method.
 * Adding a new method to MetricsCollector requires updating one place
 * (here) instead of every test file that constructs an inline mock.
 */
export function createMockMetricsCollector(): MetricsCollector {
  return {
    recordLatency: vi.fn(),
    incrementCounter: vi.fn(),
    recordError: vi.fn(),
    recordWarning: vi.fn(),
    setGauge: vi.fn(),
  };
}
