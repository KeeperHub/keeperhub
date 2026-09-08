import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMetricsCollector, setMetricsCollector } from "@/lib/metrics";
import {
  decrementConcurrentExecutions,
  getConcurrentExecutions,
  incrementConcurrentExecutions,
  recordDbPoolUtilization,
  recordQueueDepth,
  recordSlowQuery,
  resetConcurrentExecutions,
  withConcurrentTracking,
} from "@/lib/metrics/instrumentation/saturation";
import { MetricNames, type MetricsCollector } from "@/lib/metrics/types";
import { createMockMetricsCollector } from "../mocks/metrics";

describe("Saturation Metrics Instrumentation", () => {
  let mockCollector: MetricsCollector;

  beforeEach(() => {
    vi.clearAllMocks();
    resetMetricsCollector();
    resetConcurrentExecutions();

    mockCollector = createMockMetricsCollector();
    setMetricsCollector(mockCollector);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetMetricsCollector();
    resetConcurrentExecutions();
  });

  describe("Concurrent Execution Tracking", () => {
    it("should start with zero concurrent executions", () => {
      expect(getConcurrentExecutions()).toBe(0);
    });

    it("should increment concurrent executions and emit gauge", () => {
      incrementConcurrentExecutions();

      expect(getConcurrentExecutions()).toBe(1);
      expect(mockCollector.setGauge).toHaveBeenCalledWith(
        MetricNames.WORKFLOW_CONCURRENT_COUNT,
        1
      );
    });

    it("should decrement concurrent executions and emit gauge", () => {
      incrementConcurrentExecutions();
      incrementConcurrentExecutions();
      decrementConcurrentExecutions();

      expect(getConcurrentExecutions()).toBe(1);
      expect(mockCollector.setGauge).toHaveBeenLastCalledWith(
        MetricNames.WORKFLOW_CONCURRENT_COUNT,
        1
      );
    });

    it("should not go below zero", () => {
      decrementConcurrentExecutions();
      decrementConcurrentExecutions();

      expect(getConcurrentExecutions()).toBe(0);
      expect(mockCollector.setGauge).toHaveBeenCalledWith(
        MetricNames.WORKFLOW_CONCURRENT_COUNT,
        0
      );
    });

    it("should reset concurrent executions", () => {
      incrementConcurrentExecutions();
      incrementConcurrentExecutions();
      incrementConcurrentExecutions();
      resetConcurrentExecutions();

      expect(getConcurrentExecutions()).toBe(0);
    });

    it("should track multiple concurrent executions", () => {
      incrementConcurrentExecutions();
      incrementConcurrentExecutions();
      incrementConcurrentExecutions();

      expect(getConcurrentExecutions()).toBe(3);
      expect(mockCollector.setGauge).toHaveBeenLastCalledWith(
        MetricNames.WORKFLOW_CONCURRENT_COUNT,
        3
      );
    });
  });

  describe("withConcurrentTracking", () => {
    it("should increment before and decrement after execution", async () => {
      let duringExecution = 0;

      await withConcurrentTracking(() => {
        duringExecution = getConcurrentExecutions();
        return Promise.resolve("result");
      });

      expect(duringExecution).toBe(1);
      expect(getConcurrentExecutions()).toBe(0);
    });

    it("should return the result of the function", async () => {
      const result = await withConcurrentTracking(async () => ({
        data: "test",
      }));

      expect(result).toEqual({ data: "test" });
    });

    it("should decrement even when function throws", async () => {
      await expect(
        withConcurrentTracking(() => Promise.reject(new Error("Test error")))
      ).rejects.toThrow("Test error");

      expect(getConcurrentExecutions()).toBe(0);
    });

    it("should track nested concurrent executions", async () => {
      let innerCount = 0;

      await withConcurrentTracking(() =>
        withConcurrentTracking(() => {
          innerCount = getConcurrentExecutions();
          return Promise.resolve();
        })
      );

      expect(innerCount).toBe(2);
      expect(getConcurrentExecutions()).toBe(0);
    });
  });

  describe("recordQueueDepth", () => {
    it("should record queue depth gauge", () => {
      recordQueueDepth(25);

      expect(mockCollector.setGauge).toHaveBeenCalledWith(
        MetricNames.WORKFLOW_QUEUE_DEPTH,
        25
      );
    });

    it("should record zero queue depth", () => {
      recordQueueDepth(0);

      expect(mockCollector.setGauge).toHaveBeenCalledWith(
        MetricNames.WORKFLOW_QUEUE_DEPTH,
        0
      );
    });
  });

  describe("recordDbPoolUtilization", () => {
    it("should calculate and record pool utilization percentage", () => {
      recordDbPoolUtilization({
        activeConnections: 8,
        maxConnections: 10,
      });

      expect(mockCollector.setGauge).toHaveBeenCalledWith(
        MetricNames.DB_POOL_UTILIZATION,
        80,
        {
          active: "8",
          max: "10",
        }
      );
    });

    it("should handle zero max connections", () => {
      recordDbPoolUtilization({
        activeConnections: 5,
        maxConnections: 0,
      });

      expect(mockCollector.setGauge).toHaveBeenCalledWith(
        MetricNames.DB_POOL_UTILIZATION,
        0,
        {
          active: "5",
          max: "0",
        }
      );
    });

    it("should calculate partial utilization", () => {
      recordDbPoolUtilization({
        activeConnections: 3,
        maxConnections: 20,
      });

      expect(mockCollector.setGauge).toHaveBeenCalledWith(
        MetricNames.DB_POOL_UTILIZATION,
        15,
        {
          active: "3",
          max: "20",
        }
      );
    });
  });

  describe("recordSlowQuery", () => {
    it("should record slow queries above threshold", () => {
      recordSlowQuery(150, "SELECT * FROM users");

      expect(mockCollector.incrementCounter).toHaveBeenCalledWith(
        MetricNames.DB_QUERY_SLOW_COUNT,
        {
          threshold: "100ms",
          query_type: "select",
        }
      );
    });

    it("should not record queries below threshold", () => {
      recordSlowQuery(50, "SELECT * FROM users");

      expect(mockCollector.incrementCounter).not.toHaveBeenCalled();
    });

    it("should categorize INSERT queries", () => {
      recordSlowQuery(200, "INSERT INTO users VALUES (1, 'test')");

      expect(mockCollector.incrementCounter).toHaveBeenCalledWith(
        MetricNames.DB_QUERY_SLOW_COUNT,
        {
          threshold: "100ms",
          query_type: "insert",
        }
      );
    });

    it("should categorize UPDATE queries", () => {
      recordSlowQuery(150, "UPDATE users SET name = 'test' WHERE id = 1");

      expect(mockCollector.incrementCounter).toHaveBeenCalledWith(
        MetricNames.DB_QUERY_SLOW_COUNT,
        {
          threshold: "100ms",
          query_type: "update",
        }
      );
    });

    it("should categorize DELETE queries", () => {
      recordSlowQuery(120, "DELETE FROM users WHERE id = 1");

      expect(mockCollector.incrementCounter).toHaveBeenCalledWith(
        MetricNames.DB_QUERY_SLOW_COUNT,
        {
          threshold: "100ms",
          query_type: "delete",
        }
      );
    });

    it("should categorize unknown queries as other", () => {
      recordSlowQuery(110, "TRUNCATE TABLE users");

      expect(mockCollector.incrementCounter).toHaveBeenCalledWith(
        MetricNames.DB_QUERY_SLOW_COUNT,
        {
          threshold: "100ms",
          query_type: "other",
        }
      );
    });

    it("should record slow query without query string", () => {
      recordSlowQuery(150);

      expect(mockCollector.incrementCounter).toHaveBeenCalledWith(
        MetricNames.DB_QUERY_SLOW_COUNT,
        {
          threshold: "100ms",
        }
      );
    });

    it("should handle queries at exactly threshold", () => {
      recordSlowQuery(100, "SELECT 1");

      // 100ms is not > 100ms, so shouldn't be recorded
      expect(mockCollector.incrementCounter).not.toHaveBeenCalled();
    });

    it("should handle queries just above threshold", () => {
      recordSlowQuery(101, "SELECT 1");

      expect(mockCollector.incrementCounter).toHaveBeenCalledWith(
        MetricNames.DB_QUERY_SLOW_COUNT,
        {
          threshold: "100ms",
          query_type: "select",
        }
      );
    });
  });
});
