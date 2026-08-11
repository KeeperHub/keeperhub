/**
 * The two idempotency 409s, asserted at the route rather than at the formatter.
 *
 * idempotency.test.ts covers `idempotencyEarlyResponse` directly, which proves
 * the body is shaped correctly but not that a route ships it. A route that
 * rebuilt the response itself, or dropped a field while adding headers, would
 * leave those tests green and still send a caller a 409 it cannot classify.
 *
 * So these go through the real handlers and read the responses they return.
 *
 * All three routes that build a 409 through the shared helper are driven, not
 * just one: they are separate call sites with separate gate sequences, and a
 * regression in any of them is invisible from the other two.
 *
 * Run with: pnpm vitest tests/unit/idempotency-409-route-body.test.ts
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

// Spread the real module: these routes also call validateTokenFields and the
// per-route field checks, and replacing the whole module wholesale removes them.
const mockValidateTransferInput = vi.fn();
const mockValidateContractCallInput = vi.fn();
const mockValidateCheckAndExecuteInput = vi.fn();
vi.mock("@/app/api/execute/_lib/validate", async (importActual) => {
  const actual =
    await importActual<typeof import("@/app/api/execute/_lib/validate")>();
  return {
    ...actual,
    validateTransferInput: (...args: unknown[]) =>
      mockValidateTransferInput(...args),
    validateContractCallInput: (...args: unknown[]) =>
      mockValidateContractCallInput(...args),
    validateCheckAndExecuteInput: (...args: unknown[]) =>
      mockValidateCheckAndExecuteInput(...args),
  };
});

vi.mock("@/lib/billing/execution-guard", () => ({
  enforceExecutionLimit: vi
    .fn()
    .mockResolvedValue({ blocked: false, limitResult: null }),
  EXECUTION_LIMIT_ERROR: "Monthly execution limit exceeded",
  EXECUTION_DEBT_ERROR: "Executions suspended due to unpaid overage invoice.",
}));

// The wallet lookup sits before the idempotency check and reaches the database;
// null means "configured", which lets the request get far enough to return the
// 409 under test.
vi.mock("@/app/api/execute/_lib/wallet-check", () => ({
  requireWallet: vi.fn().mockResolvedValue(null),
}));

// check-and-execute evaluates its condition on chain before reserving the key.
// The condition has to pass, or the route answers "condition not met" and never
// reaches the idempotency gate.
const mockReadContractCore = vi.fn();
vi.mock("@/plugins/web3/steps/read-contract-core", () => ({
  readContractCore: (...args: unknown[]) => mockReadContractCore(...args),
}));

// The outcome is what varies per case; the formatter under it stays real, so a
// change to either the formatter or a route surfaces here.
const mockBeginIdempotentFromRequest = vi.fn();
vi.mock("@/lib/idempotency", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/idempotency")>();
  return {
    ...actual,
    beginIdempotentFromRequest: (...args: unknown[]) =>
      mockBeginIdempotentFromRequest(...args),
  };
});

import { POST as checkAndExecutePOST } from "@/app/api/execute/check-and-execute/route";
import { POST as contractCallPOST } from "@/app/api/execute/contract-call/route";
// Import the routes after the mocks are registered.
import { POST as transferPOST } from "@/app/api/execute/transfer/route";

const ADDRESS = "0x1234567890123456789012345678901234567890";

/*
 * A write function, deliberately. Both contract routes short-circuit to a read
 * path when the target is `view` or `pure`, and that path never touches
 * idempotency -- so a `view` fixture here would make these tests pass without
 * ever reaching the code under test.
 */
const WRITE_ABI = JSON.stringify([
  {
    type: "function",
    name: "doWork",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
]);

type RouteCase = {
  name: string;
  post: (req: Request) => Promise<Response>;
  request: () => Request;
};

function post(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer kh_test",
      "Idempotency-Key": "same-key",
    },
    body: JSON.stringify(body),
  });
}

const ROUTES: RouteCase[] = [
  {
    name: "transfer",
    post: transferPOST as (req: Request) => Promise<Response>,
    request: () =>
      post("/api/execute/transfer", {
        chainId: "8453",
        recipientAddress: ADDRESS,
        amount: "0.1",
      }),
  },
  {
    name: "contract-call",
    post: contractCallPOST as (req: Request) => Promise<Response>,
    request: () =>
      post("/api/execute/contract-call", {
        chainId: "8453",
        contractAddress: ADDRESS,
        functionName: "doWork",
        abi: WRITE_ABI,
      }),
  },
  {
    name: "check-and-execute",
    post: checkAndExecutePOST as (req: Request) => Promise<Response>,
    request: () =>
      post("/api/execute/check-and-execute", {
        chainId: "8453",
        contractAddress: ADDRESS,
        functionName: "doWork",
        abi: WRITE_ABI,
        condition: { operator: "eq", value: "1" },
        action: {
          contractAddress: ADDRESS,
          functionName: "doWork",
          abi: WRITE_ABI,
        },
      }),
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockValidateApiKey.mockResolvedValue({
    organizationId: "org-1",
    apiKeyId: "key-1",
  });
  mockCheckRateLimit.mockReturnValue({ allowed: true });
  mockValidateTransferInput.mockReturnValue({ valid: true });
  mockValidateContractCallInput.mockReturnValue({ valid: true });
  mockValidateCheckAndExecuteInput.mockReturnValue({ valid: true });
  mockReadContractCore.mockResolvedValue({ success: true, result: "1" });
});

describe.each(ROUTES)("idempotency 409 bodies, as $name emits them", ({
  post: handler,
  request,
}) => {
  it("ships retryable true on an in-flight duplicate", async () => {
    mockBeginIdempotentFromRequest.mockResolvedValue({ kind: "in_progress" });

    const res = await handler(request());
    const body = (await res.json()) as { code?: string; retryable?: boolean };

    expect(res.status).toBe(409);
    expect(body.code).toBe("idempotency_in_progress");
    expect(body.retryable).toBe(true);
  });

  it("ships retryable false on a key reused with a different body", async () => {
    mockBeginIdempotentFromRequest.mockResolvedValue({
      kind: "conflict",
      originalResourceId: "exec_1",
    });

    const res = await handler(request());
    const body = (await res.json()) as {
      code?: string;
      retryable?: boolean;
      originalExecutionId?: string;
    };

    expect(res.status).toBe(409);
    expect(body.code).toBe("idempotency_conflict");
    expect(body.retryable).toBe(false);
    expect(body.originalExecutionId).toBe("exec_1");
  });

  // The status is identical on both, so a caller that reads only the status
  // cannot tell an in-flight request from a spent key. This is the assertion
  // the whole change exists for.
  it("gives the two the same status and opposite dispositions", async () => {
    mockBeginIdempotentFromRequest.mockResolvedValue({ kind: "in_progress" });
    const inFlight = await handler(request());
    const inFlightBody = (await inFlight.json()) as { retryable?: boolean };

    mockBeginIdempotentFromRequest.mockResolvedValue({
      kind: "conflict",
      originalResourceId: null,
    });
    const conflict = await handler(request());
    const conflictBody = (await conflict.json()) as { retryable?: boolean };

    expect(inFlight.status).toBe(conflict.status);
    expect(inFlightBody.retryable).toBe(true);
    expect(conflictBody.retryable).toBe(false);
  });
});
