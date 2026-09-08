import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const enforcePolicy = vi.fn();
vi.mock("@/lib/policy/guard", () => ({
  enforcePolicy: (...a: unknown[]) => enforcePolicy(...a),
}));
vi.mock("@/lib/workflow/executor/logging", () => ({
  logStepStartDb: async () => ({ logId: "l", startTime: 0 }),
  logStepCompleteDb: async () => undefined,
}));
vi.mock("@/lib/policy/price", () => ({
  withUsdValue: (f: unknown) => Promise.resolve(f),
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

const base = {
  actionType: "HTTP Request",
  organizationId: "org_1",
  executionId: "exec_1",
  nodeId: "http-1",
  workflowId: "wf_1",
};

beforeEach(() => {
  vi.clearAllMocks();
  enforcePolicy.mockResolvedValue({
    blocked: true,
    decision: { reason: "explicit_deny", outcome: "deny", matched: [] },
  });
});

describe("what the platform refuses is not a policy question", () => {
  it.each([
    "http://169.254.169.254/latest/meta-data/",
    "http://127.0.0.1:8080/",
    "http://10.1.2.3/internal",
    "http://[::ffff:169.254.169.254]/",
  ])("stands aside for %s, so the guard reports it", async (endpoint) => {
    // The SSRF guard blocks these for every organization and says which host,
    // which resolved address and why. Refusing first would replace that with a
    // policy message that is both less useful and untrue about the cause.
    const result = await policyCheckStep({
      ...base,
      config: { endpoint },
    } as never);
    expect(result.blocked).toBe(false);
    expect(enforcePolicy).not.toHaveBeenCalled();
  });

  it("is not consulted at all, so no rule can permit an internal address", async () => {
    // The point is stronger than "a deny is redundant here". Policy is never
    // asked, so an allow cannot make one of these reachable either: whatever a
    // rule says, the request still meets the guard.
    enforcePolicy.mockResolvedValue({
      blocked: false,
      decision: { reason: "explicit_allow", outcome: "allow", matched: [] },
    });
    await policyCheckStep({
      ...base,
      config: { endpoint: "http://169.254.169.254/latest/meta-data/" },
    } as never);
    expect(enforcePolicy).not.toHaveBeenCalled();
  });

  it("still judges a host the platform allows", async () => {
    const result = await policyCheckStep({
      ...base,
      config: { endpoint: "https://api.github.com/zen" },
    } as never);
    expect(result.blocked).toBe(true);
    expect(enforcePolicy).toHaveBeenCalled();
  });

  it("judges a hostname, which it cannot resolve without DNS", async () => {
    // A name that resolves somewhere internal is caught by the guard at request
    // time. Guessing here would let a rule be dodged by naming a host.
    const result = await policyCheckStep({
      ...base,
      config: { endpoint: "https://internal.example.com/" },
    } as never);
    expect(result.blocked).toBe(true);
  });
});
