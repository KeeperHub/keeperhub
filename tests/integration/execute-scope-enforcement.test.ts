/**
 * A-03: OAuth token scope is enforced at the REST sinks that MCP tools forward
 * to. A token scoped mcp:read only (blocked by the MCP tool wrapper on write
 * tools) must also be rejected when posted directly to the underlying REST
 * route. A non-OAuth caller (scope undefined: kh_ key / session / internal)
 * keeps full access.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  validateApiKey: vi.fn(),
  checkRateLimit: vi.fn(),
  checkAndReserveExecution: vi.fn(),
  markRunning: vi.fn(),
  completeExecution: vi.fn(),
  failExecution: vi.fn(),
  redactInput: vi.fn(),
  transferFundsCore: vi.fn(),
  transferTokenCore: vi.fn(),
  getDualAuthContext: vi.fn(),
  validateWorkflowIntegrations: vi.fn(),
  insert: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/app/api/execute/_lib/auth", () => ({
  validateApiKey: mocks.validateApiKey,
}));

vi.mock("@/app/api/execute/_lib/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
}));

vi.mock("@/app/api/execute/_lib/spending-cap", () => ({
  checkAndReserveExecution: mocks.checkAndReserveExecution,
}));

vi.mock("@/app/api/execute/_lib/concurrency-limit", () => ({
  enforceDirectExecutionConcurrency: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/app/api/execute/_lib/execution-service", async (importActual) => {
  const actual =
    await importActual<
      typeof import("@/app/api/execute/_lib/execution-service")
    >();
  return {
    ...actual,
    markRunning: mocks.markRunning,
    completeExecution: mocks.completeExecution,
    failExecution: mocks.failExecution,
    redactInput: mocks.redactInput,
  };
});

vi.mock("@/plugins/web3/steps/transfer-funds-core", () => ({
  transferFundsCore: mocks.transferFundsCore,
}));

vi.mock("@/plugins/web3/steps/transfer-token-core", () => ({
  transferTokenCore: mocks.transferTokenCore,
}));

vi.mock("@/app/api/execute/_lib/wallet-check", () => ({
  requireWallet: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/billing/execution-guard", () => ({
  enforceExecutionLimit: vi
    .fn()
    .mockResolvedValue({ blocked: false, limitResult: null }),
  EXECUTION_LIMIT_ERROR: "Monthly execution limit exceeded",
  EXECUTION_DEBT_ERROR: "Executions suspended due to unpaid overage invoice.",
}));

vi.mock("@/lib/middleware/auth-helpers", () => ({
  getDualAuthContext: mocks.getDualAuthContext,
}));

vi.mock("@/lib/db/integrations", () => ({
  validateWorkflowIntegrations: mocks.validateWorkflowIntegrations,
}));

vi.mock("@/lib/features/route-guard", () => ({
  enforceWorkflowFeatures: vi.fn().mockResolvedValue({ blocked: false }),
  FEATURE_UPGRADE_REQUIRED_ERROR:
    "This workflow uses features that require a paid plan.",
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "DATABASE" },
  logSystemError: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    insert: mocks.insert,
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve([])) })),
      })),
    })),
    query: { workflows: { findFirst: vi.fn() } },
  },
}));

vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock("@/lib/workflow/access", () => ({
  getWorkflowAccess: vi.fn(),
}));

import { POST as transferPOST } from "@/app/api/execute/transfer/route";
import { DELETE as executionsDELETE } from "@/app/api/workflows/[workflowId]/executions/route";
import { POST as createPOST } from "@/app/api/workflows/create/route";
import { POST as importPOST } from "@/app/api/workflows/import/route";

function transferRequest(body: unknown): Request {
  return new Request("http://localhost:3000/api/execute/transfer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function createRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost:3000/api/workflows/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const VALID_TRANSFER = {
  network: "ethereum",
  recipientAddress: "0x1234567890123456789012345678901234567890",
  amount: "1.0",
};

describe("A-03 scope enforcement — POST /api/execute/transfer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkRateLimit.mockReturnValue({ allowed: true });
    mocks.checkAndReserveExecution.mockResolvedValue({
      allowed: true,
      executionId: "exec_1",
    });
    mocks.redactInput.mockImplementation((input: unknown) => input);
    mocks.markRunning.mockResolvedValue(undefined);
    mocks.completeExecution.mockResolvedValue({ status: "completed" });
    mocks.transferFundsCore.mockResolvedValue({
      success: true,
      transactionHash: "0xhash",
      transactionLink: "https://example.com/0xhash",
    });
  });

  it("rejects a read-only OAuth token with 403 insufficient_scope", async () => {
    mocks.validateApiKey.mockResolvedValue({
      organizationId: "org_1",
      apiKeyId: "oauth:u",
      scope: "mcp:read",
    });

    const response = await transferPOST(transferRequest(VALID_TRANSFER));

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe("insufficient_scope");
    expect(body.required_scope).toBe("mcp:write");
  });

  it("allows a caller with no scope (kh_ key / undefined) past the guard", async () => {
    mocks.validateApiKey.mockResolvedValue({
      organizationId: "org_1",
      apiKeyId: "key_test",
    });

    const response = await transferPOST(transferRequest(VALID_TRANSFER));

    expect(response.status).not.toBe(403);
  });

  it("allows a read+write OAuth token past the guard", async () => {
    mocks.validateApiKey.mockResolvedValue({
      organizationId: "org_1",
      apiKeyId: "oauth:u",
      scope: "mcp:read mcp:write",
    });

    const response = await transferPOST(transferRequest(VALID_TRANSFER));

    expect(response.status).not.toBe(403);
  });
});

describe("A-03 scope enforcement — POST /api/workflows/create", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.validateWorkflowIntegrations.mockResolvedValue({ valid: true });
  });

  const invalidWorkflowBody = {
    name: "Scope test workflow",
    nodes: [
      {
        id: "node-1",
        type: "action",
        data: {
          type: "action",
          config: { actionType: "discord/send-message", Message: "hello" },
        },
      },
    ],
    edges: [],
  };

  it("rejects a read-only OAuth token with 403 insufficient_scope", async () => {
    mocks.getDualAuthContext.mockResolvedValue({
      userId: "user_1",
      organizationId: "org_1",
      authMethod: "oauth",
      apiKeyId: null,
      scope: "mcp:read",
    });

    const response = await createPOST(createRequest(invalidWorkflowBody));

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe("insufficient_scope");
    expect(body.required_scope).toBe("mcp:write");
  });

  it("allows a session caller (scope undefined) past the guard", async () => {
    mocks.getDualAuthContext.mockResolvedValue({
      userId: "user_1",
      organizationId: "org_1",
      authMethod: "session",
      apiKeyId: null,
    });

    const response = await createPOST(createRequest(invalidWorkflowBody));

    const body = await response.json();
    expect(response.status).not.toBe(403);
    expect(body.error).not.toBe("insufficient_scope");
  });
});

function importRequest(body: unknown): Request {
  return new Request("http://localhost:3000/api/workflows/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("A-03 scope enforcement — POST /api/workflows/import", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a read-only OAuth token with 403 insufficient_scope", async () => {
    mocks.getDualAuthContext.mockResolvedValue({
      userId: "user_1",
      organizationId: "org_1",
      authMethod: "oauth",
      apiKeyId: null,
      scope: "mcp:read",
    });

    const response = await importPOST(importRequest({ version: 1 }));

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe("insufficient_scope");
    expect(body.required_scope).toBe("mcp:write");
  });

  it("allows a non-OAuth caller (scope undefined) past the guard", async () => {
    mocks.getDualAuthContext.mockResolvedValue({
      userId: "user_1",
      organizationId: "org_1",
      authMethod: "api_key",
      apiKeyId: "key_test",
    });

    const response = await importPOST(importRequest({ version: 1 }));

    const body = await response.json();
    expect(response.status).not.toBe(403);
    expect(body.error).not.toBe("insufficient_scope");
  });
});

function executionsDeleteRequest(): Request {
  return new Request("http://localhost:3000/api/workflows/wf_1/executions", {
    method: "DELETE",
  });
}

describe("A-03 scope enforcement — DELETE /api/workflows/[workflowId]/executions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a read-only OAuth token with 403 insufficient_scope", async () => {
    mocks.getDualAuthContext.mockResolvedValue({
      userId: "user_1",
      organizationId: "org_1",
      authMethod: "oauth",
      apiKeyId: null,
      scope: "mcp:read",
    });

    const response = await executionsDELETE(executionsDeleteRequest(), {
      params: Promise.resolve({ workflowId: "wf_1" }),
    });

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe("insufficient_scope");
    expect(body.required_scope).toBe("mcp:write");
  });

  it("allows a non-OAuth caller (scope undefined) past the guard", async () => {
    mocks.getDualAuthContext.mockResolvedValue({
      userId: "user_1",
      organizationId: "org_1",
      authMethod: "api_key",
      apiKeyId: "key_test",
    });

    const response = await executionsDELETE(executionsDeleteRequest(), {
      params: Promise.resolve({ workflowId: "wf_1" }),
    });

    expect(response.status).not.toBe(403);
  });
});
