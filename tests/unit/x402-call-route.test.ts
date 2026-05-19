import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks -- must be defined before any vi.mock() calls
// ---------------------------------------------------------------------------

const {
  mockDbSelect,
  mockDbInsert,
  mockDbUpdate,
  mockDbUpdateSet,
  mockDbTransaction,
  mockHashPaymentSignature,
  mockHashMppCredential,
  mockRecordPayment,
  mockResolveCreatorWallet,
  mockGatePayment,
  mockDetectProtocol,
  mockStart,
  mockExecuteWorkflow,
  mockEnforceExecutionLimit,
  mockCheckConcurrencyLimit,
  mockLogSystemError,
  mockAuthenticateApiKey,
  mockAuthenticateOAuthToken,
  mockBuildCallCompletionResponse,
} = vi.hoisted(() => ({
  mockDbSelect: vi.fn(),
  mockDbInsert: vi.fn(),
  mockDbUpdate: vi.fn(),
  mockDbUpdateSet: vi.fn(),
  mockDbTransaction: vi.fn(),
  mockHashPaymentSignature: vi.fn(),
  mockHashMppCredential: vi.fn(),
  mockRecordPayment: vi.fn(),
  mockResolveCreatorWallet: vi.fn(),
  mockGatePayment: vi.fn(),
  mockDetectProtocol: vi.fn(),
  mockStart: vi.fn(),
  mockExecuteWorkflow: vi.fn(),
  mockEnforceExecutionLimit: vi.fn(),
  mockCheckConcurrencyLimit: vi.fn(),
  mockLogSystemError: vi.fn(),
  mockAuthenticateApiKey: vi.fn(),
  mockAuthenticateOAuthToken: vi.fn(),
  mockBuildCallCompletionResponse: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("@/lib/db", () => ({
  db: {
    select: mockDbSelect,
    insert: mockDbInsert,
    update: mockDbUpdate,
    transaction: mockDbTransaction,
  },
}));

vi.mock("@/lib/db/schema", () => ({
  workflows: {
    id: "id",
    listedSlug: "listed_slug",
    isListed: "is_listed",
    tagId: "tag_id",
  },
  workflowExecutions: { id: "id" },
  tags: { id: "id", name: "name" },
}));

vi.mock("@/lib/payments/x402/payment-gate", () => ({
  hashPaymentSignature: mockHashPaymentSignature,
  recordPayment: mockRecordPayment,
  resolveCreatorWallet: mockResolveCreatorWallet,
}));

vi.mock("@/lib/payments/mpp/server", () => ({
  hashMppCredential: mockHashMppCredential,
}));

vi.mock("@/lib/payments/router", () => ({
  gatePayment: mockGatePayment,
  detectProtocol: mockDetectProtocol,
}));

vi.mock("@/lib/api-key-auth", () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

vi.mock("@/lib/mcp/oauth-auth", () => ({
  authenticateOAuthToken: mockAuthenticateOAuthToken,
}));

vi.mock("workflow/api", () => ({
  start: mockStart,
}));

vi.mock("@/lib/workflow/executor/executor.workflow", () => ({
  executeWorkflow: mockExecuteWorkflow,
}));

vi.mock("@/lib/billing/execution-guard", () => ({
  enforceExecutionLimit: mockEnforceExecutionLimit,
  EXECUTION_LIMIT_ERROR: "Monthly execution limit exceeded",
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

// KEEP-545: route now classifies errors and increments a per-execution counter
// after writing status='error'. The classifier is pure (safe to import) but
// the finalize-error helper transitively imports server-only modules; mock
// both so the test doesn't try to load them.
vi.mock("@/lib/errors/classify", () => ({
  classifyExecutionError: (msg: unknown) => ({
    errorCategory: "workflow_engine",
    errorType: "system",
    _msg: msg,
  }),
}));
vi.mock("@/lib/errors/finalize-error", () => ({
  recordExecutionErrorFinalized: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LISTED_WORKFLOW = {
  id: "wf-1",
  name: "Test Workflow",
  description: "A test workflow",
  organizationId: "org-1",
  listedSlug: "test-workflow",
  inputSchema: null,
  outputMapping: null,
  priceUsdcPerCall: "1.50",
  isListed: true,
  nodes: [],
  edges: [],
  userId: "user-1",
};

const FREE_WORKFLOW = { ...LISTED_WORKFLOW, priceUsdcPerCall: "0" };

const FREE_WORKFLOW_NULL_PRICE = { ...LISTED_WORKFLOW, priceUsdcPerCall: null };

const CREATOR_WALLET = "0xCREATOR_WALLET";

function setupDbSelectWorkflow(row: unknown) {
  // lookupWorkflow joins the tags table to project tagName into the row, so
  // the chain is: select().from().leftJoin().where().limit(). Mirror that
  // shape here or the real code throws on the missing .leftJoin().
  mockDbSelect.mockReturnValue({
    from: vi.fn().mockReturnValue({
      leftJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(row ? [row] : []),
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

// gatePayment mock that calls through to the inner handler (simulates paid flow)
function makePassThroughGatePayment() {
  mockGatePayment.mockImplementation(
    (
      _request: Request,
      _workflow: unknown,
      _wallet: string,
      createHandler: (meta: {
        protocol: string;
        chain: string;
        payerAddress: string | null;
      }) => (req: Request) => Promise<Response>
    ) => {
      const handler = createHandler({
        protocol: "x402",
        chain: "base",
        payerAddress: null,
      });
      return handler(_request as never);
    }
  );
}

// gatePayment mock that returns 402 (simulates missing/invalid payment)
function make402GatePayment() {
  mockGatePayment.mockImplementation(() =>
    Promise.resolve(new Response(null, { status: 402 }))
  );
}

function makeRequest(
  slug: string,
  options: {
    body?: Record<string, unknown>;
    paymentSignature?: string;
    method?: string;
  } = {}
): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (options.paymentSignature) {
    headers["PAYMENT-SIGNATURE"] = options.paymentSignature;
  }
  return new Request(`http://localhost/api/mcp/workflows/${slug}/call`, {
    method: options.method ?? "POST",
    headers,
    body: JSON.stringify(options.body ?? {}),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/mcp/workflows/[slug]/call", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnforceExecutionLimit.mockResolvedValue({
      blocked: false,
      limitResult: null,
    });
    mockCheckConcurrencyLimit.mockResolvedValue({ allowed: true });
    mockStart.mockResolvedValue({ runId: "run-1" });
    mockRecordPayment.mockResolvedValue(undefined);
    mockHashPaymentSignature.mockReturnValue("hash-abc");
    mockResolveCreatorWallet.mockResolvedValue(CREATOR_WALLET);
    // Default: simulate timeout so we fall back to running response. Tests
    // exercising the synchronous completion path override this explicitly.
    mockBuildCallCompletionResponse.mockImplementation((executionId: string) =>
      Promise.resolve({ executionId, status: "running" })
    );
    // Default no-op update chain: db.update(table).set(values).where(filter).
    // mockDbUpdateSet captures the values argument so tests can assert on it
    // (used for the KEEP-449 billable=false flip and the status=error path).
    mockDbUpdateSet.mockReset();
    mockDbUpdateSet.mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
    mockDbUpdate.mockReturnValue({ set: mockDbUpdateSet });
    // db.transaction(cb) calls cb with a tx that exposes the same insert /
    // update mocks, so all of recordPayment + the billable flip route through
    // the same spies the tests already inspect.
    mockDbTransaction.mockImplementation(
      async (
        cb: (tx: {
          insert: typeof mockDbInsert;
          update: typeof mockDbUpdate;
        }) => Promise<unknown>
      ) =>
        cb({
          insert: mockDbInsert,
          update: mockDbUpdate,
        })
    );
    // Default: caller is authenticated. Tests that exercise the unauthenticated
    // path must explicitly override these to return { authenticated: false }.
    mockAuthenticateOAuthToken.mockResolvedValue({
      authenticated: true,
      organizationId: "caller-org-1",
      userId: "caller-user-1",
    });
    mockAuthenticateApiKey.mockResolvedValue({
      authenticated: true,
      organizationId: "caller-org-1",
      apiKeyId: "key-1",
    });
    // Mirror the real detectProtocol: inspect the request for payment headers
    // so individual tests don't need to stub this manually.
    mockDetectProtocol.mockImplementation((req: Request) => {
      const hasAuth = req.headers.get("authorization")?.startsWith("Payment ");
      const hasSig = Boolean(req.headers.get("PAYMENT-SIGNATURE"));
      if (hasAuth && hasSig) {
        return "error";
      }
      if (hasAuth) {
        return "mpp";
      }
      if (hasSig) {
        return "x402";
      }
      return null;
    });
  });

  function setUnauthenticated(): void {
    mockAuthenticateOAuthToken.mockResolvedValue({ authenticated: false });
    mockAuthenticateApiKey.mockResolvedValue({ authenticated: false });
  }

  it("Test 1: returns 404 for unknown slug", async () => {
    setupDbSelectWorkflow(null);
    const { POST } = await import("@/app/api/mcp/workflows/[slug]/call/route");
    const request = makeRequest("unknown-slug");
    const params = Promise.resolve({ slug: "unknown-slug" });
    const response = await POST(request, { params });
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.toLowerCase()).toContain("not found");
  });

  it("Test 2: returns 404 for unlisted workflow", async () => {
    setupDbSelectWorkflow(null); // query filters isListed=true, returns empty
    const { POST } = await import("@/app/api/mcp/workflows/[slug]/call/route");
    const request = makeRequest("unlisted-wf");
    const params = Promise.resolve({ slug: "unlisted-wf" });
    const response = await POST(request, { params });
    expect(response.status).toBe(404);
  });

  it("Test 3: free workflow (price=0) executes immediately without payment gate", async () => {
    setupDbSelectWorkflow(FREE_WORKFLOW);
    setupDbInsertExecution("exec-free-1");
    const { POST } = await import("@/app/api/mcp/workflows/[slug]/call/route");
    const request = makeRequest("test-workflow");
    const params = Promise.resolve({ slug: "test-workflow" });
    const response = await POST(request, { params });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.executionId).toBe("exec-free-1");
    expect(body.status).toBe("running");
    // gatePayment must NOT be called for free workflows
    expect(mockGatePayment).not.toHaveBeenCalled();
  });

  it("Test 4: free workflow (priceUsdcPerCall=null) executes without payment", async () => {
    setupDbSelectWorkflow(FREE_WORKFLOW_NULL_PRICE);
    setupDbInsertExecution("exec-free-null");
    const { POST } = await import("@/app/api/mcp/workflows/[slug]/call/route");
    const request = makeRequest("test-workflow");
    const params = Promise.resolve({ slug: "test-workflow" });
    const response = await POST(request, { params });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.executionId).toBe("exec-free-null");
    expect(mockGatePayment).not.toHaveBeenCalled();
  });

  it("Test 5: paid workflow without PAYMENT-SIGNATURE returns 402", async () => {
    setupDbSelectWorkflow(LISTED_WORKFLOW);
    make402GatePayment();
    const { POST } = await import("@/app/api/mcp/workflows/[slug]/call/route");
    const request = makeRequest("test-workflow");
    const params = Promise.resolve({ slug: "test-workflow" });
    const response = await POST(request, { params });
    expect(response.status).toBe(402);
    expect(mockGatePayment).toHaveBeenCalled();
  });

  it("Test 6: paid workflow with valid PAYMENT-SIGNATURE executes and returns executionId", async () => {
    setupDbSelectWorkflow(LISTED_WORKFLOW);
    setupDbInsertExecution("exec-paid-1");
    makePassThroughGatePayment();
    const { POST } = await import("@/app/api/mcp/workflows/[slug]/call/route");
    const request = makeRequest("test-workflow", {
      paymentSignature: "sig-abc",
    });
    const params = Promise.resolve({ slug: "test-workflow" });
    const response = await POST(request, { params });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.executionId).toBe("exec-paid-1");
    expect(body.status).toBe("running");
    expect(mockRecordPayment).toHaveBeenCalled();
    expect(mockStart).toHaveBeenCalled();
  });

  it("Test 7: duplicate PAYMENT-SIGNATURE returns original executionId without re-executing", async () => {
    setupDbSelectWorkflow(LISTED_WORKFLOW);
    mockGatePayment.mockImplementation(
      (
        _request: Request,
        _workflow: unknown,
        _wallet: string,
        createHandler: (meta: {
          protocol: string;
          chain: string;
          payerAddress: string | null;
        }) => (req: Request) => Promise<Response>
      ) => {
        const handler = createHandler({
          protocol: "x402",
          chain: "base",
          payerAddress: null,
        });
        return handler(_request as never);
      }
    );
    mockHashPaymentSignature.mockReturnValue("hash-abc");
    // Simulate idempotency: recordPayment returns existing payment info
    mockRecordPayment.mockResolvedValue({
      id: "pay-1",
      executionId: "exec-original",
      paymentHash: "hash-abc",
      workflowId: "wf-1",
      isExisting: true,
    });
    setupDbInsertExecution("exec-original");
    const { POST } = await import("@/app/api/mcp/workflows/[slug]/call/route");
    const request = makeRequest("test-workflow", {
      paymentSignature: "sig-dup",
    });
    const params = Promise.resolve({ slug: "test-workflow" });
    const response = await POST(request, { params });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.executionId).toBe("exec-original");
  });

  it("Test 8: returns 503 when org has no wallet configured", async () => {
    setupDbSelectWorkflow(LISTED_WORKFLOW);
    mockResolveCreatorWallet.mockResolvedValue(null);
    const { POST } = await import("@/app/api/mcp/workflows/[slug]/call/route");
    const request = makeRequest("test-workflow");
    const params = Promise.resolve({ slug: "test-workflow" });
    const response = await POST(request, { params });
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.toLowerCase()).toContain("wallet");
  });

  it("Test 9: returns 400 when body fails inputSchema validation", async () => {
    const workflowWithSchema = {
      ...LISTED_WORKFLOW,
      priceUsdcPerCall: "0", // free so we get to validation before payment
      inputSchema: {
        type: "object",
        required: ["tokenAddress", "amount"],
        properties: {
          tokenAddress: { type: "string" },
          amount: { type: "string" },
        },
      },
    };
    setupDbSelectWorkflow(workflowWithSchema);
    const { POST } = await import("@/app/api/mcp/workflows/[slug]/call/route");
    // Missing required fields
    const request = makeRequest("test-workflow", {
      body: { tokenAddress: "0xABC" },
    });
    const params = Promise.resolve({ slug: "test-workflow" });
    const response = await POST(request, { params });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBeDefined();
  });

  it("Test 10: payment is recorded BEFORE workflow execution starts", async () => {
    const callOrder: string[] = [];
    setupDbSelectWorkflow(LISTED_WORKFLOW);
    setupDbInsertExecution("exec-order-1");
    makePassThroughGatePayment();
    mockRecordPayment.mockImplementation(() => {
      callOrder.push("recordPayment");
      return Promise.resolve();
    });
    mockStart.mockImplementation(() => {
      callOrder.push("start");
      return Promise.resolve({ runId: "run-1" });
    });
    const { POST } = await import("@/app/api/mcp/workflows/[slug]/call/route");
    const request = makeRequest("test-workflow", {
      paymentSignature: "sig-order",
    });
    const params = Promise.resolve({ slug: "test-workflow" });
    await POST(request, { params });
    const recordIdx = callOrder.indexOf("recordPayment");
    const startIdx = callOrder.indexOf("start");
    expect(recordIdx).toBeGreaterThanOrEqual(0);
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(recordIdx).toBeLessThan(startIdx);
  });

  it("Test 11: OPTIONS returns CORS headers", async () => {
    const { OPTIONS } = await import(
      "@/app/api/mcp/workflows/[slug]/call/route"
    );
    const response = await OPTIONS();
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain(
      "POST"
    );
  });

  it("Test 12: body passing full inputSchema validation proceeds to execution", async () => {
    const workflowWithSchema = {
      ...LISTED_WORKFLOW,
      priceUsdcPerCall: "0",
      inputSchema: {
        type: "object",
        required: ["tokenAddress"],
        properties: {
          tokenAddress: { type: "string" },
        },
      },
    };
    setupDbSelectWorkflow(workflowWithSchema);
    setupDbInsertExecution("exec-schema-ok");
    const { POST } = await import("@/app/api/mcp/workflows/[slug]/call/route");
    const request = makeRequest("test-workflow", {
      body: { tokenAddress: "0xABC" },
    });
    const params = Promise.resolve({ slug: "test-workflow" });
    const response = await POST(request, { params });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.executionId).toBe("exec-schema-ok");
  });

  it("Test 13: free workflow without API key succeeds (publicly callable)", async () => {
    setUnauthenticated();
    setupDbSelectWorkflow(FREE_WORKFLOW);
    setupDbInsertExecution("exec-free-noauth");
    const { POST } = await import("@/app/api/mcp/workflows/[slug]/call/route");
    const request = makeRequest("test-workflow");
    const params = Promise.resolve({ slug: "test-workflow" });
    const response = await POST(request, { params });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.executionId).toBe("exec-free-noauth");
  });

  it("Test 14: paid workflow does NOT require API key (payment is the auth)", async () => {
    setUnauthenticated();
    setupDbSelectWorkflow(LISTED_WORKFLOW);
    setupDbInsertExecution("exec-paid-noauth");
    makePassThroughGatePayment();
    const { POST } = await import("@/app/api/mcp/workflows/[slug]/call/route");
    const request = makeRequest("test-workflow", {
      paymentSignature: "sig-noauth",
    });
    const params = Promise.resolve({ slug: "test-workflow" });
    const response = await POST(request, { params });
    expect(response.status).toBe(200);
    expect(mockAuthenticateApiKey).not.toHaveBeenCalled();
    expect(mockAuthenticateOAuthToken).not.toHaveBeenCalled();
  });

  it("Test 15: when recordPayment throws, marks the orphaned execution as failed and does not start the workflow", async () => {
    setupDbSelectWorkflow(LISTED_WORKFLOW);
    setupDbInsertExecution("exec-orphan-1");
    makePassThroughGatePayment();
    mockRecordPayment.mockRejectedValue(new Error("db connection lost"));

    const setMock = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
    mockDbUpdate.mockReturnValue({ set: setMock });

    const { POST } = await import("@/app/api/mcp/workflows/[slug]/call/route");
    const request = makeRequest("test-workflow", {
      paymentSignature: "sig-orphan",
    });
    const params = Promise.resolve({ slug: "test-workflow" });
    const response = await POST(request, { params });

    // The error propagates through the outer POST try/catch as a 500.
    expect(response.status).toBe(500);
    // The execution row was marked failed before the error escaped.
    expect(mockDbUpdate).toHaveBeenCalled();
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        error: expect.stringContaining("recordPayment failed"),
      })
    );
    // The workflow itself was never started.
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("Test 15b: free read workflow returns mapped output inline when execution completes within timeout (KEEP-265)", async () => {
    setupDbSelectWorkflow(FREE_WORKFLOW);
    setupDbInsertExecution("exec-sync-1");
    mockBuildCallCompletionResponse.mockResolvedValue({
      executionId: "exec-sync-1",
      status: "success",
      output: { balance: "1.3286 ETH" },
    });
    const { POST } = await import("@/app/api/mcp/workflows/[slug]/call/route");
    const request = makeRequest("test-workflow");
    const params = Promise.resolve({ slug: "test-workflow" });
    const response = await POST(request, { params });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.executionId).toBe("exec-sync-1");
    expect(body.status).toBe("success");
    expect(body.output).toEqual({ balance: "1.3286 ETH" });
    // Workflow still kicked off in the background prior to the wait.
    expect(mockStart).toHaveBeenCalled();
  });

  it("Test 15c: free read workflow falls back to running on timeout (KEEP-265)", async () => {
    setupDbSelectWorkflow(FREE_WORKFLOW);
    setupDbInsertExecution("exec-timeout-1");
    mockBuildCallCompletionResponse.mockResolvedValue({
      executionId: "exec-timeout-1",
      status: "running",
    });
    const { POST } = await import("@/app/api/mcp/workflows/[slug]/call/route");
    const request = makeRequest("test-workflow");
    const params = Promise.resolve({ slug: "test-workflow" });
    const response = await POST(request, { params });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.executionId).toBe("exec-timeout-1");
    expect(body.status).toBe("running");
    expect(body.output).toBeUndefined();
  });

  it("Test 15d: free read workflow returns error status when execution fails within timeout (KEEP-265)", async () => {
    setupDbSelectWorkflow(FREE_WORKFLOW);
    setupDbInsertExecution("exec-err-1");
    mockBuildCallCompletionResponse.mockResolvedValue({
      executionId: "exec-err-1",
      status: "error",
      error: "RPC provider returned 500",
    });
    const { POST } = await import("@/app/api/mcp/workflows/[slug]/call/route");
    const request = makeRequest("test-workflow");
    const params = Promise.resolve({ slug: "test-workflow" });
    const response = await POST(request, { params });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.executionId).toBe("exec-err-1");
    expect(body.status).toBe("error");
    expect(body.error).toContain("RPC provider");
  });

  it("Test 15e: paid read workflow returns mapped output inline on synchronous completion (KEEP-265)", async () => {
    setupDbSelectWorkflow(LISTED_WORKFLOW);
    setupDbInsertExecution("exec-paid-sync-1");
    makePassThroughGatePayment();
    mockBuildCallCompletionResponse.mockResolvedValue({
      executionId: "exec-paid-sync-1",
      status: "success",
      output: { riskScore: 2 },
    });
    const { POST } = await import("@/app/api/mcp/workflows/[slug]/call/route");
    const request = makeRequest("test-workflow", {
      paymentSignature: "sig-sync",
    });
    const params = Promise.resolve({ slug: "test-workflow" });
    const response = await POST(request, { params });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.executionId).toBe("exec-paid-sync-1");
    expect(body.status).toBe("success");
    expect(body.output).toEqual({ riskScore: 2 });
    // Payment must still be recorded before completion wait returned a result.
    expect(mockRecordPayment).toHaveBeenCalled();
  });

  it("Test 16: paid workflow probe with empty body returns 402 before body validation", async () => {
    const workflowWithRequiredField = {
      ...LISTED_WORKFLOW,
      inputSchema: {
        type: "object",
        required: ["address"],
        properties: { address: { type: "string" } },
      },
    };
    setupDbSelectWorkflow(workflowWithRequiredField);
    make402GatePayment();
    const { POST } = await import("@/app/api/mcp/workflows/[slug]/call/route");
    // Empty body: under the old flow this would return 400 (missing required
    // field). The 402-first ordering ensures scanners probing paid endpoints
    // without a valid body still see the payment challenge.
    const request = makeRequest("test-workflow", { body: {} });
    const params = Promise.resolve({ slug: "test-workflow" });
    const response = await POST(request, { params });
    expect(response.status).toBe(402);
    expect(mockGatePayment).toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // KEEP-449: marketplace-paid calls at or above the threshold ($0.05 USDC) are
  // exempt from the owner's monthly execution quota. The flip is performed by
  // an UPDATE on workflow_executions inside the same transaction as
  // recordPayment, so the workflow_payments row and billable bit can never
  // disagree.
  // ---------------------------------------------------------------------------

  it("Test 17 (KEEP-449): paid call at or above the threshold flips billable=false", async () => {
    setupDbSelectWorkflow(LISTED_WORKFLOW); // priceUsdcPerCall = "1.50"
    setupDbInsertExecution("exec-paid-above");
    makePassThroughGatePayment();
    const { POST } = await import("@/app/api/mcp/workflows/[slug]/call/route");
    const request = makeRequest("test-workflow", {
      paymentSignature: "sig-above",
    });
    const params = Promise.resolve({ slug: "test-workflow" });
    const response = await POST(request, { params });
    expect(response.status).toBe(200);
    expect(mockRecordPayment).toHaveBeenCalled();
    expect(mockDbTransaction).toHaveBeenCalledTimes(1);
    expect(mockDbUpdateSet).toHaveBeenCalledWith({ billable: false });
  });

  it("Test 18 (KEEP-449): paid call below the threshold leaves billable at default (true)", async () => {
    const cheapWorkflow = { ...LISTED_WORKFLOW, priceUsdcPerCall: "0.04" };
    setupDbSelectWorkflow(cheapWorkflow);
    setupDbInsertExecution("exec-paid-below");
    makePassThroughGatePayment();
    const { POST } = await import("@/app/api/mcp/workflows/[slug]/call/route");
    const request = makeRequest("test-workflow", {
      paymentSignature: "sig-below",
    });
    const params = Promise.resolve({ slug: "test-workflow" });
    const response = await POST(request, { params });
    expect(response.status).toBe(200);
    expect(mockRecordPayment).toHaveBeenCalled();
    expect(mockDbTransaction).toHaveBeenCalledTimes(1);
    expect(mockDbUpdateSet).not.toHaveBeenCalledWith({ billable: false });
  });

  it("Test 19 (KEEP-449): paid call exactly at the threshold flips billable=false", async () => {
    const thresholdWorkflow = {
      ...LISTED_WORKFLOW,
      priceUsdcPerCall: "0.05",
    };
    setupDbSelectWorkflow(thresholdWorkflow);
    setupDbInsertExecution("exec-paid-threshold");
    makePassThroughGatePayment();
    const { POST } = await import("@/app/api/mcp/workflows/[slug]/call/route");
    const request = makeRequest("test-workflow", {
      paymentSignature: "sig-threshold",
    });
    const params = Promise.resolve({ slug: "test-workflow" });
    const response = await POST(request, { params });
    expect(response.status).toBe(200);
    expect(mockDbUpdateSet).toHaveBeenCalledWith({ billable: false });
  });

  it("Test 20 (KEEP-449): free workflow path never flips billable", async () => {
    setupDbSelectWorkflow(FREE_WORKFLOW); // price = "0"
    setupDbInsertExecution("exec-free-keep449");
    const { POST } = await import("@/app/api/mcp/workflows/[slug]/call/route");
    const request = makeRequest("test-workflow");
    const params = Promise.resolve({ slug: "test-workflow" });
    const response = await POST(request, { params });
    expect(response.status).toBe(200);
    // Free path bypasses gatePayment entirely, so neither recordPayment nor
    // the transaction wrapper run.
    expect(mockGatePayment).not.toHaveBeenCalled();
    expect(mockDbTransaction).not.toHaveBeenCalled();
    expect(mockDbUpdateSet).not.toHaveBeenCalledWith({ billable: false });
  });
});
