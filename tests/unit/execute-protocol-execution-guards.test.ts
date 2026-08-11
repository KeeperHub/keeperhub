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

// The guards under test (A-07 / KEEP-793).
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

const markRunningMock = vi.fn();
const completeExecutionMock = vi.fn();
const failExecutionMock = vi.fn();
vi.mock("../../app/api/execute/_lib/execution-service", () => ({
  markRunning: (id: string) => markRunningMock(id),
  completeExecution: (id: string, r: unknown) => completeExecutionMock(id, r),
  failExecution: (id: string, e: string) => failExecutionMock(id, e),
  redactInput: (x: unknown) => x,
  withRejectedSignerOverride: (a: unknown) => a,
}));

async function postSwap(): Promise<Response> {
  const { POST } = await import("@/app/api/execute/[...slug]/route");
  const req = new Request("http://test/api/execute/test-protocol/swap", {
    method: "POST",
    body: JSON.stringify({ chainId: 8453 }),
    headers: { "content-type": "application/json", authorization: "Bearer x" },
  });
  return POST(req, {
    params: Promise.resolve({ slug: ["test-protocol", "swap"] }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  enforceExecutionLimitMock.mockResolvedValue({ blocked: false });
  requireWalletMock.mockResolvedValue(null);
  checkAndReserveExecutionMock.mockResolvedValue({
    allowed: true,
    executionId: "exec_1",
  });
  writeContractCoreMock.mockResolvedValue({
    success: true,
    transactionHash: "0xtx",
    chainId: 8453,
    transactionLink: "https://scan/0xtx",
    gasUsed: "21000",
    effectiveGasPrice: "1000000000",
  });
  completeExecutionMock.mockResolvedValue({ status: "completed" });
});

describe("A-07 / KEEP-793: protocol write actions are gated and recorded", () => {
  it("enforces the plan limit, wallet, spend cap, and records the execution", async () => {
    const response = await postSwap();

    expect(response.status).toBe(200);
    expect(enforceExecutionLimitMock).toHaveBeenCalledWith("org_1");
    expect(requireWalletMock).toHaveBeenCalledWith("org_1");
    expect(checkAndReserveExecutionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org_1",
        apiKeyId: "key_1",
        type: "protocol-action",
        network: "8453",
      })
    );
    expect(markRunningMock).toHaveBeenCalledWith("exec_1");
    expect(completeExecutionMock).toHaveBeenCalledWith(
      "exec_1",
      expect.objectContaining({ transactionHash: "0xtx" })
    );
    expect(writeContractCoreMock).toHaveBeenCalledTimes(1);
  });

  it("returns 403 and never broadcasts when the daily spend cap is exceeded", async () => {
    checkAndReserveExecutionMock.mockResolvedValue({
      allowed: false,
      reason: "Daily spending cap exceeded",
    });

    const response = await postSwap();

    expect(response.status).toBe(403);
    expect(writeContractCoreMock).not.toHaveBeenCalled();
    expect(markRunningMock).not.toHaveBeenCalled();
  });

  it("returns the wallet error and never reserves or broadcasts when no wallet", async () => {
    requireWalletMock.mockResolvedValue(
      NextResponse.json(
        { error: "No wallet", code: "WALLET_NOT_CONFIGURED" },
        { status: 422 }
      )
    );

    const response = await postSwap();

    expect(response.status).toBe(422);
    expect(checkAndReserveExecutionMock).not.toHaveBeenCalled();
    expect(writeContractCoreMock).not.toHaveBeenCalled();
  });

  it("returns the plan-limit block and never broadcasts when over the plan limit", async () => {
    enforceExecutionLimitMock.mockResolvedValue({
      blocked: true,
      response: NextResponse.json({ error: "limit" }, { status: 402 }),
    });

    const response = await postSwap();

    expect(response.status).toBe(402);
    expect(requireWalletMock).not.toHaveBeenCalled();
    expect(checkAndReserveExecutionMock).not.toHaveBeenCalled();
    expect(writeContractCoreMock).not.toHaveBeenCalled();
  });
});
