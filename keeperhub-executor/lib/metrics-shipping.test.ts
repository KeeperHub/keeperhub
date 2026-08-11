import { beforeEach, describe, expect, it, vi } from "vitest";

type FakeCounter = {
  get: () => Promise<{
    values: Array<{ value: number; labels: Record<string, string> }>;
  }>;
  inc: (labels: Record<string, string>, value: number) => void;
};

function makeCounter(
  values: Array<{ value: number; labels: Record<string, string> }> = []
): FakeCounter & {
  incCalls: Array<{ labels: Record<string, string>; value: number }>;
} {
  const incCalls: Array<{ labels: Record<string, string>; value: number }> = [];
  return {
    get: (): Promise<{
      values: Array<{ value: number; labels: Record<string, string> }>;
    }> => Promise.resolve({ values }),
    inc: (labels: Record<string, string>, value: number): void => {
      incCalls.push({ labels, value });
    },
    incCalls,
  };
}

const counters = {
  primaryAttempts: makeCounter(),
  primaryFailures: makeCounter(),
  fallbackAttempts: makeCounter(),
  fallbackFailures: makeCounter(),
  failoverEvents: makeCounter(),
  recoveryEvents: makeCounter(),
  bothFailedEvents: makeCounter(),
  errorsByType: makeCounter(),
};

const workflowCounters = {
  executionErrorsCreated: makeCounter(),
  executionsFinished: makeCounter(),
};

vi.mock("../../lib/metrics/collectors/prometheus", () => ({
  rpcMetrics: counters,
  workflowCounterMetrics: workflowCounters,
}));

const {
  collectCounterDeltas,
  applyCounterDeltas,
  isIngestPayload,
  isMetricDelta,
  SHIPPABLE_COUNTER_NAMES,
} = await import("./metrics-shipping");

describe("collectCounterDeltas", () => {
  beforeEach(() => {
    for (const c of [
      ...Object.values(counters),
      ...Object.values(workflowCounters),
    ]) {
      c.incCalls.length = 0;
    }
  });

  it("returns an empty list when no counters have nonzero values", async () => {
    counters.primaryAttempts.get = (): Promise<{
      values: Array<{ value: number; labels: Record<string, string> }>;
    }> => Promise.resolve({ values: [] });
    const deltas = await collectCounterDeltas();
    expect(deltas).toEqual([]);
  });

  it("includes only counters with value > 0 and stringifies labels", async () => {
    counters.primaryAttempts.get = (): Promise<{
      values: Array<{ value: number; labels: Record<string, string> }>;
    }> =>
      Promise.resolve({
        values: [
          { value: 3, labels: { chain: "ethereum", operation: "read" } },
          { value: 0, labels: { chain: "base", operation: "read" } },
        ],
      });
    counters.primaryFailures.get = (): Promise<{
      values: Array<{ value: number; labels: Record<string, string> }>;
    }> =>
      Promise.resolve({
        values: [
          { value: 1, labels: { chain: "ethereum", operation: "write" } },
        ],
      });

    const deltas = await collectCounterDeltas();

    expect(deltas).toContainEqual({
      name: "keeperhub_rpc_primary_attempts_total",
      labels: { chain: "ethereum", operation: "read" },
      value: 3,
    });
    expect(deltas).toContainEqual({
      name: "keeperhub_rpc_primary_failures_total",
      labels: { chain: "ethereum", operation: "write" },
      value: 1,
    });
    expect(
      deltas.find(
        (d) =>
          d.name === "keeperhub_rpc_primary_attempts_total" &&
          d.labels.chain === "base"
      )
    ).toBeUndefined();
  });
});

