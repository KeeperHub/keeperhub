/**
 * Tests for the Prometheus collector's defensive error-counter handling.
 *
 * Regression context: an Etherscan ABI auto-fetch failure surfaced a
 * prom-client error to the user-facing UI ("Added label \"contract_address\"
 * is not included in initial labelset...") because:
 *   1. The fetch-abi route enriched logUserError with `contract_address`
 *      (and other unbounded fields) for console + Sentry context.
 *   2. The error counters declare a bounded ERROR_LABELS set.
 *   3. prom-client throws on unknown labels.
 *   4. The throw bubbled through logUserError -> the route's try/catch ->
 *      back to the UI as a 500 with the prom-client message in the body.
 *
 * The fix: filter labels to the counter's declared labelNames before
 * counter.inc(), and wrap inc() in a defensive try/catch so a future
 * label mismatch can never break the user-facing operation that emitted
 * the log.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rawConsole } from "@/lib/log/core";

vi.mock("server-only", () => ({}));

import {
  getPrometheusMetrics,
  prometheusMetricsCollector,
} from "@/lib/metrics/collectors/prometheus";

// The collector's unknown-metric path logs via logWarn -> lib/log/core's
// rawConsole, so the spy must target rawConsole, not the global console.
const raw = rawConsole as unknown as Record<
  "debug" | "info" | "warn" | "error",
  (line: string) => void
>;

describe("prometheusMetricsCollector.recordError -- defensive label filtering", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(raw, "warn").mockImplementation(() => {
      // suppress
    });
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("does not throw when caller passes a label outside the counter's labelset", () => {
    expect(() => {
      prometheusMetricsCollector.recordError(
        "errors.external.service.total",
        new Error("Etherscan rate limit"),
        {
          // contract_address is intentionally passed for console/Sentry context
          // but is NOT in ERROR_LABELS -- prom-client would have thrown before
          // the fix.
          contract_address: "0xD7c8809c37a510a31CE066468bbFd81b778d7Ca6",
          service: "etherscan",
        }
      );
    }).not.toThrow();
  });

  it("still increments the counter using only the labels the counter declares", async () => {
    prometheusMetricsCollector.recordError(
      "errors.external.service.total",
      new Error("Etherscan rate limit"),
      {
        contract_address: "0xD7c8809c37a510a31CE066468bbFd81b778d7Ca6",
        network: "ethereum-sepolia",
        status: "0",
        service: "etherscan",
      }
    );

    const output = await getPrometheusMetrics();

    // Counter must increment with the allowed label set.
    expect(output).toContain("keeperhub_errors_external_service_total");
    expect(output).toMatch(/service="etherscan"/);

    // Unknown labels must be dropped before reaching prom-client.
    expect(output).not.toMatch(/contract_address=/);
    expect(output).not.toMatch(/network="ethereum-sepolia"/);
  });

  it("does not throw when caller passes labels outside the legacy allowlist for workflow.execution.errors", () => {
    // workflow.execution.errors uses the legacy allowlist (workflow_id,
    // trigger_type, error_type, org_slug, plan). plugin_name is NOT allowed
    // for this metric -- ensure the legacy filter still strips it cleanly.
    expect(() => {
      prometheusMetricsCollector.recordError(
        "workflow.execution.errors",
        new Error("test"),
        {
          workflow_id: "wf_test_123",
          trigger_type: "webhook",
          plugin_name: "web3",
          contract_address: "0xabc",
        }
      );
    }).not.toThrow();
  });

  it("logs a warning instead of throwing if the counter name is unknown", () => {
    prometheusMetricsCollector.recordError(
      "errors.unknown.metric.does.not.exist",
      new Error("test"),
      { service: "etherscan" }
    );

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "Unknown error metric: errors.unknown.metric.does.not.exist"
      )
    );
  });

  it("survives multiple recordings with rotating mixes of valid and invalid labels", () => {
    const labelMixes: Record<string, string>[] = [
      { contract_address: "0x1", service: "etherscan" },
      { unknown_label: "x", endpoint: "/api/web3/fetch-abi" },
      { workflow_id: "wf_1", random_field: "y" },
      { service: "discord", chain_id: "1" },
    ];

    for (const labels of labelMixes) {
      expect(() => {
        prometheusMetricsCollector.recordError(
          "errors.external.service.total",
          new Error("test"),
          labels
        );
      }).not.toThrow();
    }
  });
});
