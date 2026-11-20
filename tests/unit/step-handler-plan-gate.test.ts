import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/logging", () => ({
  ErrorCategory: { BILLING: "billing", WORKFLOW_ENGINE: "workflow_engine" },
  logSystemError: vi.fn(),
  logSystemWarn: vi.fn(),
}));
vi.mock("@/lib/metrics/instrumentation/workflow", () => ({
  recordStepMetrics: vi.fn(),
}));
vi.mock("@/lib/workflow/executor/step-claim", () => ({
  acquireStepClaim: vi.fn(() => Promise.resolve({ outcome: "run" })),
  releaseStepClaim: vi.fn(() => Promise.resolve()),
  stepClaimScope: vi.fn((scope: unknown) => scope),
}));
vi.mock("@/lib/workflow/executor/logging", () => ({
  incrementCompletedSteps: vi.fn(),
  logStepCompleteDb: vi.fn(),
  logStepStartDb: vi.fn(),
  logWorkflowCompleteDb: vi.fn(),
  updateCurrentStep: vi.fn(),
}));
vi.mock("@/lib/billing/feature-flag", () => ({
  isBillingEnabled: vi.fn(),
}));
vi.mock("@/lib/billing/subscription-read", () => ({
  getOrgPlan: vi.fn(),
}));
vi.mock("@/lib/workflow/nodes/http-request/perform", () => ({
  httpRequest: vi.fn(),
}));

import { isBillingEnabled } from "@/lib/billing/feature-flag";
import { getOrgPlan } from "@/lib/billing/subscription-read";
import { FEATURE_UPGRADE_REQUIRED_ERROR } from "@/lib/features/plan-gate";
import {
  incrementCompletedSteps,
  logStepCompleteDb,
  logStepStartDb,
} from "@/lib/workflow/executor/logging";
import {
  type StepContext,
  withStepLogging,
} from "@/lib/workflow/executor/step-handler";
import { httpRequest } from "@/lib/workflow/nodes/http-request/perform";
import { httpRequestStep } from "@/lib/workflow/nodes/http-request/step";

function contextFor(nodeType: string): StepContext {
  return {
    executionId: "exec-1",
    nodeId: "node-1",
    nodeName: "Step",
    nodeType,
    organizationId: "org-1",
  };
}

const ran = { success: true, data: { ok: true } };

describe("withStepLogging plan gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isBillingEnabled).mockReturnValue(true);
    vi.mocked(getOrgPlan).mockResolvedValue("free");
    vi.mocked(logStepStartDb).mockResolvedValue({
      logId: "log-1",
      startTime: Date.now(),
    });
  });

  it.each([
    "HTTP Request",
    "Database Query",
    "code/run-code",
    "webhook/send-webhook",
    "blockscout/get-address-balance",
  ])("refuses %s for a free org without running the step", async (nodeType) => {
    const body = vi.fn(() => Promise.resolve(ran));

    const result = await withStepLogging(
      { _context: contextFor(nodeType) },
      body
    );

    expect(body).not.toHaveBeenCalled();
    expect(getOrgPlan).toHaveBeenCalledWith("org-1");
    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining(FEATURE_UPGRADE_REQUIRED_ERROR),
      code: "upgrade_required",
      requiredPlan: "pro",
    });
    const persisted = vi.mocked(logStepCompleteDb).mock.calls[0][0];
    expect(persisted.status).toBe("error");
    expect(incrementCompletedSteps).toHaveBeenCalledWith(
      expect.objectContaining({ success: false })
    );
  });

  it("gates on _actionType when the context carries a generic nodeType", async () => {
    const body = vi.fn(() => Promise.resolve(ran));

    const result = await withStepLogging(
      { _actionType: "code/run-code", _context: contextFor("action") },
      body
    );

    expect(body).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, code: "upgrade_required" });
  });

  it("gates when either identity is gated, even if the other is not", async () => {
    const body = vi.fn(() => Promise.resolve(ran));

    const result = await withStepLogging(
      { _actionType: "Condition", _context: contextFor("HTTP Request") },
      body
    );

    expect(body).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, code: "upgrade_required" });
  });

  it("default-denies a gated step with no org context", async () => {
    const body = vi.fn(() => Promise.resolve(ran));

    const result = await withStepLogging(
      {
        _context: { ...contextFor("HTTP Request"), organizationId: undefined },
      },
      body
    );

    expect(body).not.toHaveBeenCalled();
    expect(getOrgPlan).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, code: "upgrade_required" });
  });

  it("never runs the HTTP request body through the real step wrapper", async () => {
    const result = await httpRequestStep({
      endpoint: "https://example.com",
      httpMethod: "GET",
      _context: contextFor("HTTP Request"),
    });

    expect(httpRequest).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, code: "upgrade_required" });
  });

  it.each(["pro", "business", "enterprise"] as const)(
    "runs a gated step for a %s org",
    async (plan) => {
      vi.mocked(getOrgPlan).mockResolvedValue(plan);
      const body = vi.fn(() => Promise.resolve(ran));

      const result = await withStepLogging(
        { _context: contextFor("HTTP Request") },
        body
      );

      expect(body).toHaveBeenCalledTimes(1);
      expect(result).toBe(ran);
    }
  );

  it.each(["Condition", "web3/read-contract", "trigger"])(
    "does not read the plan for ungated %s",
    async (nodeType) => {
      const body = vi.fn(() => Promise.resolve(ran));

      const result = await withStepLogging(
        { _context: contextFor(nodeType) },
        body
      );

      expect(getOrgPlan).not.toHaveBeenCalled();
      expect(body).toHaveBeenCalledTimes(1);
      expect(result).toBe(ran);
    }
  );

  it("does not block when billing is disabled", async () => {
    vi.mocked(isBillingEnabled).mockReturnValue(false);
    const body = vi.fn(() => Promise.resolve(ran));

    const result = await withStepLogging(
      { _context: contextFor("HTTP Request") },
      body
    );

    expect(getOrgPlan).not.toHaveBeenCalled();
    expect(body).toHaveBeenCalledTimes(1);
    expect(result).toBe(ran);
  });
});