describe("applyCounterDeltas", () => {
  beforeEach(() => {
    for (const c of [
      ...Object.values(counters),
      ...Object.values(workflowCounters),
    ]) {
      c.incCalls.length = 0;
    }
  });

  it("applies known counter deltas and skips unknown names", async () => {
    const { applied, skipped } = await applyCounterDeltas([
      {
        name: "keeperhub_rpc_primary_attempts_total",
        labels: { chain: "ethereum", operation: "read" },
        value: 5,
      },
      {
        name: "keeperhub_not_a_real_metric",
        labels: {},
        value: 10,
      },
    ]);

    expect(applied).toBe(1);
    expect(skipped).toBe(1);
    expect(counters.primaryAttempts.incCalls).toEqual([
      { labels: { chain: "ethereum", operation: "read" }, value: 5 },
    ]);
  });

  it("applies workflow terminal counter deltas with labels preserved", async () => {
    const { applied, skipped } = await applyCounterDeltas([
      {
        name: "keeperhub_workflow_executions_finished_total",
        labels: { status: "success", org_slug: "acme", error_type: "na" },
        value: 2,
      },
      {
        name: "keeperhub_workflow_execution_errors_created_total",
        labels: {
          org_slug: "acme",
          error_category: "infrastructure",
          error_type: "system",
        },
        value: 1,
      },
    ]);

    expect(applied).toBe(2);
    expect(skipped).toBe(0);
    expect(workflowCounters.executionsFinished.incCalls).toEqual([
      {
        labels: { status: "success", org_slug: "acme", error_type: "na" },
        value: 2,
      },
    ]);
    expect(workflowCounters.executionErrorsCreated.incCalls).toEqual([
      {
        labels: {
          org_slug: "acme",
          error_category: "infrastructure",
          error_type: "system",
        },
        value: 1,
      },
    ]);
  });

  it("skips non-positive and non-finite values", async () => {
    const { applied, skipped } = await applyCounterDeltas([
      {
        name: "keeperhub_rpc_primary_attempts_total",
        labels: { chain: "ethereum", operation: "read" },
        value: 0,
      },
      {
        name: "keeperhub_rpc_primary_attempts_total",
        labels: { chain: "ethereum", operation: "read" },
        value: Number.NaN,
      },
      {
        name: "keeperhub_rpc_primary_attempts_total",
        labels: { chain: "ethereum", operation: "read" },
        value: -1,
      },
    ]);

    expect(applied).toBe(0);
    expect(skipped).toBe(3);
    expect(counters.primaryAttempts.incCalls).toEqual([]);
  });
});

describe("payload validators", () => {
  it("accepts well-formed deltas", () => {
    expect(
      isMetricDelta({
        name: "keeperhub_rpc_primary_attempts_total",
        labels: { chain: "ethereum" },
        value: 1,
      })
    ).toBe(true);
  });

  it("rejects deltas with non-string label values", () => {
    expect(
      isMetricDelta({
        name: "x",
        labels: { chain: 42 },
        value: 1,
      })
    ).toBe(false);
  });

  it("rejects payloads with non-array deltas", () => {
    expect(isIngestPayload({ deltas: "nope" })).toBe(false);
    expect(isIngestPayload(null)).toBe(false);
    expect(isIngestPayload({})).toBe(false);
  });

  it("accepts an empty deltas array", () => {
    expect(isIngestPayload({ deltas: [] })).toBe(true);
  });
});

describe("SHIPPABLE_COUNTER_NAMES", () => {
  it("matches the set of shippable RPC counters", () => {
    expect(SHIPPABLE_COUNTER_NAMES).toContain(
      "keeperhub_rpc_primary_attempts_total"
    );
    expect(SHIPPABLE_COUNTER_NAMES).toContain(
      "keeperhub_rpc_errors_by_type_total"
    );
  });

  it("includes the workflow terminal counters emitted inside runner pods", () => {
    expect(SHIPPABLE_COUNTER_NAMES).toContain(
      "keeperhub_workflow_executions_finished_total"
    );
    expect(SHIPPABLE_COUNTER_NAMES).toContain(
      "keeperhub_workflow_execution_errors_created_total"
    );
  });
});
