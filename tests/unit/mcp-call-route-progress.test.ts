import { describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks -- must be defined before any vi.mock() calls
// ---------------------------------------------------------------------------

const {
  mockDbSelect,
  mockDbInsert,
  mockDbUpdate,
  mockDbUpdateSet,
  mockResolveExecutionOrgMetadata,
  mockStart,
  mockEnforceExecutionLimit,
  mockCheckConcurrencyLimit,
  mockChargePaygIfBillable,
  mockLogSystemError,
  mockBuildCallCompletionResponse,
  mockDetectProtocol,
  mockGatePayment,
} = vi.hoisted(() => ({
  mockDbSelect: vi.fn(),
  mockDbInsert: vi.fn(),
  mockDbUpdate: vi.fn(),
  mockDbUpdateSet: vi.fn(),
  mockResolveExecutionOrgMetadata: vi.fn(),
  mockStart: vi.fn(),
  mockEnforceExecutionLimit: vi.fn(),
  mockCheckConcurrencyLimit: vi.fn(),
  mockChargePaygIfBillable: vi.fn(),
  mockLogSystemError: vi.fn(),
  mockBuildCallCompletionResponse: vi.fn(),
  mockDetectProtocol: vi.fn(),
  mockGatePayment: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks -- mirrors tests/unit/x402-call-route.test.ts, the existing
// mock set for this route, trimmed to what the free/read happy path touches.
// ---------------------------------------------------------------------------

vi.mock("@/lib/db", () => ({
  db: {
    select: mockDbSelect,
    insert: mockDbInsert,
    update: mockDbUpdate,
  },
}));

vi.mock("@/lib/db/schema", () => ({
  workflows: {
    id: "id",
    listedSlug: "listed_slug",
    isListed: "is_listed",
    tagId: "tag_id",
    enabled: "enabled",
    deletedAt: "deleted_at",
    deactivatedAt: "deactivated_at",
    organizationId: "organization_id",
    userId: "user_id",
  },
  workflowExecutions: { id: "id" },
  tags: { id: "id", name: "name" },
  organization: { id: "id", deactivatedAt: "deactivated_at" },
}));

vi.mock("@/lib/db/org-helpers", () => ({
  resolveExecutionOrgMetadata: mockResolveExecutionOrgMetadata,
}));

vi.mock("workflow/api", () => ({
  start: mockStart,
}));

vi.mock("@/lib/workflow/executor/executor.workflow", () => ({
  executeWorkflow: vi.fn(),
}));

vi.mock("@/lib/billing/execution-guard", () => ({
  enforceExecutionLimit: mockEnforceExecutionLimit,
}));

vi.mock("@/lib/billing/payg/charge", () => ({
  chargePaygIfBillable: mockChargePaygIfBillable,
}));

vi.mock("@/lib/features/route-guard", () => ({
  enforceWorkflowFeatures: vi.fn().mockResolvedValue({ blocked: false }),
}));

vi.mock("@/app/api/execute/_lib/concurrency-limit", () => ({
  checkConcurrencyLimit: mockCheckConcurrencyLimit,
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { WORKFLOW_ENGINE: "workflow_engine" },
  logSystemError: mockLogSystemError,
}));

vi.mock("@/lib/payments/x402/execution-wait", () => ({
  buildCallCompletionResponse: mockBuildCallCompletionResponse,
}));

// Not exercised by the free-workflow happy path this file tests, but
// @/lib/payments/router transitively resolves @x402/next -> next/server,
// which fails to resolve outside a real Next.js build; mock it out like
// tests/unit/x402-call-route.test.ts already does for this route.
vi.mock("@/lib/payments/router", () => ({
  gatePayment: mockGatePayment,
  detectProtocol: mockDetectProtocol,
}));

vi.mock("@/lib/errors/classify", () => ({
  classifyExecutionError: vi.fn().mockReturnValue({
    errorCategory: "workflow_engine",
    errorType: "system",
  }),
}));
vi.mock("@/lib/errors/finalize-error", () => ({
  recordExecutionErrorFinalized: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FREE_WORKFLOW = {
  id: "wf-1",
  name: "Test Workflow",
  description: "A test workflow",
  organizationId: "org-1",
  listedSlug: "test-workflow",
  inputSchema: null,
  outputMapping: null,
  priceUsdcPerCall: "0",
  isListed: true,
  enabled: true,
  nodes: [
    {
      id: "trigger-1",
      type: "trigger",
      position: { x: 0, y: 0 },
      data: { type: "trigger", enabled: true },
    },
    {
      id: "action-1",
      type: "action",
      position: { x: 0, y: 0 },
      data: { type: "action", enabled: true },
    },
  ],
  edges: [{ id: "e1", source: "trigger-1", target: "action-1" }],
  userId: "user-1",
};

function setupDbSelectWorkflow(row: unknown) {
  mockDbSelect.mockReturnValue({
    from: vi.fn().mockReturnValue({
      leftJoin: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(row ? [row] : []),
          }),
        }),
      }),
    }),
  });
}

function setupDbInsertExecution(executionId: string) {
  mockDbInsert.mockReturnValue({
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: executionId }]),
    }),
  });
}

function makeRequest(slug: string): Request {
  return new Request(`http://localhost/api/mcp/workflows/${slug}/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("startExecutionInBackground (MCP call route) - progress initialization", () => {
  it("initializes totalSteps from the workflow graph before start() is called", async () => {
    vi.clearAllMocks();
    setupDbSelectWorkflow(FREE_WORKFLOW);
    setupDbInsertExecution("exec-progress-1");
    mockEnforceExecutionLimit.mockResolvedValue({ blocked: false });
    mockCheckConcurrencyLimit.mockResolvedValue({ allowed: true });
    mockChargePaygIfBillable.mockResolvedValue({ applicable: false });
    mockResolveExecutionOrgMetadata.mockResolvedValue({
      slug: "org-slug",
      plan: "free",
    });
    mockBuildCallCompletionResponse.mockResolvedValue({
      executionId: "exec-progress-1",
      status: "running",
    });

    const callOrder: string[] = [];
    mockDbUpdateSet.mockImplementation((values: Record<string, unknown>) => {
      if (values && typeof values === "object" && "totalSteps" in values) {
        callOrder.push("initializeProgress");
      }
      return { where: vi.fn().mockResolvedValue(undefined) };
    });
    mockDbUpdate.mockReturnValue({ set: mockDbUpdateSet });
    mockStart.mockImplementation(() => {
      callOrder.push("start");
      return Promise.resolve({ runId: "run-1" });
    });

    const { POST } = await import("@/app/api/mcp/workflows/[slug]/call/route");
    const response = await POST(makeRequest("test-workflow"), {
      params: Promise.resolve({ slug: "test-workflow" }),
    });

    expect(response.status).toBe(200);
    // Two nodes reachable from the trigger -> totalSteps === "2".
    expect(mockDbUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ totalSteps: "2", completedSteps: "0" })
    );
    expect(mockStart).toHaveBeenCalled();

    const progressIdx = callOrder.indexOf("initializeProgress");
    const startIdx = callOrder.indexOf("start");
    expect(progressIdx).toBeGreaterThanOrEqual(0);
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(progressIdx).toBeLessThan(startIdx);
  });
});
