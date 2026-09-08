import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const enforcePolicy = vi.fn();
const logStepStartDb = vi.fn();
const logStepCompleteDb = vi.fn();

vi.mock("@/lib/policy/guard", () => ({
  enforcePolicy: (...a: unknown[]) => enforcePolicy(...a),
}));
vi.mock("@/lib/workflow/executor/logging", () => ({
  logStepStartDb: (...a: unknown[]) => logStepStartDb(...a),
  logStepCompleteDb: (...a: unknown[]) => logStepCompleteDb(...a),
}));
vi.mock("@/lib/policy/price", () => ({
  withUsdValue: (facts: unknown) => Promise.resolve(facts),
}));
vi.mock("@/lib/policy/catalog/call-capability", () => ({
  resolveCallCapability: ({ fallback }: { fallback: string }) =>
    Promise.resolve(fallback),
}));
vi.mock("@/lib/security/org-role", () => ({
  getOrgRole: async () => "member",
}));

const { policyCheckStep } = await import(
  "@/lib/workflow/executor/policy-check.step"
);

const INPUT = {
  actionType: "web3/read-contract",
  config: { network: "1", contractAddress: "0xabc" },
  organizationId: "org_1",
  executionId: "exec_1",
  nodeId: "read-blocked",
  nodeName: "Read the refused address",
  workflowId: "wf_1",
};

beforeEach(() => {
  vi.clearAllMocks();
  logStepStartDb.mockResolvedValue({ logId: "log_1", startTime: 0 });
  logStepCompleteDb.mockResolvedValue(undefined);
});

describe("a refused node is visible in the run", () => {
  it("records a failed step, so the run does not look like it finished early", async () => {
    // The bug this replaces: policy refused before any step row existed, so a
    // blocked run showed a single successful trigger and nothing else. The
    // decision was in the policy log, which is not where anybody looks.
    enforcePolicy.mockResolvedValue({
      blocked: true,
      decision: { reason: "explicit_deny", outcome: "deny", matched: [] },
    });

    const result = await policyCheckStep(INPUT as never);

    expect(result.blocked).toBe(true);
    expect(logStepStartDb).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: "exec_1",
        nodeId: "read-blocked",
        nodeName: "Read the refused address",
      })
    );
    expect(logStepCompleteDb).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error", error: result.message })
    );
  });

  it("says why on the step, in the words the runner sees", async () => {
    enforcePolicy.mockResolvedValue({
      blocked: true,
      decision: { reason: "explicit_deny", outcome: "deny", matched: [] },
    });
    await policyCheckStep(INPUT as never);
    const [{ error }] = logStepCompleteDb.mock.calls[0] as [{ error: string }];
    expect(error).toMatch(/polic/i);
  });

  it("writes no step when the action is permitted", async () => {
    enforcePolicy.mockResolvedValue({
      blocked: false,
      decision: { reason: "unmanaged", outcome: "unmanaged", matched: [] },
    });
    await policyCheckStep(INPUT as never);
    expect(logStepStartDb).not.toHaveBeenCalled();
  });

  it("still refuses when the step cannot be recorded", async () => {
    // Logging is how a refusal is seen, not how it is enforced. A database
    // that will not take the row must not turn a refusal into permission.
    enforcePolicy.mockResolvedValue({
      blocked: true,
      decision: { reason: "explicit_deny", outcome: "deny", matched: [] },
    });
    logStepStartDb.mockRejectedValue(new Error("database is down"));
    const result = await policyCheckStep(INPUT as never);
    expect(result.blocked).toBe(true);
  });
});
