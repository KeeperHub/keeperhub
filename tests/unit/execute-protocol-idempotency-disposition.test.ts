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

const readContractCoreMock = vi.fn();
vi.mock("@/plugins/web3/steps/read-contract-core", () => ({
  readContractCore: (input: unknown) => readContractCoreMock(input),
}));

// The dry-run and token-transfer paths these routes also import. Never reached
// by a broadcasting write, and stubbing them keeps the module graph (and so the
// dynamic import inside each test) small enough not to trip the 10s timeout.
vi.mock("@/lib/execute/simulate", () => ({
  simulateContractCall: vi.fn(),
  simulateNativeTransfer: vi.fn(),
  simulateTokenTransfer: vi.fn(),
}));

vi.mock("@/plugins/web3/steps/transfer-token-core", () => ({
  transferTokenCore: vi.fn(),
  parseTokenAddress: vi.fn(),
}));

const transferFundsCoreMock = vi.fn();
vi.mock("@/plugins/web3/steps/transfer-funds-core", () => ({
  transferFundsCore: (input: unknown) => transferFundsCoreMock(input),
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
// The real rule, not a copy of it. ./idempotency-disposition has no database
// import, so it survives mocking @/lib/idempotency and these assertions fail if
// the rule regresses. Mirroring it here would have left them green.
vi.mock("@/lib/idempotency", async () => ({
  ...(await vi.importActual<typeof import("@/lib/idempotency-disposition")>(
    "@/lib/idempotency-disposition"
  )),
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

const CONTRACT_ADDRESS = "0x1234567890123456789012345678901234567890";
const RECIPIENT_ADDRESS = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";

// A nonpayable entry so contract-call and check-and-execute both route to the
// broadcasting write path rather than a read or a simulate.
const WRITE_ABI = JSON.stringify([
  {
    type: "function",
    name: "swap",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
]);

// Single uint256 output, which is what the check-and-execute condition
// comparison accepts.
const CHECK_ABI = JSON.stringify([
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
]);

function executeRequest(path: string, body: Record<string, unknown>): Request {
  return new Request(`http://test/api/execute/${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      authorization: "Bearer x",
      "idempotency-key": `idem_${path}`,
    },
  });
}

async function postTransfer(): Promise<Response> {
  const { POST } = await import("@/app/api/execute/transfer/route");
  return POST(
    executeRequest("transfer", {
      chainId: 8453,
      recipientAddress: RECIPIENT_ADDRESS,
      amount: "0.01",
    })
  );
}

async function postContractCall(): Promise<Response> {
  const { POST } = await import("@/app/api/execute/contract-call/route");
  return POST(
    executeRequest("contract-call", {
      chainId: 8453,
      contractAddress: CONTRACT_ADDRESS,
      functionName: "swap",
      abi: WRITE_ABI,
    })
  );
}

async function postCheckAndExecute(): Promise<Response> {
  const { POST } = await import("@/app/api/execute/check-and-execute/route");
  return POST(
    executeRequest("check-and-execute", {
      chainId: 8453,
      contractAddress: CONTRACT_ADDRESS,
      functionName: "balanceOf",
      abi: CHECK_ABI,
      condition: { operator: "gte", value: "1" },
      action: {
        contractAddress: CONTRACT_ADDRESS,
        functionName: "swap",
        abi: WRITE_ABI,
      },
    })
  );
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
  transferFundsCoreMock.mockResolvedValue({
    success: true,
    transactionHash: "0xtx",
    transactionLink: "https://scan/0xtx",
    gasUsed: "21000",
    effectiveGasPrice: "1000000000",
  });
  // The check-and-execute condition read. Satisfies `balanceOf >= 1` so the
  // route reaches its write branch.
  readContractCoreMock.mockResolvedValue({ success: true, result: "100" });
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

  it("releases the key when the write reverts conclusively (#1840)", async () => {
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
    // A conclusive revert is a definite outcome, so the key is freed rather
    // than replaying the revert for 24 hours (#1840). The response still
    // reports status "failed" -- what changed is only the key's fate.
    expect(lastDisposition()).toBe("release");
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
    // Held, not released: the broadcast may still land.
    expect(lastDisposition()).toBe("failed");
  });

  it("holds the key on unconfirmed even though the caller sees a failure", async () => {
    // The pair that constrains this issue: releasing here is the
    // double-broadcast bug, holding on a conclusive revert is the liveness bug.
    writeContractCoreMock.mockResolvedValue({
      success: false,
      error: "receipt unreadable",
      transactionHash: "0xmaybe",
    });
    failExecutionMock.mockResolvedValue({ status: "unconfirmed" });

    await postSwap();

    expect(lastDisposition()).toBe("failed");
  });

  it("holds the key when write fails without a transaction hash to guard lost sends (#1840)", async () => {
    // When writeContractCore fails without a transactionHash (e.g. a lost response
    // on eth_sendRawTransaction where the tx entered the mempool but no tx object
    // was returned to the client), failExecution cannot adjudicate whether a broadcast
    // landed. The key must be held ("failed") rather than released to prevent a retry
    // from seeing the stranded transaction in the mempool, allocating nonce+1, and
    // double-broadcasting.
    writeContractCoreMock.mockResolvedValue({
      success: false,
      error: "LK: not yet due",
    });
    failExecutionMock.mockResolvedValue({ status: "failed" });

    const response = await postSwap();

    expect(response.status).toBe(202);
    expect(lastDisposition()).toBe("failed");
  });
});

// The same rule, at the other three chain-write call sites. `[...slug]` above
// covered only one of the four copies, so a drift in any of these read as
// green -- which is the shape of the bug the shared rule exists to prevent.
describe("execute transfer idempotency disposition", () => {
  it("holds the key when the transfer fails without a transaction hash to guard lost sends", async () => {
    // No hash means nothing was adjudicated: the send may have entered the
    // mempool with the response lost. Releasing would let a retry take the
    // next pending nonce alongside a transaction still sitting there.
    transferFundsCoreMock.mockResolvedValue({
      success: false,
      error: "LK: not yet due",
    });
    failExecutionMock.mockResolvedValue({ status: "failed" });

    const response = await postTransfer();

    expect(response.status).toBe(202);
    expect(lastDisposition()).toBe("failed");
  });

  it("releases the key when the transfer reverts conclusively", async () => {
    transferFundsCoreMock.mockResolvedValue({
      success: false,
      error: "reverted",
      transactionHash: "0xfailed",
      transactionLink: "https://scan/0xfailed",
    });
    failExecutionMock.mockResolvedValue({ status: "failed" });

    const response = await postTransfer();

    expect(response.status).toBe(202);
    expect(lastDisposition()).toBe("release");
  });

  it("finalizes as success when the transfer broadcasts and succeeds", async () => {
    const response = await postTransfer();

    expect(response.status).toBe(202);
    expect(lastDisposition()).toBe("success");
  });
});

describe("execute contract-call idempotency disposition", () => {
  it("holds the key when the contract call fails without a transaction hash to guard lost sends", async () => {
    writeContractCoreMock.mockResolvedValue({
      success: false,
      error: "LK: not yet due",
    });
    failExecutionMock.mockResolvedValue({ status: "failed" });

    const response = await postContractCall();

    expect(response.status).toBe(202);
    expect(lastDisposition()).toBe("failed");
  });

  it("releases the key when the contract call reverts conclusively", async () => {
    writeContractCoreMock.mockResolvedValue({
      success: false,
      error: "reverted",
      transactionHash: "0xfailed",
      transactionLink: "https://scan/0xfailed",
    });
    failExecutionMock.mockResolvedValue({ status: "failed" });

    const response = await postContractCall();

    expect(response.status).toBe(202);
    expect(lastDisposition()).toBe("release");
  });

  it("finalizes as success when the contract call broadcasts and succeeds", async () => {
    const response = await postContractCall();

    expect(response.status).toBe(202);
    expect(lastDisposition()).toBe("success");
  });
});

describe("execute check-and-execute idempotency disposition", () => {
  it("holds the key when the conditional write fails without a transaction hash to guard lost sends", async () => {
    writeContractCoreMock.mockResolvedValue({
      success: false,
      error: "LK: not yet due",
    });
    failExecutionMock.mockResolvedValue({ status: "failed" });

    const response = await postCheckAndExecute();

    expect(response.status).toBe(202);
    expect(lastDisposition()).toBe("failed");
  });

  it("releases the key when the conditional write reverts conclusively", async () => {
    writeContractCoreMock.mockResolvedValue({
      success: false,
      error: "reverted",
      transactionHash: "0xfailed",
      transactionLink: "https://scan/0xfailed",
    });
    failExecutionMock.mockResolvedValue({ status: "failed" });

    const response = await postCheckAndExecute();

    expect(response.status).toBe(202);
    expect(lastDisposition()).toBe("release");
  });

  it("finalizes as success when the conditional write broadcasts and succeeds", async () => {
    const response = await postCheckAndExecute();

    expect(response.status).toBe(202);
    expect(lastDisposition()).toBe("success");
  });
});
