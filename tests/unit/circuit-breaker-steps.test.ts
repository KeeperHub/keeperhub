import { beforeEach, describe, expect, it, vi } from "vitest";

// Server-only guard module loads "server-only"; stub it for vitest.
vi.mock("server-only", () => ({}));

const { mockTrip, mockReset, mockWithStepLogging } = vi.hoisted(() => ({
  mockTrip: vi.fn(),
  mockReset: vi.fn(),
  // Passthrough: run the step logic directly without the DB logging epilogue.
  mockWithStepLogging: vi.fn(
    (_input: unknown, fn: () => unknown) => fn() as unknown
  ),
}));

vi.mock("@/lib/execute/org-circuit-breaker", () => ({
  tripOrgCircuitBreaker: (...args: unknown[]) => mockTrip(...args),
  resetOrgCircuitBreaker: (...args: unknown[]) => mockReset(...args),
}));

vi.mock("@/lib/workflow/executor/step-handler", () => ({
  withStepLogging: (...args: unknown[]) =>
    mockWithStepLogging(...(args as [unknown, () => unknown])),
}));

import { circuitBreakerResetStep } from "@/lib/workflow/nodes/circuit-breaker-reset/step";
import { circuitBreakerTripStep } from "@/lib/workflow/nodes/circuit-breaker-trip/step";

const HALTED_AT = new Date("2026-01-02T03:04:05.000Z");

function context(overrides: Record<string, unknown> = {}) {
  return {
    nodeId: "cb-1",
    nodeName: "Circuit Breaker",
    nodeType: "Trip Circuit Breaker",
    organizationId: "org_ctx",
    workflowId: "wf_1",
    createdBy: "user_creator",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("circuitBreakerTripStep", () => {
  it("trips the org from the execution context, not from config, and never targets another org", async () => {
    mockTrip.mockResolvedValue({ tripped: true, haltedAt: HALTED_AT });

    const result = await circuitBreakerTripStep({
      reason: "spend anomaly",
      // A stray config-injected org id must be ignored: the step can only ever
      // halt the org it runs under, so there is no cross-org path.
      organizationId: "org_evil",
      _context: context(),
    } as Parameters<typeof circuitBreakerTripStep>[0]);

    expect(mockTrip).toHaveBeenCalledWith({
      organizationId: "org_ctx",
      reason: "spend anomaly",
      byWorkflowId: "wf_1",
    });
    expect(result).toEqual({
      halted: true,
      tripped: true,
      haltedAt: HALTED_AT.toISOString(),
    });
  });

  it("reports tripped=false when the breaker was already engaged (idempotent)", async () => {
    mockTrip.mockResolvedValue({ tripped: false, haltedAt: HALTED_AT });

    const result = await circuitBreakerTripStep({ _context: context() });

    expect(result).toEqual({
      halted: true,
      tripped: false,
      haltedAt: HALTED_AT.toISOString(),
    });
  });

  it("fails the step when there is no organization context", async () => {
    const result = await circuitBreakerTripStep({
      _context: context({ organizationId: undefined }),
    });

    expect(mockTrip).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      error: "Circuit breaker requires an organization context",
    });
  });
});

describe("circuitBreakerResetStep", () => {
  it("resets the org from context, passing the workflow creator as the privileged principal", async () => {
    mockReset.mockResolvedValue({ reset: true, wasHalted: true });

    const result = await circuitBreakerResetStep({ _context: context() });

    expect(mockReset).toHaveBeenCalledWith({
      organizationId: "org_ctx",
      requestedByUserId: "user_creator",
    });
    expect(result).toEqual({ reset: true, wasHalted: true });
  });

  it("fails the step loudly when the creator is not an org admin/owner", async () => {
    mockReset.mockResolvedValue({ reset: false, reason: "not_authorized" });

    const result = await circuitBreakerResetStep({ _context: context() });

    expect(result).toEqual({
      success: false,
      error:
        "Only a workflow created by an organization admin or owner can reset the circuit breaker",
    });
  });

  it("fails the step when there is no organization context", async () => {
    const result = await circuitBreakerResetStep({
      _context: context({ organizationId: undefined }),
    });

    expect(mockReset).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      error: "Circuit breaker requires an organization context",
    });
  });
});
