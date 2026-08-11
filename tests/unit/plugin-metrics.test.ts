import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMetricsCollector, setMetricsCollector } from "@/lib/metrics";
import {
  recordPluginMetrics,
  withPluginMetrics,
} from "@/lib/metrics/instrumentation/plugin";
import { MetricNames, type MetricsCollector } from "@/lib/metrics/types";
import { createMockMetricsCollector } from "../mocks/metrics";

describe("Plugin Metrics Instrumentation", () => {
  let mockCollector: MetricsCollector;

  beforeEach(() => {
    vi.clearAllMocks();
    resetMetricsCollector();

    mockCollector = createMockMetricsCollector();
    setMetricsCollector(mockCollector);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetMetricsCollector();
  });

  describe("recordPluginMetrics", () => {
    it("should record successful plugin action", () => {
      recordPluginMetrics({
        pluginName: "discord",
        actionName: "send-message",
        executionId: "exec_123",
        durationMs: 150,
        success: true,
      });

      expect(mockCollector.recordLatency).toHaveBeenCalledWith(
        MetricNames.PLUGIN_ACTION_DURATION,
        150,
        expect.objectContaining({
          plugin_name: "discord",
          action_name: "send-message",
          status: "success",
        })
      );
      expect(mockCollector.recordError).not.toHaveBeenCalled();
    });

    it("should record failed plugin action with error", () => {
      recordPluginMetrics({
        pluginName: "sendgrid",
        actionName: "send-email",
        durationMs: 500,
        success: false,
        error: "Invalid API key",
      });

      expect(mockCollector.recordLatency).toHaveBeenCalledWith(
        MetricNames.PLUGIN_ACTION_DURATION,
        500,
        expect.objectContaining({
          plugin_name: "sendgrid",
          action_name: "send-email",
          status: "failure",
        })
      );
      expect(mockCollector.recordError).toHaveBeenCalledWith(
        MetricNames.PLUGIN_ACTION_ERRORS,
        { message: "Invalid API key" },
        expect.objectContaining({
          plugin_name: "sendgrid",
          action_name: "send-email",
        })
      );
    });
  });

  describe("withPluginMetrics", () => {
    it("should increment counter and record latency on success", async () => {
      const result = await withPluginMetrics(
        { pluginName: "webhook", actionName: "send-webhook" },
        async () => ({ success: true, data: "ok" })
      );

      expect(result).toEqual({ success: true, data: "ok" });
      expect(mockCollector.incrementCounter).toHaveBeenCalledWith(
        MetricNames.PLUGIN_INVOCATIONS_TOTAL,
        expect.objectContaining({
          plugin_name: "webhook",
          action_name: "send-webhook",
        })
      );
      expect(mockCollector.recordLatency).toHaveBeenCalledWith(
        MetricNames.PLUGIN_ACTION_DURATION,
        expect.any(Number),
        expect.objectContaining({
          plugin_name: "webhook",
          action_name: "send-webhook",
          status: "success",
        })
      );
    });

    it("should record failure when result has success: false", async () => {
      const result = await withPluginMetrics(
        { pluginName: "discord", actionName: "send-message" },
        async () => ({ success: false, error: "Webhook URL invalid" })
      );

      expect(result).toEqual({ success: false, error: "Webhook URL invalid" });
      expect(mockCollector.recordLatency).toHaveBeenCalledWith(
        MetricNames.PLUGIN_ACTION_DURATION,
        expect.any(Number),
        expect.objectContaining({
          status: "failure",
        })
      );
      expect(mockCollector.recordError).toHaveBeenCalledWith(
        MetricNames.PLUGIN_ACTION_ERRORS,
        { message: "Webhook URL invalid" },
        expect.any(Object)
      );
    });

    it("should record error and rethrow on exception", async () => {
      const testError = new Error("Connection failed");

      await expect(
        withPluginMetrics(
          { pluginName: "sendgrid", actionName: "send-email" },
          () => Promise.reject(testError)
        )
      ).rejects.toThrow("Connection failed");

      expect(mockCollector.recordLatency).toHaveBeenCalledWith(
        MetricNames.PLUGIN_ACTION_DURATION,
        expect.any(Number),
        expect.objectContaining({
          status: "failure",
        })
      );
      expect(mockCollector.recordError).toHaveBeenCalledWith(
        MetricNames.PLUGIN_ACTION_ERRORS,
        testError,
        expect.any(Object)
      );
    });
  });
});
