import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("../../app/api/execute/_lib/auth", () => ({
  validateApiKey: vi
    .fn()
    .mockResolvedValue({ organizationId: "org_1", apiKeyId: "key_1" }),
}));

vi.mock("../../app/api/execute/_lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockReturnValue({ allowed: true }),
}));

vi.mock("@/lib/db", () => ({ db: {} }));

vi.mock("@/lib/db/org-helpers", () => ({
  enterApiExecuteErrorContext: vi.fn(),
}));

vi.mock("@/lib/logging", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/logging")>()),
  logSecurityEvent: vi.fn(),
}));

const enforceExecutionLimitMock = vi.fn();
vi.mock("@/lib/billing/execution-guard", () => ({
  enforceExecutionLimit: (orgId: string) => enforceExecutionLimitMock(orgId),
}));

const requireWalletMock = vi.fn();
vi.mock("../../app/api/execute/_lib/wallet-check", () => ({
  requireWallet: (orgId: string) => requireWalletMock(orgId),
}));

const isOrgHaltedMock = vi.fn();
vi.mock("@/lib/execute/org-circuit-breaker", () => ({
  ORG_HALTED_REASON: "Organization circuit breaker is engaged",
  isOrgHalted: (...args: unknown[]) => isOrgHaltedMock(...args),
}));

const prepareMock = vi.fn();
const executeMock = vi.fn();
vi.mock("@/lib/execute/gas-top-up", () => ({
  prepareGasTopUp: (params: unknown) => prepareMock(params),
  executeGasTopUp: (params: unknown) => executeMock(params),
}));

const checkAndReserveExecutionMock = vi.fn();
vi.mock("../../app/api/execute/_lib/spending-cap", () => ({
  checkAndReserveExecution: (params: unknown) =>
    checkAndReserveExecutionMock(params),
}));

const enforceConcurrencyMock = vi.fn();
vi.mock("../../app/api/execute/_lib/concurrency-limit", () => ({
  enforceDirectExecutionConcurrency: (orgId: string) =>
    enforceConcurrencyMock(orgId),
}));

const completeExecutionMock = vi.fn();
const failExecutionMock = vi.fn();
vi.mock("../../app/api/execute/_lib/execution-service", () => ({
  markRunning: vi.fn(),
  completeExecution: (...args: unknown[]) => completeExecutionMock(...args),
  failExecution: (...args: unknown[]) => failExecutionMock(...args),
  redactInput: (x: unknown) => x,
}));

const recordIdempotentResponseMock = vi.fn(
  (_outcome: unknown, response: Response, _disposition?: string) =>
    Promise.resolve(response)
);
const idempotencyEarlyResponseMock = vi.fn();
vi.mock("@/lib/idempotency", async () => ({
  ...(await vi.importActual<typeof import("@/lib/idempotency-disposition")>(
    "@/lib/idempotency-disposition"
  )),
  beginIdempotentFromRequest: vi.fn().mockResolvedValue({ kind: "proceed" }),
  idempotencyEarlyResponse: (outcome: unknown) =>
    idempotencyEarlyResponseMock(outcome),
  recordIdempotentResponse: (
    outcome: unknown,
    response: Response,
    disposition?: string
  ) => recordIdempotentResponseMock(outcome, response, disposition),
  withIdempotencyHeartbeat: (_outcome: unknown, fn: () => unknown) => fn(),
}));

const { POST } = await import("@/app/api/execute/gas-top-up/route");
const { sumOrgGasTopUpTodayMicroUsd } = await import(
  "@/lib/execute/value-ledger"
);

const PLAN = {
  chainId: 8453,
  amountUsdc: "5",
  amountMicroUsd: BigInt(5_000_000),
};

