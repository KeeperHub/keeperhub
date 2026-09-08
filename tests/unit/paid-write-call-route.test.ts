/**
 * Paid write listings: the payment gate on the calldata branch.
 *
 * Separate file from x402-call-route.test.ts on purpose. That suite mocks
 * `@/lib/payments/router` wholesale, so it cannot exercise the real gate, and
 * it already burns most of the shared in-memory IP rate-limit bucket. Here the
 * rate limiter is mocked out and `gatePayment` is a thin stand-in that invokes
 * the handler factory the route passes it, so the ORDERING the route imposes
 * around the gate is what gets asserted.
 *
 * The invariant under test: nothing fallible may run after settlement. MPP
 * settles before the gated handler executes and there is no refund path
 * anywhere, so a body-validation or calldata-generation failure occurring
 * after the gate would be an unrefundable charge for a call that delivered
 * nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockDbSelect,
  mockRecordPayment,
  mockResolveCreatorWallet,
  mockGatePayment,
  mockDetectProtocol,
  mockGenerateCalldata,
  mockLogSystemError,
  mockCheckIpRateLimit,
} = vi.hoisted(() => ({
  mockDbSelect: vi.fn(),
  mockRecordPayment: vi.fn(),
  mockResolveCreatorWallet: vi.fn(),
  mockGatePayment: vi.fn(),
  mockDetectProtocol: vi.fn(),
  mockGenerateCalldata: vi.fn(),
  mockLogSystemError: vi.fn(),
  mockCheckIpRateLimit: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: mockDbSelect,
    insert: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
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

vi.mock("@/lib/payments/x402/payment-gate", () => ({
  recordPayment: mockRecordPayment,
  resolveCreatorWallet: mockResolveCreatorWallet,
}));

vi.mock("@/lib/payments/router", () => ({
  gatePayment: mockGatePayment,
  detectProtocol: mockDetectProtocol,
}));

vi.mock("@/lib/mcp/calldata", () => ({
  generateCalldataForWorkflow: mockGenerateCalldata,
}));

// Own module instance, so the shared in-memory bucket in the sibling suite
// cannot leak spurious 429s into these assertions.
vi.mock("@/lib/mcp/rate-limit", () => ({
  checkIpRateLimit: mockCheckIpRateLimit,
  getClientIp: () => "test-ip",
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { WORKFLOW_ENGINE: "workflow_engine", DATABASE: "database" },
  logSystemError: mockLogSystemError,
}));

vi.mock("@/lib/payments/x402/execution-wait", () => ({
  buildCallCompletionResponse: vi.fn(),
}));
vi.mock("workflow/api", () => ({ start: vi.fn() }));
vi.mock("@/lib/workflow/executor/executor.workflow", () => ({
  executeWorkflow: vi.fn(),
}));
vi.mock("@/lib/billing/execution-guard", () => ({
  enforceExecutionLimit: vi.fn(),
  EXECUTION_LIMIT_ERROR: "Monthly execution limit exceeded",
}));
vi.mock("@/lib/billing/payg/charge", () => ({ chargePaygIfBillable: vi.fn() }));
vi.mock("@/lib/features/route-guard", () => ({
  enforceWorkflowFeatures: vi.fn().mockResolvedValue({ blocked: false }),
  FEATURE_UPGRADE_REQUIRED_ERROR: "upgrade",
}));
vi.mock("@/app/api/execute/_lib/concurrency-limit", () => ({
  checkConcurrencyLimit: vi.fn(),
}));
vi.mock("@/lib/errors/classify", () => ({
  classifyExecutionError: () => ({
    errorCategory: "workflow_engine",
    errorType: "system",
  }),
}));
vi.mock("@/lib/errors/finalize-error", () => ({
  recordExecutionErrorFinalized: vi.fn().mockResolvedValue(undefined),
}));

const CREATOR_WALLET = "0xCreatorWallet";
const PAYMENT_HASH = "hash-abc";

const WRITE_NODES = [
  {
    id: "n1",
    data: { config: { actionType: "web3/write-contract" } },
  },
];

const PAID_WRITE_WORKFLOW = {
  id: "wf-write-1",
  name: "Priced Write Workflow",
  description: "Returns calldata",
  organizationId: "org-1",
  listedSlug: "priced-write",
  inputSchema: null,
  outputMapping: null,
  priceUsdcPerCall: "0.05",
  workflowType: "write",
  isListed: true,
  enabled: true,
  nodes: WRITE_NODES,
  edges: [],
  userId: "user-1",
};

const FREE_WRITE_WORKFLOW = {
  ...PAID_WRITE_WORKFLOW,
  listedSlug: "free-write",
  priceUsdcPerCall: null,
};

const CALLDATA = {
  success: true as const,
  to: "0x1111111111111111111111111111111111111111",
  data: "0xa9059cbb",
  value: "0",
};

function setupDbSelectWorkflow(row: unknown): void {
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

/**
 * Stand-in for the real gate: invokes the handler factory exactly the way
 * handleX402 / handleMpp do, so what is asserted is the route's ordering
 * around the gate rather than the payment middleware itself.
 */
