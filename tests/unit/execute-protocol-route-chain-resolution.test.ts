import { describe, expect, it, vi } from "vitest";

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

const getProtocolMock = vi.fn().mockReturnValue({
  contracts: {
    router: {
      addresses: {
        "1": "0xMainnetRouter",
        "11155111": "0xSepoliaRouter",
        "8453": "0xBaseRouter",
      },
    },
  },
  actions: [],
});
vi.mock("@/lib/protocol-registry", () => ({
  getProtocol: (...args: unknown[]) => getProtocolMock(...args),
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

const writeContractCoreMock = vi.fn().mockResolvedValue({
  success: true,
  transactionHash: "0xtx",
});
vi.mock("@/plugins/web3/steps/write-contract-core", () => ({
  writeContractCore: (input: unknown) => writeContractCoreMock(input),
}));

vi.mock("@/plugins/web3/steps/read-contract-core", () => ({
  readContractCore: vi.fn(),
}));

vi.mock("@/lib/step-registry", () => ({
  PLUGIN_STEP_IMPORTERS: { "test-protocol/swap": () => Promise.resolve({}) },
}));

// KEEP-793 write-path guards: happy defaults so chain-resolution still reaches
// writeContractCore. Behavior of these guards is covered in
// execute-protocol-execution-guards.test.ts.
vi.mock("@/lib/billing/execution-guard", () => ({
  enforceExecutionLimit: vi.fn().mockResolvedValue({ blocked: false }),
}));
vi.mock("../../app/api/execute/_lib/wallet-check", () => ({
  requireWallet: vi.fn().mockResolvedValue(null),
}));
vi.mock("../../app/api/execute/_lib/spending-cap", () => ({
  checkAndReserveExecution: vi
    .fn()
    .mockResolvedValue({ allowed: true, executionId: "exec_1" }),
}));

vi.mock("../../app/api/execute/_lib/concurrency-limit", () => ({
  enforceDirectExecutionConcurrency: vi.fn().mockResolvedValue(null),
}));
vi.mock("../../app/api/execute/_lib/execution-service", () => ({
  markRunning: vi.fn().mockResolvedValue(undefined),
  completeExecution: vi.fn().mockResolvedValue({ status: "completed" }),
  failExecution: vi.fn().mockResolvedValue(undefined),
  redactInput: (x: unknown) => x,
  withRejectedSignerOverride: (a: unknown) => a,
}));

async function postWithBody(body: Record<string, unknown>): Promise<Response> {
  const { POST } = await import("@/app/api/execute/[...slug]/route");
  const req = new Request("http://test/api/execute/test-protocol/swap", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", authorization: "Bearer x" },
  });
  return POST(req, {
    params: Promise.resolve({ slug: ["test-protocol", "swap"] }),
  });
}

const CHAIN_ID_ERROR_RE = /chainId/;

describe("KEEP-490: /api/execute/[...slug] resolves chain names and chainId aliases", () => {
  it("resolves network='sepolia' to chainId 11155111 for contract address lookup", async () => {
    writeContractCoreMock.mockClear();
    const response = await postWithBody({ network: "sepolia" });

    expect(response.status).toBe(200);
    expect(writeContractCoreMock).toHaveBeenCalledWith(
      expect.objectContaining({
        contractAddress: "0xSepoliaRouter",
        network: "11155111",
      })
    );
  });

  it("accepts chainId as canonical input", async () => {
    writeContractCoreMock.mockClear();
    const response = await postWithBody({ chainId: 8453 });

    expect(response.status).toBe(200);
    expect(writeContractCoreMock).toHaveBeenCalledWith(
      expect.objectContaining({
        contractAddress: "0xBaseRouter",
        network: "8453",
      })
    );
  });

  it("returns 400 with a clear error when both chainId and network are missing", async () => {
    const response = await postWithBody({});
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(body.error).toMatch(CHAIN_ID_ERROR_RE);
  });

  it("returns 400 for an unknown chain name", async () => {
    const response = await postWithBody({ network: "not-a-real-chain" });

    expect(response.status).toBe(400);
  });
});
