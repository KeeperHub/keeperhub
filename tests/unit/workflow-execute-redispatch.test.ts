/**
 * Execute-route redispatch guard: refuse terminal / running reuse before PAYG.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("workflow/api", () => ({ start: vi.fn() }));

const {
  mockAuthenticateInternalService,
  mockLoadWorkflowForExecution,
  mockValidateWorkflowIntegrations,
  mockEnforceWorkflowFeatures,
  mockEnforceExecutionLimit,
  mockCheckConcurrencyLimit,
  mockBeginIdempotentFromRequest,
  mockRecordIdempotentResponse,
  mockFindExecution,
  mockInsertValues,
  mockChargePaygIfBillable,
  mockExecuteWorkflowInBackground,
  mockResolveExecutionOrgMetadata,
} = vi.hoisted(() => ({
  mockAuthenticateInternalService: vi.fn(),
  mockLoadWorkflowForExecution: vi.fn(),
  mockValidateWorkflowIntegrations: vi.fn(),
  mockEnforceWorkflowFeatures: vi.fn(),
  mockEnforceExecutionLimit: vi.fn(),
  mockCheckConcurrencyLimit: vi.fn(),
  mockBeginIdempotentFromRequest: vi.fn(),
  mockRecordIdempotentResponse: vi.fn(),
  mockFindExecution: vi.fn(),
  mockInsertValues: vi.fn(),
  mockChargePaygIfBillable: vi.fn(),
  mockExecuteWorkflowInBackground: vi.fn(),
  mockResolveExecutionOrgMetadata: vi.fn(),
}));

vi.mock("@/lib/internal-service-auth", () => ({
  authenticateInternalService: mockAuthenticateInternalService,
}));

vi.mock("@/lib/workflow/load-for-execution", () => ({
  loadWorkflowForExecution: mockLoadWorkflowForExecution,
}));

vi.mock("@/lib/db/integrations", () => ({
  validateWorkflowIntegrations: mockValidateWorkflowIntegrations,
}));

vi.mock("@/lib/features/route-guard", () => ({
  enforceWorkflowFeatures: mockEnforceWorkflowFeatures,
}));

vi.mock("@/lib/features", () => ({
  extractActionTypeNodes: vi.fn().mockReturnValue([]),
}));

vi.mock("@/lib/billing/execution-guard", () => ({
  enforceExecutionLimit: mockEnforceExecutionLimit,
}));

vi.mock("@/app/api/execute/_lib/concurrency-limit", () => ({
  checkConcurrencyLimit: mockCheckConcurrencyLimit,
}));

vi.mock("@/lib/idempotency", () => ({
  beginIdempotentFromRequest: mockBeginIdempotentFromRequest,
  idempotencyEarlyResponse: vi.fn().mockReturnValue(null),
  recordIdempotentResponse: mockRecordIdempotentResponse,
}));

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      workflowExecutions: { findFirst: mockFindExecution },
    },
    insert: vi.fn(() => ({
      values: mockInsertValues,
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn().mockResolvedValue(undefined),
      })),
    })),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  workflowExecutions: { id: "id" },
  workflows: { id: "id" },
}));

vi.mock("@/lib/billing/payg/charge", () => ({
  chargePaygIfBillable: mockChargePaygIfBillable,
}));

vi.mock("@/lib/workflow/execute-in-background", () => ({
  executeWorkflowInBackground: mockExecuteWorkflowInBackground,
}));

vi.mock("@/lib/db/org-helpers", () => ({
  resolveExecutionOrgMetadata: mockResolveExecutionOrgMetadata,
}));

vi.mock("@/lib/security/backstop-capture", () => ({
  withBackstopCapture: (_ctx: unknown, fn: () => unknown) => fn(),
}));

vi.mock("@/lib/workflow/content-hash", () => ({
  hashWorkflowDefinition: vi.fn().mockReturnValue("hash"),
}));

vi.mock("@/lib/metrics", () => ({
  getMetricsCollector: () => ({ incrementCounter: vi.fn() }),
}));

vi.mock("@/lib/metrics/types", () => ({
  LabelKeys: { TRIGGER_TYPE: "trigger_type" },
  MetricNames: {
    WORKFLOW_EXECUTIONS_STARTED_TOTAL: "workflow_executions_started_total",
  },
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { WORKFLOW_ENGINE: "workflow_engine" },
  logSystemError: vi.fn(),
}));

vi.mock("@/lib/middleware/auth-helpers", () => ({
  getDualAuthContext: vi.fn(),
}));

vi.mock("@/lib/workflow/access", () => ({
  getWorkflowAccess: vi.fn(),
}));

vi.mock("@/lib/auth-anonymous-guard", () => ({
  logAnonymousExecutionBlock: vi.fn(),
}));

vi.mock("@/lib/middleware/require-scope", () => ({
  requireScope: vi.fn().mockReturnValue(null),
}));

vi.mock("@/lib/mcp/oauth-scopes", () => ({
  SCOPE_MCP_WRITE: "mcp:write",
}));

vi.mock("@/lib/rate-limit-headers", () => ({
  applyRateLimitHeaders: (res: Response) => res,
}));

vi.mock("@/lib/security/request-attribution", () => ({
  buildAttribution: vi.fn().mockReturnValue({}),
  resolveTriggerLabels: vi.fn().mockReturnValue({
    triggerType: "manual",
    triggerSource: "api",
  }),
}));

import { POST } from "@/app/api/workflow/[workflowId]/execute/route";

const WORKFLOW = {
  id: "wf_1",
  userId: "user_1",
  organizationId: "org_1",
  enabled: true,
  nodes: [],
  edges: [],
};

async function callExecute(body: Record<string, unknown>): Promise<Response> {
  const request = new Request("http://localhost/api/workflow/wf_1/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return POST(request, { params: Promise.resolve({ workflowId: "wf_1" }) });
}

describe("workflow execute redispatch guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockAuthenticateInternalService.mockResolvedValue({
      authenticated: true,
      caller: "scheduler",
    });
    mockLoadWorkflowForExecution.mockResolvedValue({
      status: "ok",
      workflow: WORKFLOW,
    });
    mockValidateWorkflowIntegrations.mockResolvedValue({
      valid: true,
      invalidIds: [],
    });
    mockEnforceWorkflowFeatures.mockResolvedValue({ blocked: false });
    mockEnforceExecutionLimit.mockResolvedValue({ blocked: false });
    mockCheckConcurrencyLimit.mockResolvedValue({
      allowed: true,
      running: 0,
      limit: 10,
    });
    mockBeginIdempotentFromRequest.mockResolvedValue({ kind: "proceed" });
    mockRecordIdempotentResponse.mockImplementation(
      async (
        _idem: unknown,
        response: Response,
        _disposition?: string
      ): Promise<Response> => response
    );
    mockChargePaygIfBillable.mockResolvedValue({ applicable: false });
    mockResolveExecutionOrgMetadata.mockResolvedValue({
      slug: "org",
      plan: "free",
    });
    mockInsertValues.mockImplementation(() => {
      const builder = Promise.resolve(undefined) as Promise<undefined> & {
        returning: () => Promise<{ id: string }[]>;
      };
      builder.returning = () => Promise.resolve([{ id: "exec_new" }]);
      return builder;
    });
  });

  it("returns 409 and skips PAYG/start for terminal success", async () => {
    mockFindExecution.mockResolvedValue({
      id: "exec_term",
      status: "success",
    });

    const response = await callExecute({ executionId: "exec_term" });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.code).toBe("execution_already_terminal");
    expect(body.status).toBe("success");
    expect(mockChargePaygIfBillable).not.toHaveBeenCalled();
    expect(mockExecuteWorkflowInBackground).not.toHaveBeenCalled();
    expect(mockRecordIdempotentResponse).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "release"
    );
  });

  it("returns 409 for terminal error and cancelled", async () => {
    for (const status of ["error", "cancelled"] as const) {
      vi.clearAllMocks();
      mockAuthenticateInternalService.mockResolvedValue({
        authenticated: true,
        caller: "scheduler",
      });
      mockLoadWorkflowForExecution.mockResolvedValue({
        status: "ok",
        workflow: WORKFLOW,
      });
      mockValidateWorkflowIntegrations.mockResolvedValue({
        valid: true,
        invalidIds: [],
      });
      mockEnforceWorkflowFeatures.mockResolvedValue({ blocked: false });
      mockEnforceExecutionLimit.mockResolvedValue({ blocked: false });
      mockCheckConcurrencyLimit.mockResolvedValue({
        allowed: true,
        running: 0,
        limit: 10,
      });
      mockBeginIdempotentFromRequest.mockResolvedValue({ kind: "proceed" });
      mockRecordIdempotentResponse.mockImplementation(
        async (_idem: unknown, response: Response): Promise<Response> =>
          response
      );
      mockFindExecution.mockResolvedValue({ id: `exec_${status}`, status });

      const response = await callExecute({ executionId: `exec_${status}` });
      expect(response.status).toBe(409);
      expect(mockChargePaygIfBillable).not.toHaveBeenCalled();
      expect(mockExecuteWorkflowInBackground).not.toHaveBeenCalled();
    }
  });

  it("acks running without PAYG or second start", async () => {
    mockFindExecution.mockResolvedValue({
      id: "exec_run",
      status: "running",
    });

    const response = await callExecute({ executionId: "exec_run" });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ executionId: "exec_run", status: "running" });
    expect(mockChargePaygIfBillable).not.toHaveBeenCalled();
    expect(mockExecuteWorkflowInBackground).not.toHaveBeenCalled();
    expect(mockRecordIdempotentResponse).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "success"
    );
  });

  it("starts pending reuse once (scheduler handoff)", async () => {
    mockFindExecution.mockResolvedValue({
      id: "exec_pend",
      status: "pending",
    });

    const response = await callExecute({ executionId: "exec_pend" });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ executionId: "exec_pend", status: "running" });
    expect(mockChargePaygIfBillable).toHaveBeenCalledWith({
      organizationId: "org_1",
      executionId: "exec_pend",
    });
    expect(mockExecuteWorkflowInBackground).toHaveBeenCalledWith(
      "exec_pend",
      "wf_1",
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      "org_1",
      "user_1",
      "org",
      "free"
    );
  });

  it("creates and starts when executionId is omitted", async () => {
    mockFindExecution.mockResolvedValue(undefined);

    const response = await callExecute({});
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.executionId).toBe("exec_new");
    expect(body.status).toBe("running");
    expect(mockFindExecution).not.toHaveBeenCalled();
    expect(mockChargePaygIfBillable).toHaveBeenCalled();
    expect(mockExecuteWorkflowInBackground).toHaveBeenCalled();
  });
});
