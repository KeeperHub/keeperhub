import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
// Policy has its own tests; here it must not stand between the request
// and the behaviour under test.
vi.mock("@/lib/policy/direct-execution", () => ({
  enforceDirectNodePolicy: async () => null,
  enforceDirectExecutionPolicy: async () => null,
}));

// Spy references for readContractCore and writeContractCore
const mockReadContractCore = vi.fn();
const mockWriteContractCore = vi.fn();

vi.mock("@/plugins/web3/steps/read-contract-core", () => ({
  readContractCore: (...args: unknown[]) => mockReadContractCore(...args),
}));

vi.mock("@/plugins/web3/steps/write-contract-core", () => ({
  writeContractCore: (...args: unknown[]) => mockWriteContractCore(...args),
}));

vi.mock("@/lib/abi/cache", () => ({
  resolveAbi: vi.fn().mockResolvedValue({ abi: "[]" }),
}));

vi.mock("@/lib/utils", async () =>
  (await import("../mocks/step-mocks")).utilsGetErrorMessage()
);

// Use @/ aliases so Vitest resolves the same module the route does
const mockValidateApiKey = vi.fn();
vi.mock("@/app/api/execute/_lib/auth", () => ({
  validateApiKey: (...args: unknown[]) => mockValidateApiKey(...args),
}));

const mockEvaluateCondition = vi.fn();
vi.mock("@/app/api/execute/_lib/condition", () => ({
  evaluateCondition: (...args: unknown[]) => mockEvaluateCondition(...args),
}));

const mockCompleteExecution = vi.fn();
const mockFailExecution = vi.fn();
const mockMarkRunning = vi.fn();
const mockRedactInput = vi.fn();
vi.mock("@/app/api/execute/_lib/execution-service", async (importActual) => {
  const actual =
    await importActual<
      typeof import("@/app/api/execute/_lib/execution-service")
    >();
  return {
    ...actual,
    completeExecution: (...args: unknown[]) => mockCompleteExecution(...args),
    failExecution: (...args: unknown[]) => mockFailExecution(...args),
    markRunning: (...args: unknown[]) => mockMarkRunning(...args),
    redactInput: (...args: unknown[]) => mockRedactInput(...args),
  };
});

const mockCheckRateLimit = vi.fn();
vi.mock("@/app/api/execute/_lib/rate-limit", () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

const mockCheckAndReserveExecution = vi.fn();
vi.mock("@/app/api/execute/_lib/spending-cap", () => ({
  checkAndReserveExecution: (...args: unknown[]) =>
    mockCheckAndReserveExecution(...args),
}));

vi.mock("@/app/api/execute/_lib/concurrency-limit", () => ({
  enforceDirectExecutionConcurrency: vi.fn().mockResolvedValue(null),
}));

const mockValidateCheckAndExecuteInput = vi.fn();
vi.mock("@/app/api/execute/_lib/validate", () => ({
  validateCheckAndExecuteInput: (...args: unknown[]) =>
    mockValidateCheckAndExecuteInput(...args),
}));

const mockRequireWallet = vi.fn();
vi.mock("@/app/api/execute/_lib/wallet-check", () => ({
  requireWallet: (...args: unknown[]) => mockRequireWallet(...args),
}));

vi.mock("@/lib/billing/execution-guard", () => ({
  enforceExecutionLimit: vi
    .fn()
    .mockResolvedValue({ blocked: false, limitResult: null }),
  EXECUTION_LIMIT_ERROR: "Monthly execution limit exceeded",
  EXECUTION_DEBT_ERROR:
    "Executions suspended due to unpaid overage invoice. Please update your payment method.",
}));

// Import SUT after all mocks
import { POST } from "@/app/api/execute/check-and-execute/route";

// Minimal ABI for the condition check contract (view function)
const CONDITION_ABI = JSON.stringify([
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
]);

function makeActionAbi(stateMutability: string): string {
  return JSON.stringify([
    {
      type: "function",
      name: "targetFunction",
      stateMutability,
      inputs: [],
      outputs: [{ name: "result", type: "uint256" }],
    },
  ]);
}

function createRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/execute/check-and-execute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeBody(actionStateMutability: string): Record<string, unknown> {
  return {
    network: "ethereum",
    contractAddress: "0x1234567890123456789012345678901234567890",
    functionName: "balanceOf",
    functionArgs: '["0x1234"]',
    abi: CONDITION_ABI,
    condition: {
      operator: "gt",
      value: "50",
    },
    action: {
      contractAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      functionName: "targetFunction",
      abi: makeActionAbi(actionStateMutability),
    },
  };
}

function setupDefaultMocks(): void {
  mockValidateApiKey.mockResolvedValue({
    organizationId: "org-1",
    apiKeyId: "key-1",
  });
  mockCheckRateLimit.mockReturnValue({ allowed: true });
  mockValidateCheckAndExecuteInput.mockReturnValue({ valid: true });
  mockEvaluateCondition.mockReturnValue({
    met: true,
    actual: "100",
    operator: "gt",
    expected: "50",
  });
  mockRequireWallet.mockResolvedValue(null);
  mockCheckAndReserveExecution.mockResolvedValue({
    allowed: true,
    executionId: "exec-1",
  });
  mockMarkRunning.mockResolvedValue(undefined);
  mockCompleteExecution.mockResolvedValue({ status: "completed" });
  mockFailExecution.mockResolvedValue(undefined);
  mockRedactInput.mockReturnValue({});

  // readContractCore success (condition check)
  mockReadContractCore.mockResolvedValue({
    success: true,
    result: "100",
    addressLink: "https://etherscan.io/address/0x1234",
  });

  // writeContractCore success (write action)
  mockWriteContractCore.mockResolvedValue({
    success: true,
    transactionHash: "0xhash",
    transactionLink: "https://etherscan.io/tx/0xhash",
    gasUsed: "21000",
    gasUsedUnits: "21000",
    effectiveGasPrice: "1000000000",
  });
}

describe("check-and-execute routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it("should route view function actions through readContractCore", async () => {
    const req = createRequest(makeBody("view"));
    await POST(req);

    // readContractCore called for the condition check and the view action
    expect(mockReadContractCore).toHaveBeenCalled();
    // writeContractCore must NOT be called for a view action
    expect(mockWriteContractCore).not.toHaveBeenCalled();
  });

  it("should route pure function actions through readContractCore", async () => {
    const req = createRequest(makeBody("pure"));
    await POST(req);

    expect(mockReadContractCore).toHaveBeenCalled();
    expect(mockWriteContractCore).not.toHaveBeenCalled();
  });

  it("should route nonpayable function actions through writeContractCore", async () => {
    const req = createRequest(makeBody("nonpayable"));
    await POST(req);

    // writeContractCore called for the write action
    expect(mockWriteContractCore).toHaveBeenCalled();
    // readContractCore called exactly once (the condition check only, not the action)
    expect(mockReadContractCore).toHaveBeenCalledTimes(1);
  });

  it("should return 400 when action function name is not found in ABI", async () => {
    const body = makeBody("nonpayable");
    // Set a function name that doesn't exist in the action ABI
    (body.action as Record<string, unknown>).functionName =
      "nonExistentFunction";
    const req = createRequest(body);
    const res = await POST(req);

    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; field: string };
    expect(json.error).toContain("nonExistentFunction");
    expect(json.field).toBe("action.functionName");
    expect(mockWriteContractCore).not.toHaveBeenCalled();
    expect(mockReadContractCore).toHaveBeenCalledTimes(1);
  });
});

