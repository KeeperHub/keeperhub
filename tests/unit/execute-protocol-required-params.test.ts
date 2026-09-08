import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/protocols", () => ({}));

const getProtocolMock = vi.fn();
vi.mock("@/lib/protocol-registry", () => ({
  getProtocol: (slug: string) => getProtocolMock(slug),
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
    contractKey: "pool",
    functionName: "supply",
    actionType: "write",
  }),
}));

const writeContractCoreMock = vi.fn();
vi.mock("@/plugins/web3/steps/write-contract-core", () => ({
  writeContractCore: (input: unknown) => writeContractCoreMock(input),
}));

vi.mock("@/plugins/web3/steps/read-contract-core", () => ({
  readContractCore: vi.fn(),
}));

vi.mock("@/lib/step-registry", () => ({
  PLUGIN_STEP_IMPORTERS: {
    "test-protocol/supply": () => Promise.resolve({}),
  },
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

vi.mock("../../app/api/execute/_lib/execution-service", () => ({
  markRunning: vi.fn(),
  completeExecution: vi.fn().mockResolvedValue({ status: "completed" }),
  failExecution: vi.fn(),
  redactInput: (x: unknown) => x,
  withRejectedSignerOverride: (a: unknown) => a,
}));

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

function protocolWithSupplyInputs(
  inputs: Array<{
    name: string;
    type?: string;
    label?: string;
    default?: string;
    required?: boolean;
  }>
) {
  return {
    contracts: { pool: { addresses: { "8453": "0xPool" } } },
    actions: [
      {
        function: "supply",
        contract: "pool",
        inputs: inputs.map((inp) => ({
          type: "uint256",
          label: inp.name,
          ...inp,
        })),
      },
    ],
  };
}

describe("buildProtocolFunctionArgs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a missing required field", async () => {
    getProtocolMock.mockReturnValue(
      protocolWithSupplyInputs([
        { name: "asset" },
        { name: "amount" },
        { name: "referralCode", default: "0" },
      ])
    );

    const { buildProtocolFunctionArgs } = await import(
      "@/app/api/execute/_lib/protocol-function-args"
    );
    const result = buildProtocolFunctionArgs(
      { asset: "0xToken" },
      "test-protocol",
      "pool",
      "supply"
    );

    expect(result).toEqual({
      ok: false,
      field: "amount",
      error: "Missing required field: amount",
    });
  });

  it("applies registry defaults for blank optional fields", async () => {
    getProtocolMock.mockReturnValue(
      protocolWithSupplyInputs([
        { name: "asset" },
        { name: "amount" },
        { name: "referralCode", default: "0" },
      ])
    );

    const { buildProtocolFunctionArgs } = await import(
      "@/app/api/execute/_lib/protocol-function-args"
    );
    const result = buildProtocolFunctionArgs(
      { asset: "0xToken", amount: "1000" },
      "test-protocol",
      "pool",
      "supply"
    );

    expect(result).toEqual({
      ok: true,
      functionArgs: JSON.stringify(["0xToken", "1000", "0"]),
    });
  });

  it("returns ok when all required fields are present", async () => {
    getProtocolMock.mockReturnValue(
      protocolWithSupplyInputs([
        { name: "asset" },
        { name: "amount" },
        { name: "onBehalfOf" },
        { name: "referralCode", default: "0" },
      ])
    );

    const { buildProtocolFunctionArgs } = await import(
      "@/app/api/execute/_lib/protocol-function-args"
    );
    const result = buildProtocolFunctionArgs(
      {
        asset: "0xToken",
        amount: "1000",
        onBehalfOf: "0xUser",
        referralCode: "7",
      },
      "test-protocol",
      "pool",
      "supply"
    );

    expect(result).toEqual({
      ok: true,
      functionArgs: JSON.stringify(["0xToken", "1000", "0xUser", "7"]),
    });
  });

  it("rejects null as a blank required field", async () => {
    getProtocolMock.mockReturnValue(
      protocolWithSupplyInputs([
        { name: "asset" },
        { name: "amount" },
        { name: "referralCode", default: "0" },
      ])
    );

    const { buildProtocolFunctionArgs } = await import(
      "@/app/api/execute/_lib/protocol-function-args"
    );
    const result = buildProtocolFunctionArgs(
      { asset: "0xToken", amount: null },
      "test-protocol",
      "pool",
      "supply"
    );

    expect(result).toEqual({
      ok: false,
      field: "amount",
      error: "Missing required field: amount",
    });
  });

  it("rejects blank when required is true even if a default exists", async () => {
    getProtocolMock.mockReturnValue(
      protocolWithSupplyInputs([
        { name: "asset" },
        { name: "amount", required: true, default: "0" },
      ])
    );

    const { buildProtocolFunctionArgs } = await import(
      "@/app/api/execute/_lib/protocol-function-args"
    );
    const result = buildProtocolFunctionArgs(
      { asset: "0xToken" },
      "test-protocol",
      "pool",
      "supply"
    );

    expect(result).toEqual({
      ok: false,
      field: "amount",
      error: "Missing required field: amount",
    });
  });

  it("allows blank when required is false and no default", async () => {
    getProtocolMock.mockReturnValue(
      protocolWithSupplyInputs([
        { name: "asset" },
        { name: "note", required: false },
      ])
    );

    const { buildProtocolFunctionArgs } = await import(
      "@/app/api/execute/_lib/protocol-function-args"
    );
    const result = buildProtocolFunctionArgs(
      { asset: "0xToken" },
      "test-protocol",
      "pool",
      "supply"
    );

    expect(result).toEqual({
      ok: true,
      functionArgs: JSON.stringify(["0xToken", ""]),
    });
  });

  it("returns undefined functionArgs when the action has no inputs", async () => {
    getProtocolMock.mockReturnValue({
      contracts: { pool: { addresses: { "8453": "0xPool" } } },
      actions: [{ function: "supply", contract: "pool", inputs: [] }],
    });

    const { buildProtocolFunctionArgs } = await import(
      "@/app/api/execute/_lib/protocol-function-args"
    );
    const result = buildProtocolFunctionArgs(
      {},
      "test-protocol",
      "pool",
      "supply"
    );

    expect(result).toEqual({ ok: true, functionArgs: undefined });
  });

  it("JSON-stringifies object values", async () => {
    getProtocolMock.mockReturnValue(
      protocolWithSupplyInputs([{ name: "path" }])
    );

    const { buildProtocolFunctionArgs } = await import(
      "@/app/api/execute/_lib/protocol-function-args"
    );
    const result = buildProtocolFunctionArgs(
      { path: ["0xA", "0xB"] },
      "test-protocol",
      "pool",
      "supply"
    );

    expect(result).toEqual({
      ok: true,
      functionArgs: JSON.stringify([JSON.stringify(["0xA", "0xB"])]),
    });
  });
});

describe("POST /api/execute/{protocol}/{action} required params", () => {
  async function postSupply(body: Record<string, unknown>): Promise<Response> {
    const { POST } = await import("@/app/api/execute/[...slug]/route");
    const req = new Request("http://test/api/execute/test-protocol/supply", {
      method: "POST",
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        authorization: "Bearer x",
        "idempotency-key": "idem_required_params",
      },
    });
    return POST(req, {
      params: Promise.resolve({ slug: ["test-protocol", "supply"] }),
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    getProtocolMock.mockReturnValue(
      protocolWithSupplyInputs([
        { name: "asset" },
        { name: "amount" },
        { name: "referralCode", default: "0" },
      ])
    );
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
    recordIdempotentResponseMock.mockImplementation(
      (_outcome: unknown, response: Response, _disposition?: string) =>
        Promise.resolve(response)
    );
  });

  it("returns 400 and does not broadcast when a required field is missing", async () => {
    const response = await postSupply({
      chainId: 8453,
      asset: "0xToken",
    });
    const body = (await response.json()) as {
      success: boolean;
      error: string;
      field: string;
    };

    expect(response.status).toBe(400);
    expect(body).toEqual({
      success: false,
      error: "Missing required field: amount",
      field: "amount",
    });
    expect(writeContractCoreMock).not.toHaveBeenCalled();
    expect(recordIdempotentResponseMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(NextResponse),
      "release"
    );
  });

  it("returns 400 and does not broadcast when a required field is null", async () => {
    const response = await postSupply({
      chainId: 8453,
      asset: "0xToken",
      amount: null,
    });
    const body = (await response.json()) as {
      success: boolean;
      error: string;
      field: string;
    };

    expect(response.status).toBe(400);
    expect(body).toEqual({
      success: false,
      error: "Missing required field: amount",
      field: "amount",
    });
    expect(writeContractCoreMock).not.toHaveBeenCalled();
  });

  it("applies defaults and broadcasts when only optional fields are omitted", async () => {
    const response = await postSupply({
      chainId: 8453,
      asset: "0xToken",
      amount: "1000",
    });

    expect(response.status).toBe(202);
    expect(writeContractCoreMock).toHaveBeenCalledWith(
      expect.objectContaining({
        functionArgs: JSON.stringify(["0xToken", "1000", "0"]),
      })
    );
  });
});