function gateInvokesHandler(protocol: "x402" | "mpp"): void {
  mockGatePayment.mockImplementation(
    async (
      _req: unknown,
      _wf: unknown,
      _wallet: unknown,
      createHandler: (meta: unknown) => (r: unknown) => Promise<Response>
    ) => {
      const handler = createHandler({
        protocol,
        chain: protocol === "x402" ? "base" : "tempo",
        payerAddress: "0xPayer",
        paymentHash: PAYMENT_HASH,
      });
      return await handler({} as never);
    }
  );
}

async function post(slug: string, body: unknown, headers: HeadersInit = {}) {
  const { POST } = await import("@/app/api/mcp/workflows/[slug]/call/route");
  const request = new Request(
    `https://app.keeperhub.com/api/mcp/workflows/${slug}/call`,
    { method: "POST", body: JSON.stringify(body), headers }
  );
  return await POST(request, { params: Promise.resolve({ slug }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckIpRateLimit.mockReturnValue({
    allowed: true,
    limit: 30,
    remaining: 29,
    resetAt: Date.now() + 60_000,
  });
  mockResolveCreatorWallet.mockResolvedValue(CREATOR_WALLET);
  mockGenerateCalldata.mockReturnValue(CALLDATA);
  mockRecordPayment.mockResolvedValue(undefined);
});

describe("paid write listings", () => {
  it("charges and returns the calldata on the happy path", async () => {
    setupDbSelectWorkflow(PAID_WRITE_WORKFLOW);
    mockDetectProtocol.mockReturnValue("x402");
    gateInvokesHandler("x402");

    const response = await post(
      "priced-write",
      { amount: "1" },
      { "PAYMENT-SIGNATURE": "sig" }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      type: "calldata",
      to: CALLDATA.to,
      data: CALLDATA.data,
      value: CALLDATA.value,
    });
    expect(mockRecordPayment).toHaveBeenCalledTimes(1);
    // A calldata sale has no execution row, and the artifact sold is stored
    // so a replayed credential can be answered with the identical bytes.
    expect(mockRecordPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: PAID_WRITE_WORKFLOW.id,
        paymentHash: PAYMENT_HASH,
        executionId: null,
        kind: "calldata",
        deliverable: body,
        amountUsdc: "0.05",
        creatorWalletAddress: CREATOR_WALLET,
        protocol: "x402",
        chain: "base",
      })
    );
  });

  it("emits the 402 challenge before reading the body when no payment header is present", async () => {
    setupDbSelectWorkflow(PAID_WRITE_WORKFLOW);
    mockDetectProtocol.mockReturnValue(null);
    mockGatePayment.mockResolvedValue(
      new Response(null, { status: 402 }) as never
    );

    // Scanners probe with an empty body; they must see 402, never the 400
    // that calldata generation on an empty body would produce.
    const response = await post("priced-write", {});

    expect(response.status).toBe(402);
    expect(mockGenerateCalldata).not.toHaveBeenCalled();
    expect(mockRecordPayment).not.toHaveBeenCalled();
  });

  it("rejects an invalid body BEFORE the gate, so nothing is charged", async () => {
    setupDbSelectWorkflow({
      ...PAID_WRITE_WORKFLOW,
      inputSchema: {
        type: "object",
        required: ["amount"],
        properties: { amount: { type: "string" } },
      },
    });
    mockDetectProtocol.mockReturnValue("x402");
    gateInvokesHandler("x402");

    const response = await post(
      "priced-write",
      { wrong: "field" },
      { "PAYMENT-SIGNATURE": "sig" }
    );

    expect(response.status).toBe(400);
    expect(mockGatePayment).not.toHaveBeenCalled();
    expect(mockRecordPayment).not.toHaveBeenCalled();
  });

  it("rejects a calldata generation failure BEFORE the gate, so nothing is charged", async () => {
    setupDbSelectWorkflow(PAID_WRITE_WORKFLOW);
    mockDetectProtocol.mockReturnValue("x402");
    gateInvokesHandler("x402");
    mockGenerateCalldata.mockReturnValue({
      success: false,
      error: "Invalid or missing contract address in workflow node: undefined",
    });

    const response = await post(
      "priced-write",
      { amount: "1" },
      { "PAYMENT-SIGNATURE": "sig" }
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain("Invalid or missing contract address");
    expect(mockGatePayment).not.toHaveBeenCalled();
    expect(mockRecordPayment).not.toHaveBeenCalled();
  });

  it("fails CLOSED on x402 when the payment row cannot be written", async () => {
    setupDbSelectWorkflow(PAID_WRITE_WORKFLOW);
    mockDetectProtocol.mockReturnValue("x402");
    gateInvokesHandler("x402");
    mockRecordPayment.mockRejectedValue(new Error("db down"));

    const response = await post(
      "priced-write",
      { amount: "1" },
      { "PAYMENT-SIGNATURE": "sig" }
    );
    const body = await response.json();

    // x402 settles AFTER the handler and skips settlement for any >=400, so
    // a 503 here means no funds moved and the signature stays retryable.
    expect(response.status).toBe(503);
    expect(body.error).toContain("No funds were taken");
    expect(mockLogSystemError).toHaveBeenCalled();
  });

  it("fails OPEN on MPP when the payment row cannot be written", async () => {
    setupDbSelectWorkflow(PAID_WRITE_WORKFLOW);
    mockDetectProtocol.mockReturnValue("mpp");
    gateInvokesHandler("mpp");
    mockRecordPayment.mockRejectedValue(new Error("db down"));

    const response = await post(
      "priced-write",
      { amount: "1" },
      { authorization: "Payment cred" }
    );
    const body = await response.json();

    // MPP settled before the handler ran and there is no refund path, so
    // withholding the artifact here would take money and deliver nothing.
    expect(response.status).toBe(200);
    expect(body.type).toBe("calldata");
    expect(mockLogSystemError).toHaveBeenCalled();
  });

  it("returns 503 rather than charging when the creator has no wallet", async () => {
    setupDbSelectWorkflow(PAID_WRITE_WORKFLOW);
    mockDetectProtocol.mockReturnValue("x402");
    mockResolveCreatorWallet.mockResolvedValue(null);

    const response = await post(
      "priced-write",
      { amount: "1" },
      { "PAYMENT-SIGNATURE": "sig" }
    );

    expect(response.status).toBe(503);
    expect(mockGatePayment).not.toHaveBeenCalled();
    expect(mockRecordPayment).not.toHaveBeenCalled();
  });
});

describe("free write listings are unchanged", () => {
  it("returns calldata without touching the payment path", async () => {
    setupDbSelectWorkflow(FREE_WRITE_WORKFLOW);

    const response = await post("free-write", { amount: "1" });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      type: "calldata",
      to: CALLDATA.to,
      data: CALLDATA.data,
      value: CALLDATA.value,
    });
    // 11 of the 13 live listed write workflows are on this path; nothing
    // else pins it.
    expect(mockDetectProtocol).not.toHaveBeenCalled();
    expect(mockResolveCreatorWallet).not.toHaveBeenCalled();
    expect(mockGatePayment).not.toHaveBeenCalled();
    expect(mockRecordPayment).not.toHaveBeenCalled();
  });
});
