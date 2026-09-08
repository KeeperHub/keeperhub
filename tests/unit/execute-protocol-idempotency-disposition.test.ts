import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/protocols", () => ({}));

vi.mock("../../app/api/execute/_lib/auth", () => ({
  validateApiKey: vi
    .fn()
    .mockResolvedValue({ organizationId: "org_1", apiKeyId: "key_1" }),
}));

vi.mock("../../app/api/execute/_lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockReturnValue({ allowed: true }),
}));

vi.mock("@/lib/db/org-helpers", () => ({
  enterApiExecuteErrorContext: vi.fn(),
}));

vi.mock("@/lib/abi/cache", () => ({
  resolveAbi: vi.fn().mockResolvedValue({ abi: "[]", source: "definition" }),
}));

vi.mock("@/plugins/protocol/steps/resolve-protocol-meta", () => ({
  resolveProtocolMeta: vi.fn().mockReturnValue({
    protocolSlug: "test-protocol",
    contractKey: "router",
    functionName: "swap",
    actionType: "write",
  }),
}));

vi.mock("@/lib/protocol-registry", () => ({
  getProtocol: vi.fn().mockReturnValue({
    contracts: { router: { addresses: { "8453": "0xBaseRouter" } } },
    actions: [],
  }),
  resolveContractAddress: (
    contract: {
      userSpecifiedAddress?: boolean;
      addresses: Record<string, string>;
    },
    network: string,
    providedAddress: string | undefined
  ) =>
    contract.userSpecifiedAddress
      ? providedAddress
      : contract.addresses[network],
}));

const writeContractCoreMock = vi.fn();
vi.mock("@/plugins/web3/steps/write-contract-core", () => ({
  writeContractCore: (input: unknown) => writeContractCoreMock(input),
}));

vi.mock("@/plugins/web3/steps/read-contract-core", () => ({
  readContractCore: vi.fn(),
}));

vi.mock("@/lib/step-registry", () => ({
  PLUGIN_STEP_IMPORTERS: { "test-protocol/swap": () => Promise.resolve({}) },
}));

const enforceExecutionLimitMock = vi.fn();
vi.mock("@/lib/billing/execution-guard", () => ({
  enforceExecutionLimit: (orgId: string) => enforceExecutionLimitMock(orgId),
}));

const requireWalletMock = vi.fn();
vi.mock("../../app/api/execute/_lib/wallet-check", () => ({
  requireWallet: (orgId: string) => requireWalletMock(orgId),
}));

const checkAndReserveExecutionMock = vi.fn();
vi.mock("../../app/api/execute/_lib/spending-cap", () => ({
  checkAndReserveExecution: (params: unknown) =>
    checkAndReserveExecutionMock(params),
}));

vi.mock("../../app/api/execute/_lib/concurrency-limit", () => ({
  enforceDirectExecutionConcurrency: vi.fn().mockResolvedValue(null),
}));

const failExecutionMock = vi.fn().mockResolvedValue({ status: "failed" });
vi.mock("../../app/api/execute/_lib/execution-service", () => ({
  markRunning: vi.fn(),
  completeExecution: vi.fn().mockResolvedValue({ status: "completed" }),
  failExecution: (...args: unknown[]) => failExecutionMock(...args),
  redactInput: (x: unknown) => x,
  withRejectedSignerOverride: (a: unknown) => a,
}));

// Capture the disposition each response is recorded with. A non-null outcome
// stands in for a request that carried an Idempotency-Key.
const recordIdempotentResponseMock = vi.fn(
  (_outcome: unknown, response: Response, _disposition?: string) =>
    Promise.resolve(response)
);
vi.mock("@/lib/idempotency", () => ({
  beginIdempotentFromRequest: vi.fn().mockResolvedValue({ kind: "proceed" }),
  idempotencyEarlyResponse: vi.fn().mockReturnValue(null),
  recordIdempotentResponse: (
    outcome: unknown,
    response: Response,
    disposition?: string
  ) => recordIdempotentResponseMock(outcome, response, disposition),
  withIdempotencyHeartbeat: (_outcome: unknown, fn: () => unknown) => fn(),
}));

async function postSwap(): Promise<Response> {
  const { POST } = await import("@/app/api/execute/[...slug]/route");
  const req = new Request("http://test/api/execute/test-protocol/swap", {
    method: "POST",
    body: JSON.stringify({ chainId: 8453 }),
    headers: {
      "content-type": "application/json",
      authorization: "Bearer x",
      "idempotency-key": "idem_1",
    },
  });
  return POST(req, {
    params: Promise.resolve({ slug: ["test-protocol", "swap"] }),
  });
}

