import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks -- available to vi.mock factories which run before any imports
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  validateApiKey: vi.fn(),
  checkRateLimit: vi.fn(),
  enforceExecutionLimit: vi.fn(),
  enterApiExecuteErrorContext: vi.fn(),
  checkAndReserveExecution: vi.fn(),
  requireWallet: vi.fn(),
  createExecution: vi.fn(),
  markRunning: vi.fn(),
  completeExecution: vi.fn(),
  failExecution: vi.fn(),
  setRetryCount: vi.fn(),
  redactInput: vi.fn(),
  resolveAction: vi.fn(),
  stepFn: vi.fn(),
  ownershipResult: [] as unknown[],
  capturedInput: undefined as Record<string, unknown> | undefined,
}));

vi.mock("server-only", () => ({}));

vi.mock("@/app/api/execute/_lib/auth", () => ({
  validateApiKey: mocks.validateApiKey,
}));

vi.mock("@/app/api/execute/_lib/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
}));

vi.mock("@/lib/billing/execution-guard", () => ({
  enforceExecutionLimit: mocks.enforceExecutionLimit,
}));

vi.mock("@/lib/db/org-helpers", () => ({
  enterApiExecuteErrorContext: mocks.enterApiExecuteErrorContext,
}));

vi.mock("@/app/api/execute/_lib/spending-cap", () => ({
  checkAndReserveExecution: mocks.checkAndReserveExecution,
}));

vi.mock("@/app/api/execute/_lib/concurrency-limit", () => ({
  enforceDirectExecutionConcurrency: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/app/api/execute/_lib/wallet-check", () => ({
  requireWallet: mocks.requireWallet,
}));

vi.mock("@/app/api/execute/_lib/execution-service", async (importActual) => {
  // Keep the real (pure) helpers like withRejectedSignerOverride; only the
  // DB-touching functions are replaced with mocks.
  const actual =
    await importActual<
      typeof import("@/app/api/execute/_lib/execution-service")
    >();
  return {
    ...actual,
    createExecution: mocks.createExecution,
    markRunning: mocks.markRunning,
    completeExecution: mocks.completeExecution,
    failExecution: mocks.failExecution,
    setRetryCount: mocks.setRetryCount,
    redactInput: mocks.redactInput,
  };
});

vi.mock("@/app/api/execute/_lib/action-resolver", () => ({
  resolveAction: mocks.resolveAction,
}));

vi.mock("@/lib/utils", () => ({
  getErrorMessage: (err: unknown) =>
    err instanceof Error ? err.message : String(err),
}));

vi.mock("@/lib/db/schema", () => ({
  integrations: { id: "id", organizationId: "organizationId" },
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve(mocks.ownershipResult)),
        })),
      })),
    })),
  },
}));

// ---------------------------------------------------------------------------
// Route import (after mocks are registered)
// ---------------------------------------------------------------------------

import { POST as nodePOST } from "@/app/api/execute/node/route";

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

const AUTH_CONTEXT = { organizationId: "org_a", apiKeyId: "kh_1" };
const AUTH_HEADER = { Authorization: "Bearer kh_test123" };

