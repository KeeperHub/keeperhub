import { describe, expect, it, vi } from "vitest";

// lib/metrics/collectors/prometheus.ts is server-only because it touches
// prom-client's process-global registries. Stub server-only so this purely
// data-snapshot test can load the module under vitest's node environment.
vi.mock("server-only", () => ({}));

const { ERROR_LABELS } = await import("@/lib/metrics/collectors/prometheus");

/**
 * KEEP-545 (closes KEEP-536): regression guard for the Prometheus error
 * counter label set. The `specs/logging-and-metrics/keeperhub-errors-dashboard.json`
 * and the managed-client alert PromQL both group by `error_category` and
 * filter by `is_user_error`. Removing either of these labels from the shared
 * `ERROR_LABELS` array would silently produce empty panels and a no-data
 * alert without any test or type failure. This snapshot prevents that.
 */
describe("ERROR_LABELS regression guard (KEEP-545 / closes KEEP-536)", () => {
  it("includes the labels required by the errors dashboard and SLA alert", () => {
    expect(ERROR_LABELS).toContain("error_category");
    expect(ERROR_LABELS).toContain("is_user_error");
    expect(ERROR_LABELS).toContain("error_context");
  });

  it("matches the canonical snapshot", () => {
    expect([...ERROR_LABELS].sort()).toEqual(
      [
        "action_name",
        "chain_id",
        "component",
        "endpoint",
        "error_category",
        "error_context",
        "error_type",
        "execution_id",
        "integration_id",
        "is_user_error",
        "org_slug",
        "plan",
        "plugin_name",
        "service",
        "status_code",
        "table",
        "workflow_id",
      ].sort()
    );
  });
});