function post(body: unknown, query = ""): Promise<Response> {
  return POST(
    new Request(`http://test/api/execute/gas-top-up${query}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        authorization: "Bearer x",
        "idempotency-key": "idem_1",
      },
    })
  );
}

function lastDisposition(): string | undefined {
  return recordIdempotentResponseMock.mock.calls.at(-1)?.[2];
}

const baseResult = {
  chainId: 8453,
  wallet: "0x1111111111111111111111111111111111111111",
  sponsored: true,
  quotedWethOut: "1000",
  amountOutMinimum: "995",
  gasUsedWei: "300",
};

const successResult = {
  ...baseResult,
  success: true,
  steps: [
    { name: "approve", status: "confirmed", transactionHash: "0xa" },
    { name: "swap", status: "confirmed", transactionHash: "0xs" },
    { name: "unwrap", status: "confirmed", transactionHash: "0xu" },
  ],
  usdcSpent: "5",
  wethReceived: "0.001",
  ethReceived: "0.001",
  broadcastAttempted: true,
  swapLanded: true,
  finalTransactionHash: "0xu",
  finalTransactionLink: "https://basescan.org/tx/0xu",
};

beforeEach(() => {
  vi.clearAllMocks();
  enforceExecutionLimitMock.mockResolvedValue({ blocked: false });
  requireWalletMock.mockResolvedValue(null);
  isOrgHaltedMock.mockResolvedValue(false);
  enforceConcurrencyMock.mockResolvedValue(null);
  prepareMock.mockResolvedValue({ ok: true, plan: PLAN });
  executeMock.mockResolvedValue(successResult);
  checkAndReserveExecutionMock.mockResolvedValue({
    allowed: true,
    executionId: "exec_1",
  });
  completeExecutionMock.mockResolvedValue({ status: "completed" });
  failExecutionMock.mockResolvedValue({ status: "failed" });
  idempotencyEarlyResponseMock.mockReturnValue(null);
});

describe("POST /api/execute/gas-top-up", () => {
  it("returns 202 with the execution id, every step, and the amounts", async () => {
    const response = await post({ chainId: 8453, amountUsdc: "5" });

    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body).toMatchObject({
      executionId: "exec_1",
      status: "completed",
      chainId: 8453,
      transactionHash: "0xu",
      transactionLink: "https://basescan.org/tx/0xu",
      usdcSpent: "5",
      ethReceived: "0.001",
      amountOutMinimum: "995",
      sponsored: true,
    });
    expect(body.steps).toHaveLength(3);
    expect(body).not.toHaveProperty("swapPending");
    expect(body).not.toHaveProperty("approvalRevoked");
    expect(body).not.toHaveProperty("revokeTransactionHash");
    expect(lastDisposition()).toBe("success");
    expect(checkAndReserveExecutionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "gas-top-up",
        reserved: { kind: "evm", valueWei: "0" },
        // The day's total is summed from this field, so it must be exact.
        input: expect.objectContaining({ amountMicroUsd: "5000000" }),
        stablecoinDaily: expect.objectContaining({
          amountMicroUsd: BigInt(5_000_000),
          capMicroUsd: BigInt(200_000_000),
          label: "gas top-up",
        }),
      })
    );
    // The native-value sums take the same arguments, so only identity tells
    // the gas top-up sum apart from them.
    expect(
      checkAndReserveExecutionMock.mock.calls[0][0].stablecoinDaily
        .sumTodayMicroUsd
    ).toBe(sumOrgGasTopUpTodayMicroUsd);
    // The status endpoint reads the link back from the stored output.
    expect(completeExecutionMock).toHaveBeenCalledWith(
      "exec_1",
      expect.objectContaining({
        transactionHash: "0xu",
        chainId: 8453,
        output: expect.objectContaining({
          transactionLink: "https://basescan.org/tx/0xu",
        }),
      })
    );
  });

  it("charges the daily cap the prepared plan's amount, not a re-parse of the body", async () => {
    prepareMock.mockResolvedValue({
      ok: true,
      plan: { ...PLAN, amountMicroUsd: BigInt(7_000_000) },
    });

    await post({ chainId: 8453, amountUsdc: "5" });

    expect(checkAndReserveExecutionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ amountMicroUsd: "7000000" }),
        stablecoinDaily: expect.objectContaining({
          amountMicroUsd: BigInt(7_000_000),
        }),
      })
    );
  });

  it("refuses with 403 when the org circuit breaker is engaged, before anything is prepared or sent", async () => {
    isOrgHaltedMock.mockResolvedValue(true);

    const response = await post({ chainId: 8453, amountUsdc: "5" });

    expect(response.status).toBe(403);
    expect(prepareMock).not.toHaveBeenCalled();
    expect(checkAndReserveExecutionMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("refuses at the concurrency limit before any RPC, quote or Turnkey work", async () => {
    enforceConcurrencyMock.mockResolvedValue(
      NextResponse.json({ error: "Too many in-flight" }, { status: 429 })
    );

    const response = await post({ chainId: 8453, amountUsdc: "5" });

    expect(response.status).toBe(429);
    expect(enforceConcurrencyMock).toHaveBeenCalledWith("org_1");
    expect(prepareMock).not.toHaveBeenCalled();
    expect(checkAndReserveExecutionMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("refuses an amount over the stablecoin cap with 403 and reserves nothing", async () => {
    prepareMock.mockResolvedValue({
      ok: false,
      code: "STABLECOIN_CAP_EXCEEDED",
      error: "exceeds the 100 USD per-transaction limit",
      field: "amountUsdc",
    });

    const response = await post({ chainId: 8453, amountUsdc: "250" });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "STABLECOIN_CAP_EXCEEDED",
      field: "amountUsdc",
    });
    expect(lastDisposition()).toBe("release");
    expect(checkAndReserveExecutionMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("refuses a spent daily budget with 403 from preparation, releasing the key", async () => {
    const error =
      "Daily gas top-up limit exceeded: 198 USD used today, 5 USD requested, limit 200 USD";
    prepareMock.mockResolvedValue({
      ok: false,
      code: "DAILY_LIMIT_EXCEEDED",
      error,
      field: "amountUsdc",
    });

    const response = await post({ chainId: 8453, amountUsdc: "5" });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error,
      code: "DAILY_LIMIT_EXCEEDED",
      field: "amountUsdc",
    });
    expect(lastDisposition()).toBe("release");
    expect(checkAndReserveExecutionMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("refuses with 422 when sponsorship is unavailable", async () => {
    prepareMock.mockResolvedValue({
      ok: false,
      code: "SPONSORSHIP_UNAVAILABLE",
      error: "Gas sponsorship credits are exhausted",
    });

    const response = await post({ chainId: 8453, amountUsdc: "5" });

    expect(response.status).toBe(422);
    expect(lastDisposition()).toBe("release");
    expect(executeMock).not.toHaveBeenCalled();
  });

  it.each([
    [{ chainId: 8453, amountUsdc: "5", recipient: "0xdead" }, "recipient"],
    [{ chainId: 8453, amountUsdc: "5", slippageBps: 500 }, "slippageBps"],
    [{ chainId: 10, amountUsdc: "5" }, "chainId"],
    [{ chainId: 8453, amountUsdc: "0" }, "amountUsdc"],
    [{ chainId: 8453, amountUsdc: "1.0000001" }, "amountUsdc"],
    [{ chainId: 8453, amountUsdc: 5 }, "amountUsdc"],
  ])("rejects %j at field %s", async (body, field) => {
    const response = await post(body);

    expect(response.status).toBe(400);
    expect((await response.json()).field).toBe(field);
    expect(prepareMock).not.toHaveBeenCalled();
  });

  it("refuses a simulate request in the body", async () => {
    const response = await post({
      chainId: 8453,
      amountUsdc: "5",
      simulate: true,
    });

    expect(response.status).toBe(400);
    expect(prepareMock).not.toHaveBeenCalled();
  });

  it("refuses a simulate request in the query string", async () => {
    const response = await post(
      { chainId: 8453, amountUsdc: "5" },
      "?simulate=true"
    );

    expect(response.status).toBe(400);
    expect(prepareMock).not.toHaveBeenCalled();
  });

  it("replays an idempotent retry without sending again", async () => {
    idempotencyEarlyResponseMock.mockReturnValue({
      status: 202,
      body: {
        executionId: "exec_1",
        status: "completed",
        idempotentReplay: true,
      },
    });

    const response = await post({ chainId: 8453, amountUsdc: "5" });

    expect(response.status).toBe(202);
    expect((await response.json()).idempotentReplay).toBe(true);
    // A replay must not reach preparation, whose daily check would count the
    // original run against its own retry.
    expect(prepareMock).not.toHaveBeenCalled();
    expect(checkAndReserveExecutionMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("releases the key when nothing was broadcast", async () => {
    executeMock.mockResolvedValue({
      ...baseResult,
      success: false,
      steps: [
        { name: "approve", status: "skipped" },
        { name: "swap", status: "skipped" },
        { name: "unwrap", status: "skipped" },
      ],
      usdcSpent: "0",
      broadcastAttempted: false,
      swapLanded: false,
      error: "Quote returned no WETH",
      failure: {
        step: "preflight",
        error: "Quote returned no WETH",
        broadcastAttempted: false,
      },
    });

    const response = await post({ chainId: 8453, amountUsdc: "5" });

    expect(response.status).toBe(202);
    expect((await response.json()).status).toBe("failed");
    expect(lastDisposition()).toBe("release");
  });

  it("holds the key and reports partial completion once the swap has landed", async () => {
    executeMock.mockResolvedValue({
      ...baseResult,
      success: false,
      steps: [
        { name: "approve", status: "confirmed", transactionHash: "0xa" },
        { name: "swap", status: "confirmed", transactionHash: "0xs" },
        { name: "unwrap", status: "failed", transactionHash: "0xu" },
      ],
      usdcSpent: "5",
      wethReceived: "0.001",
      broadcastAttempted: true,
      swapLanded: true,
      error: "the swapped WETH is left unwrapped",
      failure: {
        step: "unwrap",
        error: "the swapped WETH is left unwrapped",
        transactionHash: "0xu",
        transactionLink: "https://basescan.org/tx/0xu",
        broadcastAttempted: true,
      },
    });

    const response = await post({ chainId: 8453, amountUsdc: "5" });

    const body = await response.json();
    expect(body).toMatchObject({
      status: "failed",
      usdcSpent: "5",
      wethReceived: "0.001",
      transactionHash: "0xu",
      transactionLink: "https://basescan.org/tx/0xu",
    });
    expect(body.steps.map((s: { status: string }) => s.status)).toEqual([
      "confirmed",
      "confirmed",
      "failed",
    ]);
    // A conclusive failure with a hash would normally release; not here,
    // because the USDC is already spent.
    expect(lastDisposition()).toBe("failed");
    expect(failExecutionMock).toHaveBeenCalledWith(
      "exec_1",
      "the swapped WETH is left unwrapped",
      expect.objectContaining({
        transactionHash: "0xu",
        transactionLink: "https://basescan.org/tx/0xu",
        chainId: 8453,
        sponsored: true,
        output: expect.objectContaining({ swapLanded: true }),
      })
    );
  });

  const swapFailedSteps = [
    { name: "approve", status: "confirmed", transactionHash: "0xa" },
    { name: "swap", status: "failed", transactionHash: "0xs" },
    { name: "unwrap", status: "skipped" },
  ];

  it.each([
    [
      "set back to zero",
      {
        approvalRevoked: true,
        revokeTransactionHash: "0xr",
        revokeTransactionLink: "https://basescan.org/tx/0xr",
      },
    ],
    ["left in place", { approvalRevoked: false }],
  ])(
    "returns whether the approval was %s after a failed swap",
    async (_label, revoke) => {
      executeMock.mockResolvedValue({
        ...baseResult,
        ...revoke,
        success: false,
        steps: swapFailedSteps,
        usdcSpent: "0",
        broadcastAttempted: true,
        swapLanded: false,
        error: "Approve confirmed but the swap did not complete",
        failure: {
          step: "swap",
          error: "Approve confirmed but the swap did not complete",
          transactionHash: "0xs",
          broadcastAttempted: true,
        },
      });

      const response = await post({ chainId: 8453, amountUsdc: "5" });

      const body = await response.json();
      expect(body).toMatchObject({
        status: "failed",
        usdcSpent: "0",
        ...revoke,
      });
      expect(body).not.toHaveProperty("swapPending");
      if (!revoke.approvalRevoked) {
        expect(body).not.toHaveProperty("revokeTransactionHash");
      }
    }
  );

  it("returns swapPending while a broadcast swap is unconfirmed", async () => {
    executeMock.mockResolvedValue({
      ...baseResult,
      success: false,
      steps: swapFailedSteps,
      broadcastAttempted: true,
      swapLanded: false,
      swapPending: true,
      error: "the USDC may or may not have been spent",
      failure: {
        step: "swap",
        error: "the USDC may or may not have been spent",
        transactionHash: "0xs",
        broadcastAttempted: true,
        pending: true,
      },
    });

    const response = await post({ chainId: 8453, amountUsdc: "5" });

    const body = await response.json();
    expect(body.swapPending).toBe(true);
    expect(body).not.toHaveProperty("usdcSpent");
    expect(body).not.toHaveProperty("approvalRevoked");
  });

  it("returns the reservation refusal as 403 and releases the key", async () => {
    checkAndReserveExecutionMock.mockResolvedValue({
      allowed: false,
      reason: "Daily spending cap exceeded",
    });

    const response = await post({ chainId: 8453, amountUsdc: "5" });

    expect(response.status).toBe(403);
    expect(lastDisposition()).toBe("release");
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("returns a missing-wallet refusal before the breaker and preparation", async () => {
    requireWalletMock.mockResolvedValue(
      NextResponse.json({ error: "WALLET_NOT_CONFIGURED" }, { status: 422 })
    );

    const response = await post({ chainId: 8453, amountUsdc: "5" });

    expect(response.status).toBe(422);
    expect(isOrgHaltedMock).not.toHaveBeenCalled();
    expect(prepareMock).not.toHaveBeenCalled();
  });
});
