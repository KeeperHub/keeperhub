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

const executorBroadcastsTotal = makeCounter();

vi.mock("../../lib/metrics/collectors/prometheus", () => ({
  rpcMetrics: counters,
  workflowCounterMetrics: workflowCounters,
  executorBroadcastsTotal,
}));

const {
  collectCounterDeltas,
  applyCounterDeltas,
  isIngestPayload,
  isMetricDelta,
  isLatencyObservation,
  SHIPPABLE_COUNTER_NAMES,
} = await import("./metrics-shipping");
const { TRIGGER_TYPES } = await import("../../lib/metrics/types");

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

describe("isLatencyObservation label allowlists", () => {
  // These two labels are written straight into `trigger_type` and
  // `dispatch_target`, and this validator is the last check before that happens.
  // A validator narrower than the emitter does not corrupt a number - it rejects
  // the observation and the sample is lost - so the sets have to agree with their
  // owners exactly, in both directions.
  const observation = (
    overrides: Record<string, unknown> = {}
  ): Record<string, unknown> => ({
    correlationId: "1a2b3c4d5e6f7890",
    executionId: "exec-1",
    workflowId: "wf-1",
    triggerType: "event",
    dispatchTarget: "k8s-job",
    stage: "observed-broadcast",
    durationMs: 120,
    ...overrides,
  });

  it("accepts every trigger type the platform can emit", () => {
    // The regression this guards: the allowlist was hand-written and omitted
    // `scheduled`, the legacy label TRIGGER_TYPES keeps so historical series stay
    // valid. Iterating the owner's set means a future addition cannot silently
    // start dropping observations.
    for (const triggerType of TRIGGER_TYPES) {
      expect(isLatencyObservation(observation({ triggerType }))).toBe(true);
    }
  });

  it("accepts the legacy `scheduled` label specifically", () => {
    expect(isLatencyObservation(observation({ triggerType: "scheduled" }))).toBe(
      true
    );
  });

  it("accepts every dispatch target in the union", () => {
    for (const dispatchTarget of ["k8s-job", "in-process", "api"]) {
      expect(isLatencyObservation(observation({ dispatchTarget }))).toBe(true);
    }
  });

  it("rejects an unknown trigger type", () => {
    expect(isLatencyObservation(observation({ triggerType: "whatever" }))).toBe(
      false
    );
  });

  it("rejects an unknown dispatch target", () => {
    expect(isLatencyObservation(observation({ dispatchTarget: "k8s_job" }))).toBe(
      false
    );
  });

  it("does not accept an inherited object member as a dispatch target", () => {
    // The key arrives over the network, so `toString` must not read as valid the
    // way it would with `value in map`.
    expect(
      isLatencyObservation(observation({ dispatchTarget: "toString" }))
    ).toBe(false);
    expect(
      isLatencyObservation(observation({ dispatchTarget: "constructor" }))
    ).toBe(false);
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