// A dry run answers with one shape whatever it finds, so a caller cannot
// mistake an absent `success` for a failed simulation.
describe("check-and-execute dry-run response shape", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  type DryRun = {
    success?: boolean;
    status?: string;
    wouldRevert?: boolean;
    executed: boolean;
  };

  async function postJson(body: Record<string, unknown>): Promise<{
    status: number;
    json: DryRun;
  }> {
    const res = await POST(createRequest(body));
    return { status: res.status, json: (await res.json()) as DryRun };
  }

  it("reports success when the condition is not met", async () => {
    mockEvaluateCondition.mockReturnValue({
      met: false,
      actual: "10",
      operator: "gt",
      expected: "50",
    });

    const { status, json } = await postJson({
      ...makeBody("nonpayable"),
      simulate: true,
    });

    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.status).toBe("simulated");
    expect(json.executed).toBe(false);
    expect(mockWriteContractCore).not.toHaveBeenCalled();
  });

  it("claims nothing about reverting when no action was simulated", async () => {
    mockEvaluateCondition.mockReturnValue({
      met: false,
      actual: "10",
      operator: "gt",
      expected: "50",
    });

    const { json } = await postJson({
      ...makeBody("nonpayable"),
      simulate: true,
    });

    expect(json).not.toHaveProperty("wouldRevert");
  });

  it("reports success when the action is read-only", async () => {
    const { status, json } = await postJson({
      ...makeBody("view"),
      simulate: true,
    });

    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.status).toBe("simulated");
    expect(json.executed).toBe(true);
    expect(json).not.toHaveProperty("wouldRevert");
    expect(mockWriteContractCore).not.toHaveBeenCalled();
  });

  it("leaves the broadcast response untouched when the condition is not met", async () => {
    mockEvaluateCondition.mockReturnValue({
      met: false,
      actual: "10",
      operator: "gt",
      expected: "50",
    });

    const { status, json } = await postJson(makeBody("nonpayable"));

    expect(status).toBe(200);
    expect(json.executed).toBe(false);
    expect(json).not.toHaveProperty("success");
    expect(json).not.toHaveProperty("status");
    expect(json).not.toHaveProperty("wouldRevert");
  });

  it("leaves the broadcast response untouched for a read-only action", async () => {
    const { status, json } = await postJson(makeBody("view"));

    expect(status).toBe(200);
    expect(json.executed).toBe(true);
    expect(json).not.toHaveProperty("success");
    expect(json).not.toHaveProperty("status");
    expect(json).not.toHaveProperty("wouldRevert");
  });
});
