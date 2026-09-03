/**
 * Proves the route actually threads resolveExecutionInput's
 * output through to executeWorkflowInBackground, and that the 400 conflict
 * response happens before any billing/db side effects. The pure resolution
 * logic itself is unit-tested in tests/unit/resolve-execution-input.test.ts;
 * this file only proves the wiring.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("workflow/api", () => ({ start: vi.fn() }));

const mockAuthenticateInternalService = vi.fn();
const mockGetDualAuthContext = vi.fn();
const mockGetWorkflowAccess = vi.fn();
const mockValidateWorkflowIntegrations = vi.fn();
const mockEnforceWorkflowFeatures = vi.fn();
const mockEnforceExecutionLimit = vi.fn();
const mockCheckConcurrencyLimit = vi.fn();
const mockChargePaygIfBillable = vi.fn();
const mockExecuteWorkflowInBackground = vi.fn();
const mockBeginIdempotentFromRequest = vi.fn();
const mockDbInsertValues = vi.fn();

vi.mock("@/lib/internal-service-auth", () => ({
  authenticateInternalService: mockAuthenticateInternalService,
}));
vi.mock("@/lib/middleware/auth-helpers", () => ({
  getDualAuthContext: mockGetDualAuthContext,
}));
vi.mock("@/lib/workflow/access", () => ({
  getWorkflowAccess: mockGetWorkflowAccess,
}));
vi.mock("@/lib/db/integrations", () => ({
  validateWorkflowIntegrations: mockValidateWorkflowIntegrations,
}));
vi.mock("@/lib/features/route-guard", () => ({
  enforceWorkflowFeatures: mockEnforceWorkflowFeatures,
}));
vi.mock("@/lib/billing/execution-guard", () => ({
  enforceExecutionLimit: mockEnforceExecutionLimit,
}));
vi.mock("@/app/api/execute/_lib/concurrency-limit", () => ({
  checkConcurrencyLimit: mockCheckConcurrencyLimit,
}));
vi.mock("@/lib/billing/payg/charge", () => ({
  chargePaygIfBillable: mockChargePaygIfBillable,
}));
vi.mock("@/lib/workflow/execute-in-background", () => ({
  executeWorkflowInBackground: mockExecuteWorkflowInBackground,
}));
vi.mock("@/lib/db/org-helpers", () => ({
  resolveExecutionOrgMetadata: vi.fn().mockResolvedValue({}),
}));
vi.mock("@/lib/idempotency", () => ({
  beginIdempotentFromRequest: mockBeginIdempotentFromRequest,
  idempotencyEarlyResponse: vi.fn().mockReturnValue(null),
  recordIdempotentResponse: vi.fn((_idem, response) => response),
}));
vi.mock("@/lib/security/backstop-capture", () => ({
  withBackstopCapture: vi.fn((_ctx, fn: () => unknown) => fn()),
}));
vi.mock("@/lib/security/request-attribution", () => ({
  buildAttribution: vi.fn().mockReturnValue({}),
  resolveTriggerLabels: vi
    .fn()
    .mockReturnValue({ triggerType: "manual", triggerSource: "api" }),
}));
vi.mock("@/lib/workflow/content-hash", () => ({
  hashWorkflowDefinition: vi.fn().mockReturnValue("hash_1"),
}));
vi.mock("@/lib/metrics", () => ({
  getMetricsCollector: vi.fn().mockReturnValue({ incrementCounter: vi.fn() }),
}));
vi.mock("@/lib/metrics/types", () => ({
  MetricNames: { WORKFLOW_EXECUTIONS_STARTED_TOTAL: "workflow_executions" },
  LabelKeys: { TRIGGER_TYPE: "trigger_type" },
}));
const mockOwnerLimit = vi.fn().mockResolvedValue([{ orgDeactivatedAt: null }]);
vi.mock("@/lib/db", () => ({
  db: {
    query: { workflows: { findFirst: vi.fn() } },
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        leftJoin: vi.fn(() => ({
          where: vi.fn(() => ({ limit: mockOwnerLimit })),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: mockDbInsertValues,
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn() })),
    })),
  },
}));
vi.mock("@/lib/db/schema", () => ({
  users: { id: "id", deactivatedAt: "deactivated_at" },
  workflows: { id: "id", userId: "user_id", organizationId: "organization_id" },
  organization: { id: "id", deactivatedAt: "deactivated_at" },
  workflowExecutions: { id: "id" },
}));
vi.mock("@/lib/logging", () => ({
  ErrorCategory: { WORKFLOW_ENGINE: "workflow_engine" },
  logSystemError: vi.fn(),
}));

const workflow = {
  id: "wf_1",
  userId: "owner_a",
  organizationId: "org_1",
  enabled: true,
  nodes: [],
  edges: [],
  deletedAt: null,
  isAnonymous: false,
};

async function callExecute(body: string): Promise<Response> {
  const { POST } = await import(
    "@/app/api/workflow/[workflowId]/execute/route"
  );
  const request = new Request("http://localhost/api/workflow/wf_1/execute", {
    method: "POST",
    body,
  });
  return POST(request, { params: Promise.resolve({ workflowId: "wf_1" }) });
}

describe("execute route - input binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthenticateInternalService.mockResolvedValue({
      authenticated: false,
      error: "Unauthorized",
      status: 401,
    });
    mockOwnerLimit.mockResolvedValue([
      { workflow, orgDeactivatedAt: null, organizationName: null },
    ]);
    mockGetWorkflowAccess.mockResolvedValue({
      isCreatorWithCurrentAccess: false,
      isSameOrg: true,
      hasFullAccess: true,
      isDeleted: false,
    });
    mockGetDualAuthContext.mockResolvedValue({
      userId: "owner_a",
      organizationId: "org_1",
      authMethod: "session",
      apiKeyId: null,
    });
    mockValidateWorkflowIntegrations.mockResolvedValue({ valid: true });
    mockEnforceWorkflowFeatures.mockResolvedValue({ blocked: false });
    mockEnforceExecutionLimit.mockResolvedValue({
      blocked: false,
      limitResult: null,
    });
    mockCheckConcurrencyLimit.mockResolvedValue({
      allowed: true,
      running: 0,
      limit: 100,
    });
    mockChargePaygIfBillable.mockResolvedValue({ applicable: false });
    mockBeginIdempotentFromRequest.mockResolvedValue(null);
    mockDbInsertValues.mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: "exec_1" }]),
    });
  });

  it("binds a bare top-level field as input, with a deprecation warning header", async () => {
    const response = await callExecute(JSON.stringify({ amount: "1" }));

    expect(response.status).toBe(200);
    expect(response.headers.get("Deprecation")).toBeTruthy();
    expect(mockExecuteWorkflowInBackground).toHaveBeenCalledWith(
      "exec_1",
      "wf_1",
      workflow.nodes,
      workflow.edges,
      { amount: "1" },
      expect.anything(),
      workflow.organizationId,
      workflow.userId,
      undefined,
      undefined
    );
  });

  it("still binds the legacy nested input shape unchanged, with no deprecation warning", async () => {
    const response = await callExecute(
      JSON.stringify({ input: { amount: "1" } })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Deprecation")).toBeNull();
    expect(mockExecuteWorkflowInBackground).toHaveBeenCalledWith(
      "exec_1",
      "wf_1",
      workflow.nodes,
      workflow.edges,
      { amount: "1" },
      expect.anything(),
      workflow.organizationId,
      workflow.userId,
      undefined,
      undefined
    );
  });

  it("rejects a body mixing a nested input with stray top-level fields, and never starts an execution", async () => {
    const response = await callExecute(
      JSON.stringify({ input: { amount: "1" }, amount: "2" })
    );

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.field).toBe("input");
    expect(mockDbInsertValues).not.toHaveBeenCalled();
    expect(mockExecuteWorkflowInBackground).not.toHaveBeenCalled();
  });

  it("treats a null input as absent and starts an execution with empty input", async () => {
    const response = await callExecute(JSON.stringify({ input: null }));

    expect(response.status).toBe(200);
    expect(response.headers.get("Deprecation")).toBeNull();
    expect(mockExecuteWorkflowInBackground).toHaveBeenCalledWith(
      "exec_1",
      "wf_1",
      workflow.nodes,
      workflow.edges,
      {},
      expect.anything(),
      workflow.organizationId,
      workflow.userId,
      undefined,
      undefined
    );
  });

  it("rejects a non-object input value and never starts an execution", async () => {
    const response = await callExecute(JSON.stringify({ input: "oops" }));

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.field).toBe("input");
    expect(mockExecuteWorkflowInBackground).not.toHaveBeenCalled();
  });
});
