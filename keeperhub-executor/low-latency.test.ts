import { describe, expect, it, vi } from "vitest";
import {
  buildWarmAssignment,
  resolveLowLatencyStart,
  tryWarmStart,
} from "./low-latency";

function nodesWith(
  executionPriority?: unknown,
  triggerType = "Block"
): unknown[] {
  return [
    {
      id: "trigger-1",
      data: {
        type: "trigger",
        config: {
          triggerType,
          ...(executionPriority === undefined ? {} : { executionPriority }),
        },
      },
    },
    { id: "write-1", data: { type: "action", config: {} } },
  ];
}

function resolve(overrides: Partial<Parameters<typeof resolveLowLatencyStart>[0]> = {}) {
  const isEntitled = vi.fn(() => Promise.resolve(true));
  const recordClaim = vi.fn();
  const onEntitlementError = vi.fn();
  const result = resolveLowLatencyStart({
    nodes: nodesWith("low-latency"),
    organizationId: "org-1",
    target: "k8s-job",
    triggerType: "block",
    poolEnabled: true,
    isEntitled,
    recordClaim,
    onEntitlementError,
    ...overrides,
  });
  return {
    result,
    isEntitled: overrides.isEntitled ?? isEntitled,
    recordClaim: overrides.recordClaim ?? recordClaim,
    onEntitlementError: overrides.onEntitlementError ?? onEntitlementError,
  };
}

describe("resolveLowLatencyStart", () => {
  it("clears an entitled, opted-in, automated run for the warm pool", async () => {
    const { result, isEntitled } = resolve();
    await expect(result).resolves.toEqual({
      organizationId: "org-1",
      triggerType: "block",
    });
    expect(isEntitled).toHaveBeenCalledWith("org-1");
  });

  it.each([
    ["no setting", undefined],
    ["standard", "standard"],
    ["an unknown value", "fast"],
    ["a boolean", true],
  ])("leaves the default path untouched for %s, without a plan lookup", async (_label, value) => {
    const { result, isEntitled, recordClaim } = resolve({
      nodes: nodesWith(value),
    });
    await expect(result).resolves.toBeUndefined();
    expect(isEntitled).not.toHaveBeenCalled();
    expect(recordClaim).not.toHaveBeenCalled();
  });

  it.each([
    ["an in-process target", { target: "in-process" }],
    ["an api target", { target: "api" }],
    ["a stopped or disabled pool", { poolEnabled: false }],
    ["a manual run", { triggerType: "manual" }],
    ["an upstream run", { triggerType: "upstream" }],
    ["no organization", { organizationId: null }],
  ])("does not use the pool for %s", async (_label, override) => {
    const { result, isEntitled } = resolve(override);
    await expect(result).resolves.toBeUndefined();
    expect(isEntitled).not.toHaveBeenCalled();
  });

  it.each([
    ["Schedule", "schedule"],
    ["Event", "event"],
    ["Block", "block"],
    ["Transfer", "event"],
    ["Pyth Price", "event"],
    ["Pyth Price", "upstream"],
  ])(
    "uses the pool for a %s trigger arriving as %s",
    async (editorType, triggerType) => {
      const { result } = resolve({
        nodes: nodesWith("low-latency", editorType),
        triggerType,
      });
      await expect(result).resolves.toEqual({
        organizationId: "org-1",
        triggerType,
      });
    }
  );

  it.each([
    ["Webhook", "webhook"],
    ["Manual", "manual"],
    ["Block", "manual"],
    ["Event", "block"],
  ])(
    "does not use the pool for a %s trigger arriving as %s",
    async (editorType, triggerType) => {
      const { result, isEntitled } = resolve({
        nodes: nodesWith("low-latency", editorType),
        triggerType,
      });
      await expect(result).resolves.toBeUndefined();
      expect(isEntitled).not.toHaveBeenCalled();
    }
  );

  it("starts a run normally and counts it when the plan does not include it", async () => {
    const { result, recordClaim } = resolve({
      isEntitled: vi.fn(() => Promise.resolve(false)),
    });
    await expect(result).resolves.toBeUndefined();
    expect(recordClaim).toHaveBeenCalledWith("not_entitled", "block");
  });

  it("starts a run normally when the plan lookup fails, and never throws", async () => {
    const error = new Error("db down");
    const { result, onEntitlementError, recordClaim } = resolve({
      isEntitled: vi.fn(() => Promise.reject(error)),
    });
    await expect(result).resolves.toBeUndefined();
    expect(onEntitlementError).toHaveBeenCalledWith(error);
    expect(recordClaim).not.toHaveBeenCalled();
  });
});

describe("tryWarmStart", () => {
  const assignment = buildWarmAssignment({
    workflowId: "wf-1",
    executionId: "exec-1",
    input: {},
    triggerType: "block",
  });

  it("does not touch the pool for a run that was not cleared", async () => {
    const pool = { tryAssign: vi.fn() };
    const recordClaim = vi.fn();
    await expect(
      tryWarmStart({ pool, start: undefined, assignment, recordClaim })
    ).resolves.toBeUndefined();
    expect(pool.tryAssign).not.toHaveBeenCalled();
    expect(recordClaim).not.toHaveBeenCalled();
  });

  it("does nothing when no pool is running", async () => {
    const recordClaim = vi.fn();
    await expect(
      tryWarmStart({
        pool: undefined,
        start: { organizationId: "org-1", triggerType: "webhook" },
        assignment,
        recordClaim,
      })
    ).resolves.toBeUndefined();
  });

  it.each([
    "claimed",
    "miss",
    "org_limited",
    "invalid",
    "refused",
    "unacknowledged",
  ] as const)(
    "returns and counts %s under the message trigger type",
    async (outcome) => {
      const pool = { tryAssign: vi.fn(() => Promise.resolve(outcome)) };
      const recordClaim = vi.fn();
      await expect(
        tryWarmStart({
          pool,
          start: { organizationId: "org-1", triggerType: "webhook" },
          assignment,
          recordClaim,
        })
      ).resolves.toBe(outcome);
      expect(pool.tryAssign).toHaveBeenCalledWith(assignment, "org-1");
      expect(recordClaim).toHaveBeenCalledWith(outcome, "webhook");
    }
  );
});

describe("buildWarmAssignment", () => {
  it("keeps a label-safe correlation id and drops an unsafe one", () => {
    const base = {
      workflowId: "wf-1",
      executionId: "exec-1",
      input: { a: 1 },
      triggerType: "block",
      receivedAt: 1000,
    };
    expect(
      buildWarmAssignment({ ...base, correlationId: "abc123" }).correlationId
    ).toBe("abc123");
    expect(
      buildWarmAssignment({ ...base, correlationId: "bad/value" })
        .correlationId
    ).toBeUndefined();
    expect(buildWarmAssignment(base).receivedAt).toBe(1000);
  });
});
