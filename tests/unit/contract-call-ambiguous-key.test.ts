/**
 * POST /api/execute/contract-call resolves the function key itself before it
 * decides between the read and write paths. A legacy key that two overloads
 * share has to be reported as ambiguous at that point: if the route's own
 * lookup collapses it to "not found", the message naming the signatures to
 * choose from, which the core steps emit, is never reached.
 *
 * Run with: pnpm vitest tests/unit/contract-call-ambiguous-key.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockValidateApiKey = vi.fn();
vi.mock("@/app/api/execute/_lib/auth", () => ({
  validateApiKey: (...args: unknown[]) => mockValidateApiKey(...args),
}));

const mockCheckRateLimit = vi.fn();
vi.mock("@/app/api/execute/_lib/rate-limit", () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

vi.mock("@/app/api/execute/_lib/concurrency-limit", () => ({
  enforceDirectExecutionConcurrency: vi.fn().mockResolvedValue(null),
}));

const mockValidateContractCallInput = vi.fn();
vi.mock("@/app/api/execute/_lib/validate", async (importActual) => {
  const actual =
    await importActual<typeof import("@/app/api/execute/_lib/validate")>();
  return {
    ...actual,
    validateContractCallInput: (...args: unknown[]) =>
      mockValidateContractCallInput(...args),
  };
});

vi.mock("@/lib/billing/execution-guard", () => ({
  enforceExecutionLimit: vi
    .fn()
    .mockResolvedValue({ blocked: false, limitResult: null }),
  EXECUTION_LIMIT_ERROR: "Monthly execution limit exceeded",
  EXECUTION_DEBT_ERROR: "Executions suspended due to unpaid overage invoice.",
}));

vi.mock("@/app/api/execute/_lib/wallet-check", () => ({
  requireWallet: vi.fn().mockResolvedValue(null),
}));

// Neither path may be reached: the ambiguity is a 400 before routing.
const mockReadContractCore = vi.fn();
vi.mock("@/plugins/web3/steps/read-contract-core", () => ({
  readContractCore: (...args: unknown[]) => mockReadContractCore(...args),
}));
const mockWriteContractCore = vi.fn();
vi.mock("@/plugins/web3/steps/write-contract-core", () => ({
  writeContractCore: (...args: unknown[]) => mockWriteContractCore(...args),
}));

const mockBeginIdempotentFromRequest = vi.fn();
vi.mock("@/lib/idempotency", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/idempotency")>();
  return {
    ...actual,
    beginIdempotentFromRequest: (...args: unknown[]) =>
      mockBeginIdempotentFromRequest(...args),
  };
});

import { POST } from "@/app/api/execute/contract-call/route";

const ADDRESS = "0x1234567890123456789012345678901234567890";

// Two overloads that differ only inside the struct, as Permit2's `permit`
// does. Their legacy raw spelling is identical.
const COLLIDING_ABI = JSON.stringify([
  {
    type: "function",
    name: "permit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "owner", type: "address" },
      {
        name: "single",
        type: "tuple",
        components: [
          { name: "token", type: "address" },
          { name: "amount", type: "uint160" },
        ],
      },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "permit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "owner", type: "address" },
      {
        name: "batch",
        type: "tuple",
        components: [
          { name: "spender", type: "address" },
          { name: "deadline", type: "uint256" },
        ],
      },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
]);

function post(functionName: string): Request {
  return new Request("http://localhost/api/execute/contract-call", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer kh_test",
    },
    body: JSON.stringify({
      chainId: "8453",
      contractAddress: ADDRESS,
      functionName,
      abi: COLLIDING_ABI,
      functionArgs: JSON.stringify([]),
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockValidateApiKey.mockResolvedValue({
    organizationId: "org-1",
    apiKeyId: "key-1",
  });
  mockCheckRateLimit.mockReturnValue({ allowed: true });
  mockValidateContractCallInput.mockReturnValue({ valid: true });
});

describe("contract-call with a legacy key two overloads share", () => {
  it.each(["permit", "permit(address,tuple,bytes)"])(
    "returns 400 naming the signatures for %s",
    async (key) => {
      const response = await (POST as (req: Request) => Promise<Response>)(
        post(key)
      );
      const body = (await response.json()) as { error: string; field?: string };

      expect(response.status).toBe(400);
      expect(body.field).toBe("functionName");
      expect(body.error).toContain("matches 2 overloads");
      expect(body.error).toContain("permit(address,(address,uint160),bytes)");
      expect(body.error).toContain("permit(address,(address,uint256),bytes)");
      expect(body.error).not.toContain("not found in ABI");
    }
  );

  it.each(["permit", "permit(address,tuple,bytes)"])(
    "never reaches execution for %s",
    async (key) => {
      await (POST as (req: Request) => Promise<Response>)(post(key));

      expect(mockReadContractCore).not.toHaveBeenCalled();
      expect(mockWriteContractCore).not.toHaveBeenCalled();
      expect(mockBeginIdempotentFromRequest).not.toHaveBeenCalled();
    }
  );

  it("still reports a genuinely missing function as not found", async () => {
    const response = await (POST as (req: Request) => Promise<Response>)(
      post("approve(address,uint256)")
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(body.error).toContain("not found in ABI");
  });
});