function lastDisposition(): string | undefined {
  const calls = recordIdempotentResponseMock.mock.calls;
  return calls.at(-1)?.[2] as string | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  enforceExecutionLimitMock.mockResolvedValue({ blocked: false });
  requireWalletMock.mockResolvedValue(null);
  checkAndReserveExecutionMock.mockResolvedValue({
    allowed: true,
    executionId: "exec_1",
  });
  failExecutionMock.mockResolvedValue({ status: "failed" });
  writeContractCoreMock.mockResolvedValue({
    success: true,
    transactionHash: "0xtx",
    transactionLink: "https://scan/0xtx",
    gasUsed: "21000",
    effectiveGasPrice: "1000000000",
  });
});

describe("execute protocol idempotency disposition", () => {
  it("releases the lock when the plan limit blocks (pre-broadcast)", async () => {
    enforceExecutionLimitMock.mockResolvedValue({
      blocked: true,
      response: NextResponse.json({ error: "limit" }, { status: 402 }),
    });

    await postSwap();

    expect(lastDisposition()).toBe("release");
  });

  it("releases the lock when no wallet is configured (pre-broadcast)", async () => {
    requireWalletMock.mockResolvedValue(
      NextResponse.json({ error: "No wallet" }, { status: 422 })
    );

    await postSwap();

    expect(lastDisposition()).toBe("release");
  });

  it("releases the lock when the spend cap is exceeded (pre-broadcast)", async () => {
    checkAndReserveExecutionMock.mockResolvedValue({
      allowed: false,
      reason: "Daily spending cap exceeded",
    });

    await postSwap();

    expect(lastDisposition()).toBe("release");
  });

  it("finalizes as success when the write broadcasts and succeeds", async () => {
    const response = await postSwap();
    const body = (await response.json()) as {
      executionId: string;
      status: string;
      transactionHash?: string;
    };

    expect(response.status).toBe(202);
    expect(body).toEqual(
      expect.objectContaining({
        executionId: "exec_1",
        status: "completed",
        transactionHash: "0xtx",
      })
    );
    expect(lastDisposition()).toBe("success");
    expect(recordIdempotentResponseMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 202 }),
      "success"
    );
  });

  it("finalizes as failed when the write reverts after broadcast", async () => {
    writeContractCoreMock.mockResolvedValue({
      success: false,
      error: "reverted",
      transactionHash: "0xfailed",
      transactionLink: "https://scan/0xfailed",
      rejection: { kind: "string-revert", reason: "execution reverted" },
      errorClass: "external",
    });

    const response = await postSwap();
    const body = (await response.json()) as {
      executionId: string;
      status: string;
      error?: string;
      transactionHash?: string;
      transactionLink?: string;
      rejection?: { kind: string; reason?: string };
      errorClass?: string;
    };

    expect(response.status).toBe(202);
    expect(body).toEqual(
      expect.objectContaining({
        executionId: "exec_1",
        status: "failed",
        error: "reverted",
        transactionHash: "0xfailed",
        transactionLink: "https://scan/0xfailed",
        rejection: { kind: "string-revert", reason: "execution reverted" },
        errorClass: "external",
      })
    );
    expect(failExecutionMock).toHaveBeenCalledWith(
      "exec_1",
      "reverted",
      expect.objectContaining({
        transactionHash: "0xfailed",
        transactionLink: "https://scan/0xfailed",
        rejection: { kind: "string-revert", reason: "execution reverted" },
        errorClass: "external",
      })
    );
    expect(lastDisposition()).toBe("failed");
  });

  it("omits error on unconfirmed so callers poll instead of retrying", async () => {
    writeContractCoreMock.mockResolvedValue({
      success: false,
      error: "receipt unreadable",
      transactionHash: "0xpending",
      transactionLink: "https://scan/0xpending",
      rejection: { kind: "string-revert", reason: "pending" },
      errorClass: "external",
    });
    failExecutionMock.mockResolvedValue({ status: "unconfirmed" });

    const response = await postSwap();
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(202);
    expect(body.status).toBe("unconfirmed");
    expect(body.transactionHash).toBe("0xpending");
    expect(body.transactionLink).toBe("https://scan/0xpending");
    expect(body).not.toHaveProperty("error");
    expect(body).not.toHaveProperty("rejection");
    expect(body).not.toHaveProperty("errorClass");
    expect(lastDisposition()).toBe("failed");
  });
});