function postRequest(body: unknown): Request {
  return new Request("http://localhost:3000/api/execute/node", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ownershipResult = [];
  mocks.capturedInput = undefined;

  mocks.validateApiKey.mockResolvedValue(AUTH_CONTEXT);
  mocks.checkRateLimit.mockReturnValue({ allowed: true });
  mocks.enforceExecutionLimit.mockResolvedValue({ blocked: false });
  mocks.enterApiExecuteErrorContext.mockResolvedValue(undefined);
  mocks.requireWallet.mockResolvedValue(null);
  mocks.checkAndReserveExecution.mockResolvedValue({
    allowed: true,
    executionId: "ex1",
  });
  mocks.createExecution.mockResolvedValue({ executionId: "ex1" });
  mocks.markRunning.mockResolvedValue(undefined);
  mocks.completeExecution.mockResolvedValue({ status: "completed" });
  mocks.failExecution.mockResolvedValue(undefined);
  mocks.setRetryCount.mockResolvedValue(undefined);
  mocks.redactInput.mockImplementation(
    (input: Record<string, unknown>) => input
  );

  mocks.stepFn.mockImplementation((input: Record<string, unknown>) => {
    mocks.capturedInput = input;
    return Promise.resolve({ success: true });
  });

  mocks.resolveAction.mockImplementation((actionType: string) => ({
    actionType,
    label: "Test Action",
    importer: {
      importer: () => Promise.resolve({ step: mocks.stepFn }),
      stepFunction: "step",
    },
    isPluginAction: true,
  }));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/execute/node reserved-field gating", () => {
  it("rejects a foreign integrationId smuggled inside config with 403", async () => {
    mocks.ownershipResult = [];

    const response = await nodePOST(
      postRequest({
        actionType: "discord/send-message",
        config: { integrationId: "int_foreign", message: "hi" },
      })
    );

    expect(response.status).toBe(403);
    expect(mocks.checkAndReserveExecution).not.toHaveBeenCalled();
    expect(mocks.stepFn).not.toHaveBeenCalled();
  });

  it("gates a network smuggled inside config through wallet + spending cap", async () => {
    const response = await nodePOST(
      postRequest({
        actionType: "web3/write-contract",
        config: { network: "1", contractAddress: "0xabc" },
      })
    );

    expect(response.status).toBe(200);
    expect(mocks.requireWallet).toHaveBeenCalledTimes(1);
    expect(mocks.checkAndReserveExecution).toHaveBeenCalledTimes(1);
    expect(mocks.checkAndReserveExecution).toHaveBeenCalledWith(
      expect.objectContaining({ network: "1" })
    );
    expect(mocks.capturedInput?.network).toBe("1");
    expect(
      (
        (mocks.capturedInput as { _context: unknown })._context as {
          organizationId: string;
        }
      ).organizationId
    ).toBe("org_a");
    // The route reserved the value itself, so the step wrapper is told not to
    // reserve again (prevents the node route double-charging the cap).
    expect(
      (
        (mocks.capturedInput as { _context: unknown })._context as {
          valueCapReserved: boolean;
        }
      ).valueCapReserved
    ).toBe(true);
  });

  it("ignores a caller-supplied _context and always sets the trusted org", async () => {
    const response = await nodePOST(
      postRequest({
        actionType: "web3/write-contract",
        config: { network: "1", _context: { organizationId: "evil" } },
      })
    );

    expect(response.status).toBe(200);
    expect(
      (
        (mocks.capturedInput as { _context: unknown })._context as {
          organizationId: string;
        }
      ).organizationId
    ).toBe("org_a");
  });

  it("strips a caller-supplied web3Connection so it cannot weaken the signer mode", async () => {
    const response = await nodePOST(
      postRequest({
        actionType: "web3/write-contract",
        config: {
          network: "1",
          contractAddress: "0xabc",
          // Attempt to force the org Turnkey EOA and bypass the Safe's
          // Zodiac Roles policy on an org-custodied write.
          web3Connection: "eoa",
        },
      })
    );

    expect(response.status).toBe(200);
    // The step must never see web3Connection: with it absent,
    // resolveSignerForNode falls back to the org-policy (Safe + Role) path.
    // The _rejectedConfig marker is audit-only and must not leak to the step.
    expect(mocks.capturedInput).toBeDefined();
    expect("web3Connection" in (mocks.capturedInput ?? {})).toBe(false);
    expect("_rejectedConfig" in (mocks.capturedInput ?? {})).toBe(false);
  });

  it("records a non-honored web3Connection under _rejectedConfig in the audit input", async () => {
    const response = await nodePOST(
      postRequest({
        actionType: "web3/write-contract",
        config: {
          network: "1",
          contractAddress: "0xabc",
          web3Connection: "eoa",
          _context: { spoofed: true },
        },
      })
    );

    expect(response.status).toBe(200);
    // The execution-audit record is the `input` reserved through the spending
    // cap. web3Connection must not appear at the top level (it did not
    // influence this org-custodied write) but is preserved under
    // _rejectedConfig so the audit log still shows the bypass attempt.
    expect(mocks.checkAndReserveExecution).toHaveBeenCalledTimes(1);
    const auditInput = mocks.checkAndReserveExecution.mock.calls[0]?.[0]
      ?.input as Record<string, unknown>;
    expect(auditInput).toBeDefined();
    expect("web3Connection" in auditInput).toBe(false);
    expect("network" in auditInput).toBe(false);
    expect("integrationId" in auditInput).toBe(false);
    expect("_context" in auditInput).toBe(false);
    expect(auditInput.contractAddress).toBe("0xabc");
    expect(auditInput._rejectedConfig).toEqual({ web3Connection: "eoa" });
  });

  it("omits _rejectedConfig from the audit input when no override was sent", async () => {
    const response = await nodePOST(
      postRequest({
        actionType: "web3/write-contract",
        config: { network: "1", contractAddress: "0xabc" },
      })
    );

    expect(response.status).toBe(200);
    const auditInput = mocks.checkAndReserveExecution.mock.calls[0]?.[0]
      ?.input as Record<string, unknown>;
    expect(auditInput).toBeDefined();
    expect("_rejectedConfig" in auditInput).toBe(false);
  });

  it("passes an owned top-level integrationId through to the step", async () => {
    mocks.ownershipResult = [{ id: "int_mine" }];

    const response = await nodePOST(
      postRequest({
        actionType: "discord/send-message",
        integrationId: "int_mine",
        config: { message: "hi" },
      })
    );

    expect([200, 202]).toContain(response.status);
    expect(mocks.capturedInput?.integrationId).toBe("int_mine");
  });

  it("rejects a retry budget that would outlive the idempotency lock (H3)", async () => {
    const response = await nodePOST(
      postRequest({
        actionType: "web3/write-contract",
        config: { network: "1", contractAddress: "0xabc" },
        retry: { maxRetries: 10, timeoutMs: 600_000 },
      })
    );

    expect(response.status).toBe(400);
    expect(mocks.checkAndReserveExecution).not.toHaveBeenCalled();
    expect(mocks.stepFn).not.toHaveBeenCalled();
  });

  it("accepts a retry budget within the lock TTL", async () => {
    const response = await nodePOST(
      postRequest({
        actionType: "web3/write-contract",
        config: { network: "1", contractAddress: "0xabc" },
        retry: { maxRetries: 3, timeoutMs: 120_000 },
      })
    );

    expect([200, 202]).toContain(response.status);
  });
});
