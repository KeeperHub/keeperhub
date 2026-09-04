import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rawConsole } from "@/lib/log/core";
import {
  ErrorCategory,
  logSystemError,
  logSystemWarn,
  logUserError,
} from "@/lib/logging";
import { resetMetricsCollector, setMetricsCollector } from "@/lib/metrics";
import {
  LabelKeys,
  MetricNames,
  type MetricsCollector,
} from "@/lib/metrics/types";
import { createMockMetricsCollector } from "../mocks/metrics";

// The structured logger writes via lib/log/core's rawConsole (the original
// console methods bound at module load), so spies must target rawConsole, not
// the global console (which the facade would patch in a real runtime).
const raw = rawConsole as unknown as Record<
  "debug" | "info" | "warn" | "error",
  (line: string) => void
>;

describe("Unified Logging Helpers", () => {
  let mockCollector: MetricsCollector;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  const originalLevel = process.env.LOG_LEVEL;

  beforeEach(() => {
    vi.clearAllMocks();
    resetMetricsCollector();
    // Make console emission deterministic regardless of ambient LOG_LEVEL.
    process.env.LOG_LEVEL = "debug";

    mockCollector = createMockMetricsCollector();
    setMetricsCollector(mockCollector);

    // Spy on the canonical sink (rawConsole), not the global console.
    consoleWarnSpy = vi.spyOn(raw, "warn").mockImplementation(() => {
      // noop - suppress console output
    });
    consoleErrorSpy = vi.spyOn(raw, "error").mockImplementation(() => {
      // noop - suppress console output
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetMetricsCollector();
    process.env.LOG_LEVEL = originalLevel;
  });

  // KEEP-545: log helpers now emit a single structured JSON line so Grafana
  // Cloud Loki can index `error_type`, `error_category`, `execution_id`,
  // and `org_slug` via `| json`. This helper parses the JSON arg and returns
  // the payload so per-test assertions can check fields without coupling to
  // the on-the-wire serialization order.
  function lastJsonLine(
    spy: ReturnType<typeof vi.spyOn>
  ): Record<string, unknown> {
    const last = spy.mock.calls.at(-1);
    if (last?.length !== 1) {
      throw new Error(
        `expected exactly one structured log arg, got ${JSON.stringify(spy.mock.calls)}`
      );
    }
    return JSON.parse(last[0] as string) as Record<string, unknown>;
  }

  describe("logUserError", () => {
    it("should log as warning JSON and emit metric", () => {
      logUserError(
        ErrorCategory.VALIDATION,
        "[Test] Invalid input",
        "details",
        { foo: "bar" }
      );

      const line = lastJsonLine(consoleWarnSpy);
      expect(line.level).toBe("warn");
      expect(line.msg).toBe("[Test] Invalid input");
      expect(line.error_type).toBe("user");
      expect(line.error_category).toBe(ErrorCategory.VALIDATION);
      expect(line.error_context).toBe("Test");
      expect(line.foo).toBe("bar");
      expect(line.err).toEqual({ message: "details" });
      expect(consoleErrorSpy).not.toHaveBeenCalled();

      expect(mockCollector.recordError).toHaveBeenCalledWith(
        MetricNames.USER_VALIDATION_ERRORS,
        { message: "[Test] Invalid input" },
        expect.objectContaining({
          [LabelKeys.ERROR_CATEGORY]: ErrorCategory.VALIDATION,
          [LabelKeys.ERROR_CONTEXT]: "Test",
          [LabelKeys.ERROR_TYPE]: "user",
          foo: "bar",
        })
      );
    });

    it("should serialize Error objects to err.message and stack", () => {
      const error = new Error("Test error");
      logUserError(ErrorCategory.VALIDATION, "[Context] Error occurred", error);

      const line = lastJsonLine(consoleWarnSpy);
      expect(line.msg).toBe("[Context] Error occurred");
      expect(line.err).toMatchObject({ message: "Test error", name: "Error" });
      expect(mockCollector.recordError).toHaveBeenCalledWith(
        MetricNames.USER_VALIDATION_ERRORS,
        error,
        expect.objectContaining({
          [LabelKeys.ERROR_CATEGORY]: ErrorCategory.VALIDATION,
          [LabelKeys.ERROR_CONTEXT]: "Context",
          [LabelKeys.ERROR_TYPE]: "user",
        })
      );
    });

    it("should omit `err` when no error detail is passed", () => {
      logUserError(ErrorCategory.VALIDATION, "[Test] Simple warning");

      const line = lastJsonLine(consoleWarnSpy);
      expect(line.msg).toBe("[Test] Simple warning");
      expect(line.err).toBeUndefined();
      expect(mockCollector.recordError).toHaveBeenCalledWith(
        MetricNames.USER_VALIDATION_ERRORS,
        { message: "[Test] Simple warning" },
        expect.objectContaining({
          [LabelKeys.ERROR_TYPE]: "user",
        })
      );
    });

    it("should extract context from message prefix", () => {
      logUserError(ErrorCategory.VALIDATION, "[Discord Bot] Invalid token");

      expect(mockCollector.recordError).toHaveBeenCalledWith(
        MetricNames.USER_VALIDATION_ERRORS,
        expect.anything(),
        expect.objectContaining({
          [LabelKeys.ERROR_CONTEXT]: "Discord Bot",
        })
      );
    });

    it("should use Unknown context when prefix is missing", () => {
      logUserError(ErrorCategory.VALIDATION, "No prefix message");

      expect(mockCollector.recordError).toHaveBeenCalledWith(
        MetricNames.USER_VALIDATION_ERRORS,
        expect.anything(),
        expect.objectContaining({
          [LabelKeys.ERROR_CONTEXT]: "Unknown",
        })
      );
    });

    it("should map to correct metric for each user error category", () => {
      const categories = [
        {
          category: ErrorCategory.VALIDATION,
          metric: MetricNames.USER_VALIDATION_ERRORS,
        },
        {
          category: ErrorCategory.CONFIGURATION,
          metric: MetricNames.USER_CONFIGURATION_ERRORS,
        },
        {
          category: ErrorCategory.AUTHORIZATION,
          metric: MetricNames.USER_AUTHORIZATION_ERRORS,
        },
        {
          category: ErrorCategory.EXTERNAL_SERVICE,
          metric: MetricNames.EXTERNAL_SERVICE_ERRORS,
        },
        {
          category: ErrorCategory.NETWORK_RPC,
          metric: MetricNames.NETWORK_RPC_ERRORS,
        },
        {
          category: ErrorCategory.TRANSACTION,
          metric: MetricNames.TRANSACTION_BLOCKCHAIN_ERRORS,
        },
      ];

      for (const { category, metric } of categories) {
        vi.clearAllMocks();
        logUserError(category, "[Test] Error", "details");

        expect(mockCollector.recordError).toHaveBeenCalledWith(
          metric,
          expect.anything(),
          expect.anything()
        );
      }
    });
  });

  describe("logSystemError", () => {
    it("should log as structured error JSON and emit metric", () => {
      const error = new Error("System failure");
      logSystemError(ErrorCategory.DATABASE, "[DB] Connection failed", error, {
        table: "workflows",
      });

      const line = lastJsonLine(consoleErrorSpy);
      expect(line.level).toBe("error");
      expect(line.msg).toBe("[DB] Connection failed");
      expect(line.error_type).toBe("system");
      expect(line.error_category).toBe(ErrorCategory.DATABASE);
      expect(line.error_context).toBe("DB");
      expect(line.table).toBe("workflows");
      expect(line.err).toMatchObject({
        message: "System failure",
        name: "Error",
      });
      expect(consoleWarnSpy).not.toHaveBeenCalled();

      expect(mockCollector.recordError).toHaveBeenCalledWith(
        MetricNames.SYSTEM_DATABASE_ERRORS,
        error,
        expect.objectContaining({
          [LabelKeys.ERROR_CATEGORY]: ErrorCategory.DATABASE,
          [LabelKeys.ERROR_CONTEXT]: "DB",
          [LabelKeys.ERROR_TYPE]: "system",
          table: "workflows",
        })
      );
    });

    it("should convert non-Error objects to string", () => {
      logSystemError(ErrorCategory.DATABASE, "[DB] Error", "string error");

      expect(mockCollector.recordError).toHaveBeenCalledWith(
        MetricNames.SYSTEM_DATABASE_ERRORS,
        { message: "string error" },
        expect.anything()
      );
    });

    it("should map to correct metric for each system error category", () => {
      const categories = [
        {
          category: ErrorCategory.DATABASE,
          metric: MetricNames.SYSTEM_DATABASE_ERRORS,
        },
        {
          category: ErrorCategory.AUTH,
          metric: MetricNames.SYSTEM_AUTH_ERRORS,
        },
        {
          category: ErrorCategory.INFRASTRUCTURE,
          metric: MetricNames.SYSTEM_INFRASTRUCTURE_ERRORS,
        },
        {
          category: ErrorCategory.WORKFLOW_ENGINE,
          metric: MetricNames.SYSTEM_WORKFLOW_ENGINE_ERRORS,
        },
      ];

      for (const { category, metric } of categories) {
        vi.clearAllMocks();
        const error = new Error("Test");
        logSystemError(category, "[Test] Error", error);

        expect(mockCollector.recordError).toHaveBeenCalledWith(
          metric,
          error,
          expect.anything()
        );
      }
    });

    it("should fallback to API_ERRORS_TOTAL for unknown category", () => {
      logSystemError(
        ErrorCategory.UNKNOWN,
        "[Unknown] Error",
        new Error("test")
      );

      expect(mockCollector.recordError).toHaveBeenCalledWith(
        MetricNames.API_ERRORS_TOTAL,
        expect.anything(),
        expect.anything()
      );
    });
  });

  describe("logSystemWarn", () => {
    it("should log as warn JSON and NOT emit any metric", () => {
      const error = new Error("Spurious SDK error");
      logSystemWarn(
        ErrorCategory.WORKFLOW_ENGINE,
        "[Workflow Logging] Pre-reconciliation",
        error,
        { execution_id: "exec-123" }
      );

      const line = lastJsonLine(consoleWarnSpy);
      expect(line.level).toBe("warn");
      expect(line.msg).toBe(
        "[Workflow Logging] Pre-reconciliation [exec:exec-123]"
      );
      expect(line.error_category).toBe(ErrorCategory.WORKFLOW_ENGINE);
      expect(line.error_context).toBe("Workflow Logging");
      // error_type intentionally not set on logSystemWarn so alerts
      // filtering on error_type="system" don't match these events.
      expect(line.error_type).toBeUndefined();
      expect(line.execution_id).toBe("exec-123");
      expect(consoleErrorSpy).not.toHaveBeenCalled();

      // Key invariant: warn helper does not increment ANY metric counter,
      // so it cannot trip system-error or user-error dashboards.
      expect(mockCollector.recordError).not.toHaveBeenCalled();
    });

    it("should handle non-Error error values", () => {
      logSystemWarn(
        ErrorCategory.WORKFLOW_ENGINE,
        "[Test] Warn",
        "string detail"
      );

      const line = lastJsonLine(consoleWarnSpy);
      expect(line.msg).toBe("[Test] Warn");
      expect(line.err).toEqual({ message: "string detail" });
      expect(mockCollector.recordError).not.toHaveBeenCalled();
    });

    it("should not emit a metric for any error category", () => {
      // Regression guard against accidentally re-introducing metric emission.
      const categories = [
        ErrorCategory.WORKFLOW_ENGINE,
        ErrorCategory.DATABASE,
        ErrorCategory.INFRASTRUCTURE,
        ErrorCategory.UNKNOWN,
      ];

      for (const category of categories) {
        vi.clearAllMocks();
        logSystemWarn(category, "[Test] Warn", new Error("test"));
        expect(mockCollector.recordError).not.toHaveBeenCalled();
      }
    });
  });

  describe("Convenience functions via core logUserError", () => {
    it("should handle validation errors with string details", () => {
      logUserError(
        ErrorCategory.VALIDATION,
        "[Check Balance] Invalid address:",
        "0xINVALID",
        {
          plugin_name: "web3",
          action_name: "check-balance",
        }
      );

      const line = lastJsonLine(consoleWarnSpy);
      expect(line.msg).toBe("[Check Balance] Invalid address:");
      expect(line.err).toEqual({ message: "0xINVALID" });
      expect(line.plugin_name).toBe("web3");
      expect(line.action_name).toBe("check-balance");

      expect(mockCollector.recordError).toHaveBeenCalledWith(
        MetricNames.USER_VALIDATION_ERRORS,
        { message: "[Check Balance] Invalid address:" },
        expect.objectContaining({
          [LabelKeys.ERROR_CATEGORY]: ErrorCategory.VALIDATION,
          [LabelKeys.ERROR_CONTEXT]: "Check Balance",
          [LabelKeys.ERROR_TYPE]: "user",
          plugin_name: "web3",
          action_name: "check-balance",
        })
      );
    });
  });

  describe("Configuration errors via core logUserError", () => {
    it("should use CONFIGURATION category and log as warning", () => {
      logUserError(
        ErrorCategory.CONFIGURATION,
        "[Discord] Missing bot token",
        undefined,
        {
          integration_id: "abc123",
        }
      );

      expect(consoleWarnSpy).toHaveBeenCalled();
      expect(mockCollector.recordError).toHaveBeenCalledWith(
        MetricNames.USER_CONFIGURATION_ERRORS,
        expect.anything(),
        expect.objectContaining({
          [LabelKeys.ERROR_CATEGORY]: ErrorCategory.CONFIGURATION,
          integration_id: "abc123",
        })
      );
    });
  });

  describe("External service errors via core logUserError", () => {
    it("should use EXTERNAL_SERVICE category and log as warning", () => {
      const error = new Error("API timeout");
      logUserError(
        ErrorCategory.EXTERNAL_SERVICE,
        "[Etherscan] Request failed",
        error,
        {
          service: "etherscan",
        }
      );

      expect(consoleWarnSpy).toHaveBeenCalled();
      expect(mockCollector.recordError).toHaveBeenCalledWith(
        MetricNames.EXTERNAL_SERVICE_ERRORS,
        error,
        expect.objectContaining({
          [LabelKeys.ERROR_CATEGORY]: ErrorCategory.EXTERNAL_SERVICE,
          service: "etherscan",
        })
      );
    });
  });

  describe("Network errors via core logUserError", () => {
    it("should use NETWORK_RPC category and log as warning", () => {
      logUserError(
        ErrorCategory.NETWORK_RPC,
        "[RPC] Connection timeout",
        undefined,
        {
          chain_id: "1",
        }
      );

      expect(consoleWarnSpy).toHaveBeenCalled();
      expect(mockCollector.recordError).toHaveBeenCalledWith(
        MetricNames.NETWORK_RPC_ERRORS,
        expect.anything(),
        expect.objectContaining({
          [LabelKeys.ERROR_CATEGORY]: ErrorCategory.NETWORK_RPC,
          chain_id: "1",
        })
      );
    });
  });

  describe("Transaction errors via core logUserError", () => {
    it("should use TRANSACTION category and log as warning", () => {
      const error = new Error("Gas estimation failed");
      logUserError(
        ErrorCategory.TRANSACTION,
        "[Transaction] Failed to send",
        error,
        {
          tx_hash: "0x123",
        }
      );

      expect(consoleWarnSpy).toHaveBeenCalled();
      expect(mockCollector.recordError).toHaveBeenCalledWith(
        MetricNames.TRANSACTION_BLOCKCHAIN_ERRORS,
        error,
        expect.objectContaining({
          [LabelKeys.ERROR_CATEGORY]: ErrorCategory.TRANSACTION,
          tx_hash: "0x123",
        })
      );
    });
  });

  describe("Database errors via core logSystemError", () => {
    it("should use DATABASE category and log as error", () => {
      const error = new Error("Query failed");
      logSystemError(ErrorCategory.DATABASE, "[DB] Insert failed", error, {
        table: "workflows",
      });

      expect(consoleErrorSpy).toHaveBeenCalled();
      expect(consoleWarnSpy).not.toHaveBeenCalled();

      expect(mockCollector.recordError).toHaveBeenCalledWith(
        MetricNames.SYSTEM_DATABASE_ERRORS,
        error,
        expect.objectContaining({
          [LabelKeys.ERROR_CATEGORY]: ErrorCategory.DATABASE,
          [LabelKeys.ERROR_TYPE]: "system",
          table: "workflows",
        })
      );
    });
  });

  describe("Auth errors via core logSystemError", () => {
    it("should use AUTH category and log as error", () => {
      const error = new Error("Session invalid");
      logSystemError(ErrorCategory.AUTH, "[Auth] Verification failed", error, {
        endpoint: "/api/workflows",
      });

      expect(consoleErrorSpy).toHaveBeenCalled();
      expect(mockCollector.recordError).toHaveBeenCalledWith(
        MetricNames.SYSTEM_AUTH_ERRORS,
        error,
        expect.objectContaining({
          [LabelKeys.ERROR_CATEGORY]: ErrorCategory.AUTH,
          [LabelKeys.ERROR_TYPE]: "system",
        })
      );
    });
  });

  describe("Infrastructure errors via core logSystemError", () => {
    it("should use INFRASTRUCTURE category and log as error", () => {
      const error = new Error("Deployment failed");
      logSystemError(
        ErrorCategory.INFRASTRUCTURE,
        "[Infrastructure] Init failed",
        error,
        {
          component: "metrics",
        }
      );

      expect(consoleErrorSpy).toHaveBeenCalled();
      expect(mockCollector.recordError).toHaveBeenCalledWith(
        MetricNames.SYSTEM_INFRASTRUCTURE_ERRORS,
        error,
        expect.objectContaining({
          [LabelKeys.ERROR_CATEGORY]: ErrorCategory.INFRASTRUCTURE,
          component: "metrics",
        })
      );
    });
  });

  describe("Workflow engine errors via core logSystemError", () => {
    it("should use WORKFLOW_ENGINE category and log as error", () => {
      const error = new Error("Step execution failed");
      logSystemError(
        ErrorCategory.WORKFLOW_ENGINE,
        "[Workflow] Step failed",
        error,
        {
          workflow_id: "abc123",
          step_id: "xyz789",
        }
      );

      expect(consoleErrorSpy).toHaveBeenCalled();
      expect(mockCollector.recordError).toHaveBeenCalledWith(
        MetricNames.SYSTEM_WORKFLOW_ENGINE_ERRORS,
        error,
        expect.objectContaining({
          [LabelKeys.ERROR_CATEGORY]: ErrorCategory.WORKFLOW_ENGINE,
          [LabelKeys.ERROR_TYPE]: "system",
          workflow_id: "abc123",
          step_id: "xyz789",
        })
      );
    });
  });

  describe("Context extraction", () => {
    it("should extract simple context", () => {
      logUserError(ErrorCategory.VALIDATION, "[Discord] Error");

      expect(mockCollector.recordError).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          [LabelKeys.ERROR_CONTEXT]: "Discord",
        })
      );
    });

    it("should extract multi-word context", () => {
      logUserError(ErrorCategory.VALIDATION, "[Check Balance] Error");

      expect(mockCollector.recordError).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          [LabelKeys.ERROR_CONTEXT]: "Check Balance",
        })
      );
    });

    it("should extract context with special characters", () => {
      logUserError(ErrorCategory.VALIDATION, "[Web3/RPC] Error");

      expect(mockCollector.recordError).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          [LabelKeys.ERROR_CONTEXT]: "Web3/RPC",
        })
      );
    });

    it("should handle message without context prefix", () => {
      logUserError(ErrorCategory.VALIDATION, "Plain error message");

      expect(mockCollector.recordError).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          [LabelKeys.ERROR_CONTEXT]: "Unknown",
        })
      );
    });
  });

  describe("Label merging", () => {
    it("should merge custom labels with standard labels", () => {
      logUserError(ErrorCategory.VALIDATION, "[Test] Error", undefined, {
        custom_label: "value",
        another_label: "value2",
      });

      expect(mockCollector.recordError).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          [LabelKeys.ERROR_CATEGORY]: ErrorCategory.VALIDATION,
          [LabelKeys.ERROR_CONTEXT]: "Test",
          [LabelKeys.ERROR_TYPE]: "user",
          custom_label: "value",
          another_label: "value2",
        })
      );
    });

    it("should handle empty labels object", () => {
      logUserError(ErrorCategory.VALIDATION, "[Test] Error", undefined, {});

      expect(mockCollector.recordError).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          [LabelKeys.ERROR_CATEGORY]: ErrorCategory.VALIDATION,
        })
      );
    });
  });
});
