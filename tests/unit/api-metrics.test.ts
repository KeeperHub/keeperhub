import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getOrgIdentity } from "@/lib/db/org-helpers";
import { resetMetricsCollector, setMetricsCollector } from "@/lib/metrics";
import {
  recordStatusPollMetrics,
  recordWebhookMetrics,
} from "@/lib/metrics/instrumentation/api";
import { MetricNames, type MetricsCollector } from "@/lib/metrics/types";
import { createMockMetricsCollector } from "../mocks/metrics";

vi.mock("@/lib/db/org-helpers", () => ({
  getOrgIdentity: vi.fn(),
}));

describe("API Metrics Instrumentation", () => {
  let mockCollector: MetricsCollector;

  beforeEach(() => {
    vi.clearAllMocks();
    resetMetricsCollector();

    mockCollector = createMockMetricsCollector();
    setMetricsCollector(mockCollector);

    vi.mocked(getOrgIdentity).mockResolvedValue({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetMetricsCollector();
  });

  describe("recordWebhookMetrics", () => {
    it("should record successful webhook trigger", async () => {
      await recordWebhookMetrics({
        workflowId: "wf_123",
        executionId: "exec_456",
        durationMs: 45,
        statusCode: 200,
      });

      expect(mockCollector.recordLatency).toHaveBeenCalledWith(
        MetricNames.API_WEBHOOK_LATENCY,
        45,
        expect.objectContaining({
          status_code: "200",
          status: "success",
        })
      );

      expect(mockCollector.recordError).not.toHaveBeenCalled();
    });

    it("should record failed webhook trigger with error", async () => {
      await recordWebhookMetrics({
        workflowId: "wf_123",
        durationMs: 100,
        statusCode: 401,
        error: "Invalid API key",
      });

      expect(mockCollector.recordLatency).toHaveBeenCalledWith(
        MetricNames.API_WEBHOOK_LATENCY,
        100,
        expect.objectContaining({
          status_code: "401",
          status: "failure",
        })
      );

      expect(mockCollector.recordError).toHaveBeenCalledWith(
        MetricNames.API_ERRORS_TOTAL,
        { message: "Invalid API key" },
        expect.objectContaining({
          endpoint: "webhook",
          status_code: "401",
        })
      );
    });

    it("should resolve and attach org labels when organizationId provided", async () => {
      vi.mocked(getOrgIdentity).mockResolvedValueOnce({
        slug: "acme-corp",
        name: "Acme Corp",
      });

      await recordWebhookMetrics({
        workflowId: "wf_123",
        durationMs: 100,
        statusCode: 429,
        error: "Execution limit reached",
        organizationId: "org_abc",
      });

      expect(getOrgIdentity).toHaveBeenCalledWith("org_abc");
      expect(mockCollector.recordError).toHaveBeenCalledWith(
        MetricNames.API_ERRORS_TOTAL,
        { message: "Execution limit reached" },
        expect.objectContaining({
          endpoint: "webhook",
          status_code: "429",
          org_id: "org_abc",
          org_slug: "acme-corp",
          org_name: "Acme Corp",
        })
      );
    });

    it("should omit org labels and skip lookup when organizationId not provided", async () => {
      await recordWebhookMetrics({
        workflowId: "wf_123",
        durationMs: 100,
        statusCode: 401,
        error: "Invalid API key",
      });

      expect(getOrgIdentity).not.toHaveBeenCalled();
      const labels = (mockCollector.recordError as ReturnType<typeof vi.fn>)
        .mock.calls[0][2];
      expect(labels).not.toHaveProperty("org_id");
      expect(labels).not.toHaveProperty("org_slug");
      expect(labels).not.toHaveProperty("org_name");
    });

    it("should attach only org_id when identity lookup yields nothing", async () => {
      vi.mocked(getOrgIdentity).mockResolvedValueOnce({});

      await recordWebhookMetrics({
        workflowId: "wf_123",
        durationMs: 100,
        statusCode: 429,
        error: "Execution limit reached",
        organizationId: "org_abc",
      });

      const labels = (mockCollector.recordError as ReturnType<typeof vi.fn>)
        .mock.calls[0][2];
      expect(labels).toMatchObject({
        endpoint: "webhook",
        status_code: "429",
        org_id: "org_abc",
      });
      expect(labels).not.toHaveProperty("org_slug");
      expect(labels).not.toHaveProperty("org_name");
    });
  });

  describe("recordStatusPollMetrics", () => {
    it("should record successful status poll", () => {
      recordStatusPollMetrics({
        executionId: "exec_123",
        durationMs: 25,
        statusCode: 200,
        executionStatus: "running",
      });

      expect(mockCollector.recordLatency).toHaveBeenCalledWith(
        MetricNames.API_STATUS_LATENCY,
        25,
        expect.objectContaining({
          status_code: "200",
          status: "success",
          execution_status: "running",
        })
      );
    });

    it("should record failed status poll", () => {
      recordStatusPollMetrics({
        executionId: "exec_123",
        durationMs: 50,
        statusCode: 500,
      });

      expect(mockCollector.recordLatency).toHaveBeenCalledWith(
        MetricNames.API_STATUS_LATENCY,
        50,
        expect.objectContaining({
          status_code: "500",
          status: "failure",
        })
      );
    });

    it("should use 'unknown' for missing executionStatus", () => {
      recordStatusPollMetrics({
        executionId: "exec_123",
        durationMs: 20,
        statusCode: 200,
      });

      const labels = (mockCollector.recordLatency as ReturnType<typeof vi.fn>)
        .mock.calls[0][2];
      expect(labels.execution_status).toBe("unknown");
    });
  });
});
