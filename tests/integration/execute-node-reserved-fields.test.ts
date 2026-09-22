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

vi.mock("@/lib/utils", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/utils")>("@/lib/utils");
  return {
    ...actual,
    getErrorMessage: (err: unknown) =>
      err instanceof Error ? err.message : String(err),
  };
});

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
  mocks.failExecution.mockResolvedValue({ status: "failed" });
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

  it("keeps a smuggled _actionType and _protocolMeta out of the audit input's top level", async () => {
    const response = await nodePOST(
      postRequest({
        actionType: "web3/write-contract",
        config: {
          network: "1",
          contractAddress: "0xabc",
          // Both are route-owned: the route injects _actionType from the
          // resolved action, and _protocolMeta is a builder-persisted snapshot
          // of the same thing that a derivable _actionType always beats.
          _actionType: "sky/vault-deposit",
          _protocolMeta: '{"protocolSlug":"sky","contractKey":"sUsds"}',
        },
      })
    );

    expect(response.status).toBe(200);
    // Neither may sit beside contractAddress, which did take effect.
    const auditInput = mocks.checkAndReserveExecution.mock.calls[0]?.[0]
      ?.input as Record<string, unknown>;
    expect(auditInput).toBeDefined();
    expect("_actionType" in auditInput).toBe(false);
    expect("_protocolMeta" in auditInput).toBe(false);
    expect(auditInput.contractAddress).toBe("0xabc");
    expect(auditInput._rejectedConfig).toEqual({
      _actionType: "sky/vault-deposit",
      _protocolMeta: '{"protocolSlug":"sky","contractKey":"sUsds"}',
    });
    // The step sees the route's action type and no stale snapshot at all.
    expect(mocks.capturedInput?._actionType).toBe("web3/write-contract");
    expect("_protocolMeta" in (mocks.capturedInput ?? {})).toBe(false);
    expect("_rejectedConfig" in (mocks.capturedInput ?? {})).toBe(false);
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

  it("budgets an absent maxRetries at the default the executor will apply", async () => {
    // The validator used to default a missing count to 0, so this was checked
    // as one attempt of 600000ms - inside the budget - and then run by
    // resolveConfig as four, up to 2_400_000ms: four times the idempotency
    // processing lock this budget exists to stay inside.
    //
    // A run that long does not lose its lock on its own. withIdempotencyHeartbeat
    // re-stamps expiresAt every couple of minutes and the reclaim is fenced on
    // an expired row, so the lock only lapses if the heartbeat also fails - and
    // it is fire-and-forget with an empty catch. The budget is the invariant
    // that keeps a request inside its own reservation without depending on
    // that; this pins the arithmetic, not the failure mode.
    const response = await nodePOST(
      postRequest({
        actionType: "web3/write-contract",
        config: { network: "1", contractAddress: "0xabc" },
        retry: { timeoutMs: 600_000 },
      })
    );

    expect(response.status).toBe(400);
    expect(mocks.checkAndReserveExecution).not.toHaveBeenCalled();
    expect(mocks.stepFn).not.toHaveBeenCalled();
  });

  it("names the effective attempt count and the safe remedy in the rejection", async () => {
    // Without the attempt count the arithmetic reads as self-contradicting to
    // a caller who sent no maxRetries: they compute 600000 x (0 + 1), which is
    // not over the limit.
    //
    // Naming maxRetries: 0 is the safety-relevant half. The apparent remedy is
    // to lower timeoutMs, and a timeoutMs under the chain's confirmation
    // latency is what turns one slow write into several: withTimeout races a
    // setTimeout rather than cancelling, so an abandoned attempt can still
    // broadcast while the next one signs at the next nonce.
    const response = await nodePOST(
      postRequest({
        actionType: "web3/write-contract",
        config: { network: "1", contractAddress: "0xabc" },
        retry: { timeoutMs: 600_000 },
      })
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toContain("4 attempts");
    expect(body.error).toContain("maxRetries defaults to 3");
    expect(body.error).toContain("2400000ms");
    expect(body.error).toContain("maxRetries: 0");
  });

  it("omits the defaulting note when the caller set maxRetries itself", async () => {
    const response = await nodePOST(
      postRequest({
        actionType: "web3/write-contract",
        config: { network: "1", contractAddress: "0xabc" },
        retry: { maxRetries: 10, timeoutMs: 600_000 },
      })
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toContain("11 attempts");
    expect(body.error).not.toContain("defaults to");
  });

  it("still accepts an absent maxRetries whose defaulted budget fits", async () => {
    // The counterpart to the case above: defaulting to DEFAULT_MAX_RETRIES
    // must not reject everything that omits the field. 4 x 120000 = 480000,
    // inside the 600000ms lock TTL.
    const response = await nodePOST(
      postRequest({
        actionType: "web3/write-contract",
        config: { network: "1", contractAddress: "0xabc" },
        retry: { timeoutMs: 120_000 },
      })
    );

    expect([200, 202]).toContain(response.status);
  });

  it("budgets an explicit maxRetries of 0 as the single attempt it is", async () => {
    // Defaulting must not become clamping: 0 is a meaningful value that
    // resolveConfig honours via ??, so one attempt of 600000ms is exactly the
    // budget and stays admissible.
    const response = await nodePOST(
      postRequest({
        actionType: "web3/write-contract",
        config: { network: "1", contractAddress: "0xabc" },
        retry: { maxRetries: 0, timeoutMs: 600_000 },
      })
    );

    expect([200, 202]).toContain(response.status);
  });

  it("accepts an empty retry object at both of the executor's defaults", async () => {
    // The only request shape where maxRetries and timeoutMs are both
    // defaulted, and the pair only became load-bearing here: 4 x 120000 =
    // 480000 now fills most of the 600000ms lock where the single-attempt
    // reading left it at 120000. Every other case above pins timeoutMs
    // explicitly, so raising DEFAULT_TIMEOUT_MS past 150000 would start
    // rejecting every caller that sends `retry: {}` with nothing to catch it.
    const response = await nodePOST(
      postRequest({
        actionType: "web3/write-contract",
        config: { network: "1", contractAddress: "0xabc" },
        retry: {},
      })
    );

    expect([200, 202]).toContain(response.status);
  });
});

describe("POST /api/execute/node broadcast hash on a failed step", () => {
  it("hands the step's hash to failExecution and reports its verdict", async () => {
    // The adapter threw after broadcasting, so the step returns the hash with
    // success: false. Sibling routes already forward it; this one used to drop
    // it and stamp a terminal failure, leaving the transaction on-chain and
    // outside the reconciler's unconfirmed-with-a-hash scan.
    mocks.stepFn.mockResolvedValue({
      success: false,
      error: "Transaction sent but receipt not available",
      transactionHash: "0xpending",
      chainId: 1,
    });
    mocks.failExecution.mockResolvedValue({ status: "unconfirmed" });

    const response = await nodePOST(
      postRequest({
        actionType: "web3/write-contract",
        config: { network: "1", contractAddress: "0xabc" },
      })
    );

    expect(mocks.failExecution).toHaveBeenCalledWith(
      "ex1",
      "Transaction sent but receipt not available",
      expect.objectContaining({ transactionHash: "0xpending", chainId: 1 })
    );
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe("unconfirmed");
    expect(body.transactionHash).toBe("0xpending");
    // The route groups an unconfirmed transaction with a failed one at the
    // transport layer, same as its verified-success branch; only the body
    // distinguishes them.
    expect(response.status).toBe(422);
  });

  it("forwards the request's action type to the step as _actionType", async () => {
    // The protocol steps only apply the chain-scoped L2 slug aliases on the
    // _actionType branch of resolveProtocolMeta. Without this field a node
    // executed here resolves from whatever _protocolMeta the caller carried,
    // so an old slug on an L2 fails while the same node succeeds through the
    // workflow executor.
    const response = await nodePOST(
      postRequest({
        actionType: "sky/vault-balance",
        network: "8453",
        config: { account: "0xabc" },
      })
    );

    expect(response.status).toBe(200);
    expect(mocks.capturedInput?._actionType).toBe("sky/vault-balance");
  });

  it("forwards the canonical action type when the request named the action by label", async () => {
    // resolveAction accepts a legacy id or an exact label and hands back the
    // canonical `<protocol>/<slug>` id. The raw request string derives nothing
    // in resolveProtocolMeta, so forwarding it would run the right step and
    // then leave it resolving from whatever _protocolMeta the caller carried -
    // the hole the _actionType forward exists to close.
    mocks.resolveAction.mockImplementation(() => ({
      actionType: "sky/vault-balance",
      label: "Sky: Vault Share Balance",
      importer: {
        importer: () => Promise.resolve({ step: mocks.stepFn }),
        stepFunction: "step",
      },
      isPluginAction: true,
    }));

    const response = await nodePOST(
      postRequest({
        actionType: "Sky: Vault Share Balance",
        network: "8453",
        config: { account: "0xabc" },
      })
    );

    expect(response.status).toBe(200);
    expect(mocks.capturedInput?._actionType).toBe("sky/vault-balance");
  });

  it("overrides an _actionType smuggled inside config", async () => {
    const response = await nodePOST(
      postRequest({
        actionType: "sky/vault-balance",
        network: "8453",
        config: { account: "0xabc", _actionType: "sky/vault-deposit" },
      })
    );

    expect(response.status).toBe(200);
    expect(mocks.capturedInput?._actionType).toBe("sky/vault-balance");
  });

  it("still reports a pre-broadcast failure as terminal with no hash", async () => {
    mocks.stepFn.mockResolvedValue({
      success: false,
      error: "insufficient funds",
    });

    const response = await nodePOST(
      postRequest({
        actionType: "web3/write-contract",
        config: { network: "1", contractAddress: "0xabc" },
      })
    );

    expect(response.status).toBe(422);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe("failed");
    expect(body.transactionHash).toBeUndefined();
  });
});
