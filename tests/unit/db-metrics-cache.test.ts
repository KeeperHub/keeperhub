/**
 * Cache behaviour for updateDbMetrics().
 *
 * Context: /api/metrics/db is scraped every 30s per pod and each call
 * triggers ~35 aggregate queries (full seq scans on workflow_executions
 * and workflow_execution_logs). The cache wraps the refresh so back-to-back
 * scrapes within DB_METRICS_CACHE_TTL_MS reuse one DB round-trip and
 * concurrent scrapes share the in-flight promise.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Stub return shapes for every helper updateDbMetrics() imports. Kept
// in a map so rebindDefaultDbMockImplementations() can re-apply them
// after mockReset() wipes the default implementation between tests.
const DEFAULT_DB_RETURNS: Record<string, unknown> = {
  getWorkflowStatsFromDb: {
    totalSuccess: 0,
    totalError: 0,
    totalRunning: 0,
    totalPending: 0,
    totalCancelled: 0,
    executionsByStatusAndOrgSlug: [],
    durationBuckets: [0, 0, 0, 0, 0, 0, 0, 0, 0],
    durationSum: 0,
    durationCount: 0,
  },
  getLastFinishedExecutionAgeSecondsFromDb: null,
  getUnconfirmedExecutionCountsFromDb: { workflow: 0, direct: 0 },
  getWorkflowErrorsByWorkflowFromDb: [],
  getSystemErrorsByCategoryFromDb: [],
  getStepStatsFromDb: {
    countsByType: {},
    durationBuckets: [0, 0, 0, 0, 0, 0, 0, 0],
    durationSum: 0,
    durationCount: 0,
  },
  getDailyActiveUsersFromDb: 0,
  getUserStatsFromDb: {
    total: 0,
    verified: 0,
    anonymous: 0,
    withWorkflows: 0,
    withIntegrations: 0,
  },
  getOrgStatsFromDb: {
    total: 0,
    membersTotal: 0,
    membersByRole: {},
    invitationsPending: 0,
    withWorkflows: 0,
  },
  getWorkflowDefinitionStatsFromDb: {
    total: 0,
    public: 0,
    private: 0,
    anonymous: 0,
  },
  getScheduleStatsFromDb: {
    total: 0,
    enabled: 0,
    disabled: 0,
    byLastStatus: {},
  },
  getIntegrationStatsFromDb: { total: 0, managed: 0, byType: {} },
  getInfraStatsFromDb: {
    apiKeysTotal: 0,
    chainsTotal: 0,
    chainsEnabled: 0,
    walletsTotal: 0,
    sessionsActive: 0,
  },
  getUserListFromDb: [],
  getOrgListFromDb: [],
  getVoteStatsFromDb: {
    totalVotes: 0,
    totalUpvotes: 0,
    totalDownvotes: 0,
    topWorkflows: [],
    mostClonedWorkflows: [],
    topVoters: [],
  },
  getBillingStatsFromDb: {
    orgsByPlan: [],
    orgsExecutions: [],
    mrrCentsByPlan: [],
    mrrCentsTotal: 0,
    trialsByOutcome: [],
  },
};

const dbMocks: Record<string, ReturnType<typeof vi.fn>> = Object.fromEntries(
  Object.keys(DEFAULT_DB_RETURNS).map((name) => [name, vi.fn()])
);

function rebindDefaultDbMockImplementations(): void {
  for (const [name, ret] of Object.entries(DEFAULT_DB_RETURNS)) {
    dbMocks[name].mockImplementation(async () => ret);
  }
}
rebindDefaultDbMockImplementations();

vi.mock("@/lib/metrics/db-metrics", () => dbMocks);

// getApiProcessMetrics starts an RPC health probe (background interval).
// Stub it so the test doesn't leak timers.
vi.mock("@/lib/metrics/rpc-health-probe", () => ({
  startRpcHealthProbe: vi.fn(),
  stopRpcHealthProbe: vi.fn(),
}));

import {
  __resetDbMetricsCacheForTest,
  getApiProcessMetrics,
  getDbMetrics,
  updateDbMetrics,
} from "@/lib/metrics/collectors/prometheus";

// Poll microtask turns until a mock has been invoked at least once.
// Used to wait for refreshDbMetricsNow()'s dynamic import + Promise.all
// of 13 helpers to settle before we manipulate a controlled mock.
// Replaces a magic-number "await Promise.resolve() 20 times" pattern
// that broke implicit if the chain length changed.
async function waitForMockCall(
  fn: ReturnType<typeof vi.fn>,
  maxTicks = 100
): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (fn.mock.calls.length > 0) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error(
    "waitForMockCall: mock was not invoked within the tick budget"
  );
}

const CACHE_LOOKUP_MISS_RE =
  /keeperhub_db_metrics_cache_lookups_total\{result="miss"\}\s+\d+/;
const CACHE_LOOKUP_HIT_RE =
  /keeperhub_db_metrics_cache_lookups_total\{result="hit"\}\s+\d+/;
const REFRESH_SUCCESS_RE =
  /keeperhub_db_metrics_refresh_total\{outcome="success"\}\s+\d+/;
const ERRORS_BY_WORKFLOW_SKY_RE =
  /keeperhub_workflow_errors_by_workflow\{[^}]*workflow_id="wf_sky_1"[^}]*org_slug="techops-services"[^}]*error_type="user"[^}]*\}\s+7/;
const ERRORS_BY_WORKFLOW_AJNA_RE =
  /keeperhub_workflow_errors_by_workflow\{[^}]*workflow_id="wf_ajna_1"[^}]*org_slug="ajna"[^}]*error_type="system"[^}]*\}\s+2/;
const ERRORS_BY_CATEGORY_SYSTEM_RE =
  /keeperhub_system_errors_by_category\{[^}]*error_category="network_rpc"[^}]*error_type="system"[^}]*\}\s+5/;
const ERRORS_BY_CATEGORY_UNKNOWN_RE =
  /keeperhub_system_errors_by_category\{[^}]*error_category="unknown"[^}]*error_type="user"[^}]*\}\s+3/;
// Unlabeled gauge: name followed by the value, no `{...}` block.
const FINISHED_AGE_42_RE =
  /keeperhub_workflow_executions_finished_age_seconds\s+42(\s|$)/m;
const FINISHED_AGE_17_RE =
  /keeperhub_workflow_executions_finished_age_seconds\s+17(\s|$)/m;
const FINISHED_AGE_ZERO_RE =
  /keeperhub_workflow_executions_finished_age_seconds\s+0(\s|$)/m;
const UNCONFIRMED_WORKFLOW_3_RE =
  /keeperhub_executions_unconfirmed\{kind="workflow"\}\s+3(\s|$)/m;
const UNCONFIRMED_DIRECT_5_RE =
  /keeperhub_executions_unconfirmed\{kind="direct"\}\s+5(\s|$)/m;
const UNCONFIRMED_WORKFLOW_ZERO_RE =
  /keeperhub_executions_unconfirmed\{kind="workflow"\}\s+0(\s|$)/m;

// MRR series. Label order follows the object passed to .set()
// (plan, tier, billing_status), but stay tolerant of extra labels.
const MRR_ACTIVE_RE =
  /keeperhub_mrr_usd_cents\{[^}]*plan="pro"[^}]*tier="25k"[^}]*billing_status="active"[^}]*\}\s+24500/;
const MRR_TRIALING_RE =
  /keeperhub_mrr_usd_cents\{[^}]*plan="pro"[^}]*tier="25k"[^}]*billing_status="trialing"[^}]*\}\s+39200/;
const MRR_PAST_DUE_RE =
  /keeperhub_mrr_usd_cents\{[^}]*plan="pro"[^}]*tier="25k"[^}]*billing_status="past_due"[^}]*\}\s+4900/;
const MRR_ENTERPRISE_NO_TIER_RE =
  /keeperhub_mrr_usd_cents\{[^}]*plan="enterprise"[^}]*tier=""[^}]*billing_status="active"[^}]*\}\s+0/;
// Unlabeled gauge: name followed by the value, no `{...}` block.
const MRR_TOTAL_COMMITTED_RE = /keeperhub_mrr_usd_cents_total\s+29400(\s|$)/m;
const MRR_TOTAL_WITH_TRIALS_RE = /keeperhub_mrr_usd_cents_total\s+68600(\s|$)/m;

describe("updateDbMetrics TTL cache", () => {
  const originalTtl = process.env.DB_METRICS_CACHE_TTL_MS;

  beforeEach(() => {
    __resetDbMetricsCacheForTest();
    // mockReset (not mockClear) so any pending mockImplementationOnce /
    // mockRejectedValueOnce queue from a prior test cannot leak in.
    // mockClear only resets call history.
    for (const fn of Object.values(dbMocks)) {
      fn.mockReset();
    }
    // mockReset also wipes the default implementation; re-establish it
    // so non-overridden helpers return the resolved stub shape again.
    rebindDefaultDbMockImplementations();
  });

  afterEach(() => {
    if (originalTtl === undefined) {
      delete process.env.DB_METRICS_CACHE_TTL_MS;
    } else {
      process.env.DB_METRICS_CACHE_TTL_MS = originalTtl;
    }
  });

  it("hits the DB once when called twice inside the TTL window", async () => {
    process.env.DB_METRICS_CACHE_TTL_MS = "60000";

    // toFake includes "performance" because the cache uses performance.now()
    // for its TTL math (monotonic; immune to NTP step adjustments).
    vi.useFakeTimers({ toFake: ["Date", "performance"] });
    try {
      await updateDbMetrics();
      vi.advanceTimersByTime(30_000);
      await updateDbMetrics();
    } finally {
      vi.useRealTimers();
    }

    expect(dbMocks.getWorkflowStatsFromDb).toHaveBeenCalledTimes(1);
    expect(dbMocks.getBillingStatsFromDb).toHaveBeenCalledTimes(1);
    expect(dbMocks.getStepStatsFromDb).toHaveBeenCalledTimes(1);
  });

  it("refreshes after the TTL elapses", async () => {
    process.env.DB_METRICS_CACHE_TTL_MS = "60000";

    vi.useFakeTimers({ toFake: ["Date", "performance"] });
    try {
      await updateDbMetrics();
      vi.advanceTimersByTime(61_000);
      await updateDbMetrics();
    } finally {
      vi.useRealTimers();
    }

    expect(dbMocks.getWorkflowStatsFromDb).toHaveBeenCalledTimes(2);
    expect(dbMocks.getBillingStatsFromDb).toHaveBeenCalledTimes(2);
  });

  it("falls back to default TTL when env var is malformed", async () => {
    // "60s" with a unit suffix would have been silently parsed as 60ms by
    // parseInt, giving the wrong cache behavior. Number() rejects it, so
    // the default 60000ms is used and only one DB hit happens within 30s.
    process.env.DB_METRICS_CACHE_TTL_MS = "60s";

    vi.useFakeTimers({ toFake: ["Date", "performance"] });
    try {
      await updateDbMetrics();
      vi.advanceTimersByTime(30_000);
      await updateDbMetrics();
    } finally {
      vi.useRealTimers();
    }

    expect(dbMocks.getWorkflowStatsFromDb).toHaveBeenCalledTimes(1);
  });

  it("disables caching when DB_METRICS_CACHE_TTL_MS=0", async () => {
    process.env.DB_METRICS_CACHE_TTL_MS = "0";

    await updateDbMetrics();
    await updateDbMetrics();
    await updateDbMetrics();

    expect(dbMocks.getWorkflowStatsFromDb).toHaveBeenCalledTimes(3);
  });

  it("deduplicates concurrent callers into one DB round-trip", async () => {
    process.env.DB_METRICS_CACHE_TTL_MS = "60000";

    let resolveWorkflow: ((value: unknown) => void) | undefined;
    dbMocks.getWorkflowStatsFromDb.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveWorkflow = resolve;
        })
    );

    const first = updateDbMetrics();
    const second = updateDbMetrics();

    // Wait for the helper to actually be invoked rather than guessing how
    // many microtask turns it takes to get past the dynamic import +
    // Promise.all wiring inside refreshDbMetricsNow.
    await waitForMockCall(dbMocks.getWorkflowStatsFromDb);

    expect(dbMocks.getWorkflowStatsFromDb).toHaveBeenCalledTimes(1);

    resolveWorkflow?.({
      totalSuccess: 0,
      totalError: 0,
      totalRunning: 0,
      totalPending: 0,
      totalCancelled: 0,
      executionsByStatusAndOrgSlug: [],
      durationBuckets: [0, 0, 0, 0, 0, 0, 0, 0, 0],
      durationSum: 0,
      durationCount: 0,
    });

    await Promise.all([first, second]);
    expect(dbMocks.getWorkflowStatsFromDb).toHaveBeenCalledTimes(1);
  });

  it("shares an in-flight refresh even after the TTL has elapsed", async () => {
    // Guards against the cache amplifying load when a refresh under DB
    // stress takes longer than the TTL: the second scrape must share the
    // first in-flight refresh instead of starting a concurrent one.
    process.env.DB_METRICS_CACHE_TTL_MS = "60000";

    let resolveWorkflow: ((value: unknown) => void) | undefined;
    dbMocks.getWorkflowStatsFromDb.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveWorkflow = resolve;
        })
    );

    vi.useFakeTimers({ toFake: ["Date", "performance"] });
    let first: Promise<void>;
    let second: Promise<void>;
    try {
      first = updateDbMetrics();
      // Let the dynamic import and Promise.all reach the controlled mock
      // so resolveWorkflow gets bound before we manipulate it below.
      await waitForMockCall(dbMocks.getWorkflowStatsFromDb);
      // Advance well past the TTL while the first refresh is still hanging.
      vi.advanceTimersByTime(120_000);
      second = updateDbMetrics();
    } finally {
      vi.useRealTimers();
    }

    resolveWorkflow?.({
      totalSuccess: 0,
      totalError: 0,
      totalRunning: 0,
      totalPending: 0,
      totalCancelled: 0,
      executionsByStatusAndOrgSlug: [],
      durationBuckets: [0, 0, 0, 0, 0, 0, 0, 0, 0],
      durationSum: 0,
      durationCount: 0,
    });

    await Promise.all([first, second]);
    expect(dbMocks.getWorkflowStatsFromDb).toHaveBeenCalledTimes(1);
  });

  it("emits cache_lookups{result} and refresh{outcome} counters", async () => {
    process.env.DB_METRICS_CACHE_TTL_MS = "60000";

    vi.useFakeTimers({ toFake: ["Date", "performance"] });
    try {
      // miss + refresh success
      await updateDbMetrics();
      // hit (no refresh)
      vi.advanceTimersByTime(30_000);
      await updateDbMetrics();
    } finally {
      vi.useRealTimers();
    }

    const out = await getApiProcessMetrics();
    expect(out).toMatch(CACHE_LOOKUP_MISS_RE);
    expect(out).toMatch(CACHE_LOOKUP_HIT_RE);
    expect(out).toMatch(REFRESH_SUCCESS_RE);
  });

  it("clears the cache slot on rejection so the next call retries", async () => {
    process.env.DB_METRICS_CACHE_TTL_MS = "60000";

    // Silence the expected error log so the test output stays clean.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {
      // noop
    });

    dbMocks.getWorkflowStatsFromDb.mockRejectedValueOnce(
      new Error("simulated DB outage")
    );

    // First call: refresh rejects internally; the cache wrapper logs and
    // returns a resolved promise to the caller, but evicts the slot so a
    // subsequent call retries instead of seeing the failed entry pinned
    // for the full TTL.
    await updateDbMetrics();
    await updateDbMetrics();

    expect(dbMocks.getWorkflowStatsFromDb).toHaveBeenCalledTimes(2);

    errSpy.mockRestore();
  });
});

// TECH-48: the per-workflow error gauge must be DB-sourced and populated on
// the metrics scrape (the regression that left the prod metric empty was that
// nothing wired the per-workflow series into the scrape path at all).
describe("keeperhub_workflow_errors_by_workflow gauge", () => {
  const originalTtl = process.env.DB_METRICS_CACHE_TTL_MS;

  beforeEach(() => {
    __resetDbMetricsCacheForTest();
    for (const fn of Object.values(dbMocks)) {
      fn.mockReset();
    }
    rebindDefaultDbMockImplementations();
    // No caching so each updateDbMetrics() re-reads the (overridden) mocks.
    process.env.DB_METRICS_CACHE_TTL_MS = "0";
  });

  afterEach(() => {
    if (originalTtl === undefined) {
      delete process.env.DB_METRICS_CACHE_TTL_MS;
    } else {
      process.env.DB_METRICS_CACHE_TTL_MS = originalTtl;
    }
  });

  it("emits one series per (workflow_id, org_slug, error_type) from the DB query", async () => {
    dbMocks.getWorkflowErrorsByWorkflowFromDb.mockResolvedValue([
      {
        workflowId: "wf_sky_1",
        orgSlug: "techops-services",
        errorType: "user",
        count: 7,
      },
      {
        workflowId: "wf_ajna_1",
        orgSlug: "ajna",
        errorType: "system",
        count: 2,
      },
    ]);

    await updateDbMetrics();
    const out = await getDbMetrics();

    expect(out).toMatch(ERRORS_BY_WORKFLOW_SKY_RE);
    expect(out).toMatch(ERRORS_BY_WORKFLOW_AJNA_RE);
  });

  it("clears stale series when a workflow stops appearing in the query", async () => {
    dbMocks.getWorkflowErrorsByWorkflowFromDb.mockResolvedValueOnce([
      { workflowId: "wf_gone", orgSlug: "ajna", errorType: "user", count: 3 },
    ]);
    await updateDbMetrics();
    expect(await getDbMetrics()).toContain('workflow_id="wf_gone"');

    // Next scrape no longer returns that workflow; reset() must drop the series.
    dbMocks.getWorkflowErrorsByWorkflowFromDb.mockResolvedValue([]);
    await updateDbMetrics();
    expect(await getDbMetrics()).not.toContain('workflow_id="wf_gone"');
  });
});

// TECH-6544: the system-errors-by-category gauge dedups errors by cause for the
// infra P3 alert. It must be DB-sourced and populated on the metrics scrape,
// grouped by (error_category, error_type) only — platform-wide, with no
// org_slug or workflow_id label.
describe("keeperhub_system_errors_by_category gauge", () => {
  const originalTtl = process.env.DB_METRICS_CACHE_TTL_MS;

  beforeEach(() => {
    __resetDbMetricsCacheForTest();
    for (const fn of Object.values(dbMocks)) {
      fn.mockReset();
    }
    rebindDefaultDbMockImplementations();
    // No caching so each updateDbMetrics() re-reads the (overridden) mocks.
    process.env.DB_METRICS_CACHE_TTL_MS = "0";
  });

  afterEach(() => {
    if (originalTtl === undefined) {
      delete process.env.DB_METRICS_CACHE_TTL_MS;
    } else {
      process.env.DB_METRICS_CACHE_TTL_MS = originalTtl;
    }
  });

  it("emits one series per (error_category, error_type) from the DB query", async () => {
    dbMocks.getSystemErrorsByCategoryFromDb.mockResolvedValue([
      {
        errorCategory: "network_rpc",
        errorType: "system",
        count: 5,
      },
      {
        errorCategory: "unknown",
        errorType: "user",
        count: 3,
      },
    ]);

    await updateDbMetrics();
    const out = await getDbMetrics();

    expect(out).toMatch(ERRORS_BY_CATEGORY_SYSTEM_RE);
    expect(out).toMatch(ERRORS_BY_CATEGORY_UNKNOWN_RE);
  });

  it("clears stale series when a category stops appearing in the query", async () => {
    dbMocks.getSystemErrorsByCategoryFromDb.mockResolvedValueOnce([
      {
        errorCategory: "billing",
        errorType: "user",
        count: 4,
      },
    ]);
    await updateDbMetrics();
    expect(await getDbMetrics()).toContain('error_category="billing"');

    // Next scrape no longer returns that category; reset() must drop the series.
    dbMocks.getSystemErrorsByCategoryFromDb.mockResolvedValue([]);
    await updateDbMetrics();
    expect(await getDbMetrics()).not.toContain('error_category="billing"');
  });
});

// KEEP-855: the finished-age gauge powers the fast "zero finished executions"
// alert. It must be DB-sourced, populated on the metrics scrape, and -
// critically - must NOT report a misleading 0 when the query can't produce a
// value (empty table / query error), which would mask a real stall. On null it
// holds the previous value so Prometheus staleness / the alert's no_data_state
// governs instead.
describe("keeperhub_workflow_executions_finished_age_seconds gauge", () => {
  const originalTtl = process.env.DB_METRICS_CACHE_TTL_MS;

  beforeEach(() => {
    __resetDbMetricsCacheForTest();
    for (const fn of Object.values(dbMocks)) {
      fn.mockReset();
    }
    rebindDefaultDbMockImplementations();
    // No caching so each updateDbMetrics() re-reads the (overridden) mocks.
    process.env.DB_METRICS_CACHE_TTL_MS = "0";
  });

  afterEach(() => {
    if (originalTtl === undefined) {
      delete process.env.DB_METRICS_CACHE_TTL_MS;
    } else {
      process.env.DB_METRICS_CACHE_TTL_MS = originalTtl;
    }
  });

  it("emits the age in seconds returned by the DB query", async () => {
    dbMocks.getLastFinishedExecutionAgeSecondsFromDb.mockResolvedValue(42);

    await updateDbMetrics();
    const out = await getDbMetrics();

    expect(out).toMatch(FINISHED_AGE_42_RE);
  });

  it("holds the last value (not 0) when the query returns null", async () => {
    // First scrape: real value populates the gauge.
    dbMocks.getLastFinishedExecutionAgeSecondsFromDb.mockResolvedValue(17);
    await updateDbMetrics();
    expect(await getDbMetrics()).toMatch(FINISHED_AGE_17_RE);

    // Second scrape: query returns null (empty table or error). The gauge must
    // retain 17 rather than resetting to 0, so the alert never sees a false
    // "just finished" signal during a metrics-DB hiccup.
    dbMocks.getLastFinishedExecutionAgeSecondsFromDb.mockResolvedValue(null);
    await updateDbMetrics();
    const out = await getDbMetrics();
    expect(out).toMatch(FINISHED_AGE_17_RE);
    expect(out).not.toMatch(FINISHED_AGE_ZERO_RE);
  });
});

// The unconfirmed backlog gauge is the only visibility into rows the
// execution-reconciler has yet to settle, so it carries one series per table
// and, like the finished-age gauge, keeps its last value across a query error.
describe("keeperhub_executions_unconfirmed gauge", () => {
  const originalTtl = process.env.DB_METRICS_CACHE_TTL_MS;

  beforeEach(() => {
    __resetDbMetricsCacheForTest();
    for (const fn of Object.values(dbMocks)) {
      fn.mockReset();
    }
    rebindDefaultDbMockImplementations();
    process.env.DB_METRICS_CACHE_TTL_MS = "0";
  });

  afterEach(() => {
    if (originalTtl === undefined) {
      delete process.env.DB_METRICS_CACHE_TTL_MS;
    } else {
      process.env.DB_METRICS_CACHE_TTL_MS = originalTtl;
    }
  });

  it("emits one series per kind from the DB counts", async () => {
    dbMocks.getUnconfirmedExecutionCountsFromDb.mockResolvedValue({
      workflow: 3,
      direct: 5,
    });

    await updateDbMetrics();
    const out = await getDbMetrics();

    expect(out).toMatch(UNCONFIRMED_WORKFLOW_3_RE);
    expect(out).toMatch(UNCONFIRMED_DIRECT_5_RE);
  });

  it("holds the last value (not 0) when the query returns null", async () => {
    dbMocks.getUnconfirmedExecutionCountsFromDb.mockResolvedValue({
      workflow: 3,
      direct: 5,
    });
    await updateDbMetrics();
    expect(await getDbMetrics()).toMatch(UNCONFIRMED_WORKFLOW_3_RE);

    dbMocks.getUnconfirmedExecutionCountsFromDb.mockResolvedValue(null);
    await updateDbMetrics();
    const out = await getDbMetrics();
    expect(out).toMatch(UNCONFIRMED_WORKFLOW_3_RE);
    expect(out).not.toMatch(UNCONFIRMED_WORKFLOW_ZERO_RE);
  });
});

// The MRR gauge must carry billing_status so a dashboard can tell
// committed revenue from trial pipeline revenue, and the total must exclude
// trials. On prod the old total read $686 while only $294 was committed.
describe("keeperhub_mrr_usd_cents gauge", () => {
  const originalTtl = process.env.DB_METRICS_CACHE_TTL_MS;

  beforeEach(() => {
    __resetDbMetricsCacheForTest();
    for (const fn of Object.values(dbMocks)) {
      fn.mockReset();
    }
    rebindDefaultDbMockImplementations();
    process.env.DB_METRICS_CACHE_TTL_MS = "0";
  });

  afterEach(() => {
    if (originalTtl === undefined) {
      delete process.env.DB_METRICS_CACHE_TTL_MS;
    } else {
      process.env.DB_METRICS_CACHE_TTL_MS = originalTtl;
    }
  });

  it("labels each series with billing_status and keeps trials out of the total", async () => {
    dbMocks.getBillingStatsFromDb.mockResolvedValue({
      orgsByPlan: [],
      orgsExecutions: [],
      mrrCentsByPlan: [
        { plan: "pro", tier: "25k", billingStatus: "active", cents: 24_500 },
        { plan: "pro", tier: "25k", billingStatus: "trialing", cents: 39_200 },
        { plan: "pro", tier: "25k", billingStatus: "past_due", cents: 4900 },
      ],
      mrrCentsTotal: 29_400,
      trialsByOutcome: [],
    });

    await updateDbMetrics();
    const out = await getDbMetrics();

    expect(out).toMatch(MRR_ACTIVE_RE);
    expect(out).toMatch(MRR_TRIALING_RE);
    expect(out).toMatch(MRR_PAST_DUE_RE);
    // Committed only. 68600 was the pre-fix figure that counted trials.
    expect(out).toMatch(MRR_TOTAL_COMMITTED_RE);
    expect(out).not.toMatch(MRR_TOTAL_WITH_TRIALS_RE);
  });

  it("emits an empty tier label for a plan with no tier", async () => {
    dbMocks.getBillingStatsFromDb.mockResolvedValue({
      orgsByPlan: [],
      orgsExecutions: [],
      mrrCentsByPlan: [
        { plan: "enterprise", tier: null, billingStatus: "active", cents: 0 },
      ],
      mrrCentsTotal: 0,
      trialsByOutcome: [],
    });

    await updateDbMetrics();

    expect(await getDbMetrics()).toMatch(MRR_ENTERPRISE_NO_TIER_RE);
  });

  it("clears the trialing series once the org converts to active", async () => {
    dbMocks.getBillingStatsFromDb.mockResolvedValueOnce({
      orgsByPlan: [],
      orgsExecutions: [],
      mrrCentsByPlan: [
        { plan: "pro", tier: "25k", billingStatus: "trialing", cents: 4900 },
      ],
      mrrCentsTotal: 0,
      trialsByOutcome: [],
    });
    await updateDbMetrics();
    expect(await getDbMetrics()).toContain('billing_status="trialing"');

    // The trial converted, so the next scrape reports it as active. reset()
    // must drop the trialing series rather than strand it at its old value.
    dbMocks.getBillingStatsFromDb.mockResolvedValue({
      orgsByPlan: [],
      orgsExecutions: [],
      mrrCentsByPlan: [
        { plan: "pro", tier: "25k", billingStatus: "active", cents: 4900 },
      ],
      mrrCentsTotal: 4900,
      trialsByOutcome: [],
    });
    await updateDbMetrics();
    const out = await getDbMetrics();
    expect(out).not.toContain('billing_status="trialing"');
    expect(out).toContain('billing_status="active"');
  });
});
