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
const mockIdempotencyEarlyResponse = vi.fn();
const mockRecordIdempotentResponse = vi.fn(
  (_idem: unknown, response: Response) => response
);
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
  idempotencyEarlyResponse: mockIdempotencyEarlyResponse,
  recordIdempotentResponse: mockRecordIdempotentResponse,
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
// The whole point of two of the tests below is that the execution lookup is
// scoped by workflowId. A findFirst mock that ignores its `where` cannot show
// that -- it answers the same whichever predicate the route built. So `and` /
// `eq` are replaced with a tiny term representation, and findFirst evaluates
// the term against an in-memory table. Everything else in drizzle-orm passes
// through untouched.
type Term =
  | { op: "eq"; column: string; value: unknown }
  | { op: "and"; parts: Term[] };

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    and: (...parts: Term[]): Term => ({ op: "and", parts }),
    eq: (column: string, value: unknown): Term => ({ op: "eq", column, value }),
  };
});

type ExecutionRow = { id: string; workflow_id: string; status: string };

const executionRows: ExecutionRow[] = [];

function matches(row: ExecutionRow, term: Term): boolean {
  if (term.op === "and") {
    return term.parts.every((part) => matches(row, part));
  }
  return (
    (row as unknown as Record<string, unknown>)[term.column] === term.value
  );
}

const mockExecutionsFindFirst = vi.fn(({ where }: { where: Term }) =>
  Promise.resolve(executionRows.find((row) => matches(row, where)))
);

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      workflows: { findFirst: vi.fn() },
      workflowExecutions: { findFirst: mockExecutionsFindFirst },
    },
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
  workflowExecutions: { id: "id", workflowId: "workflow_id" },
}));
vi.mock("@/lib/logging", () => ({
  ErrorCategory: {
    WORKFLOW_ENGINE: "workflow_engine",
    VALIDATION: "validation",
  },
  logSystemError: vi.fn(),
  logUserError: vi.fn(),
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
    mockIdempotencyEarlyResponse.mockReturnValue(null);
    mockRecordIdempotentResponse.mockImplementation(
      (_idem: unknown, response: Response) => response
    );
    executionRows.length = 0;
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

  // The notice has to survive the paths a caller actually hits on a retry or a
  // billing failure, not just the happy path -- a caller who only ever sees
  // replays would otherwise never learn the shape is going away.
  //
  // Two of the five wrapped return sites are unreachable with a deprecated
  // body and so are not covered here: the terminal-409 and running-200
  // branches are behind an *envelope* executionId, and a body carrying an
  // envelope is by definition not the bare shape. Wrapping them anyway keeps
  // "every post-resolution response carries the notice" true by construction
  // rather than by case analysis, which is why they stay wrapped.
  describe("deprecation headers on non-success responses", () => {
    it("carries the notice on an idempotent replay", async () => {
      mockBeginIdempotentFromRequest.mockResolvedValue({ key: "idem_1" });
      mockIdempotencyEarlyResponse.mockReturnValue({
        body: { executionId: "exec_1", status: "running" },
        status: 200,
      });

      const response = await callExecute(JSON.stringify({ amount: "1" }));

      expect(response.status).toBe(200);
      expect(response.headers.get("Deprecation")).toMatch(/^@\d+$/);
      expect(response.headers.get("Sunset")).toBeTruthy();
      expect(response.headers.get("Link")).toContain('rel="deprecation"');
      expect(mockExecuteWorkflowInBackground).not.toHaveBeenCalled();
    });

    it("carries the notice on a 402 from a failed PAYG charge", async () => {
      mockChargePaygIfBillable.mockResolvedValue({
        applicable: true,
        ok: false,
        message: "Payment required",
      });

      const response = await callExecute(JSON.stringify({ amount: "1" }));

      expect(response.status).toBe(402);
      expect(response.headers.get("Deprecation")).toMatch(/^@\d+$/);
      expect(response.headers.get("Sunset")).toBeTruthy();
      expect(response.headers.get("Link")).toContain('rel="deprecation"');
    });

    it("sends no notice on the nested shape's 402", async () => {
      mockChargePaygIfBillable.mockResolvedValue({
        applicable: true,
        ok: false,
        message: "Payment required",
      });

      const response = await callExecute(
        JSON.stringify({ input: { amount: "1" } })
      );

      expect(response.status).toBe(402);
      expect(response.headers.get("Deprecation")).toBeNull();
    });
  });

  // A caller-supplied executionId addresses a row. Scoping the lookup to the
  // workflow in the path is what stops it addressing someone else's -- and
  // these go through a findFirst that actually evaluates the predicate, so an
  // unscoped `where` fails them rather than passing on a stubbed answer.
  describe("caller-supplied executionId", () => {
    const uniqueViolation = (): Error =>
      Object.assign(new Error("insert failed"), {
        cause: Object.assign(new Error("duplicate key value"), {
          code: "23505",
        }),
      });

    it("adopts a pre-created row belonging to this workflow", async () => {
      executionRows.push({
        id: "exec_pre",
        workflow_id: "wf_1",
        status: "running",
      });

      const response = await callExecute(
        JSON.stringify({ executionId: "exec_pre", input: { amount: "1" } })
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        executionId: "exec_pre",
        status: "running",
      });
      expect(mockDbInsertValues).not.toHaveBeenCalled();
    });

    it("answers 409 for an executionId that belongs to another workflow, without disclosing its state", async () => {
      executionRows.push({
        id: "exec_other",
        workflow_id: "wf_2",
        status: "success",
      });
      mockDbInsertValues.mockImplementationOnce(() =>
        Promise.reject(uniqueViolation())
      );

      const response = await callExecute(
        JSON.stringify({ executionId: "exec_other", input: { amount: "1" } })
      );

      expect(response.status).toBe(409);
      const data = await response.json();
      expect(data.code).toBe("execution_id_conflict");
      expect(data.executionId).toBe("exec_other");
      // Not "execution_already_terminal", and no status field: the row is on
      // another workflow, so its state is not this caller's to read.
      expect(data.status).toBeUndefined();
      expect(JSON.stringify(data)).not.toContain("duplicate key");
      expect(mockExecuteWorkflowInBackground).not.toHaveBeenCalled();
    });

    it("creates the row when the supplied executionId is free", async () => {
      const response = await callExecute(
        JSON.stringify({ executionId: "exec_free", input: { amount: "1" } })
      );

      expect(response.status).toBe(200);
      expect(mockDbInsertValues).toHaveBeenCalledWith(
        expect.objectContaining({ id: "exec_free", workflowId: "wf_1" })
      );
      expect(mockExecuteWorkflowInBackground).toHaveBeenCalledWith(
        "exec_free",
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

    it("does not treat a bare top-level executionId as an envelope field", async () => {
      executionRows.push({
        id: "exec_other",
        workflow_id: "wf_2",
        status: "success",
      });

      const response = await callExecute(
        JSON.stringify({ executionId: "exec_other", amount: "1" })
      );

      expect(response.status).toBe(200);
      // Never looked up: in the bare shape that key is the caller's data.
      expect(mockExecutionsFindFirst).not.toHaveBeenCalled();
      expect(mockExecuteWorkflowInBackground).toHaveBeenCalledWith(
        "exec_1",
        "wf_1",
        workflow.nodes,
        workflow.edges,
        { executionId: "exec_other", amount: "1" },
        expect.anything(),
        workflow.organizationId,
        workflow.userId,
        undefined,
        undefined
      );
    });
  });
});
