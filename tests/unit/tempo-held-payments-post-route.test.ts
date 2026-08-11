import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockResolveCreatorContext = vi.fn();
const mockGetOrgRole = vi.fn();
const mockExecuteHoldPayment = vi.fn();

vi.mock("@/lib/middleware/auth-helpers", () => ({
  resolveCreatorContext: (...args: unknown[]) =>
    mockResolveCreatorContext(...args),
}));

vi.mock("@/lib/middleware/require-scope", () => ({
  requireScope: () => null,
}));

vi.mock("@/lib/security/org-role", () => ({
  getOrgRole: (...args: unknown[]) => mockGetOrgRole(...args),
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
}));

vi.mock("@/lib/security/audit-log", () => ({
  buildActor: () => ({}),
  buildAuditMetadata: () => ({}),
  recordAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { TRANSACTION: "transaction" },
  logSystemError: vi.fn(),
}));

vi.mock("@/plugins/tempo/steps/hold-payment-core", () => ({
  executeHoldPayment: (...args: unknown[]) => mockExecuteHoldPayment(...args),
}));

const { POST } = await import("@/app/api/tempo/held-payments/route");

function post(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new Request("http://localhost/api/tempo/held-payments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveCreatorContext.mockResolvedValue({
    organizationId: "org-1",
    userId: "user-1",
    authMethod: "oauth",
    apiKeyId: null,
    scope: "mcp:write",
  });
  mockGetOrgRole.mockResolvedValue("owner");
});

describe("POST /api/tempo/held-payments", () => {
  it("rejects empty-string required fields with 400", async () => {
    const res = await post({
      network: "tempo-testnet",
      tokenConfig: "",
      amount: "1",
      recipientAddress: "0x1111111111111111111111111111111111111111",
    });

    expect(res.status).toBe(400);
    expect(mockExecuteHoldPayment).not.toHaveBeenCalled();
  });

  it("rejects invalid tokenConfig shapes with 400", async () => {
    const res = await post({
      network: "tempo-testnet",
      tokenConfig: [],
      amount: "1",
      recipientAddress: "0x1111111111111111111111111111111111111111",
    });

    expect(res.status).toBe(400);
    expect(mockExecuteHoldPayment).not.toHaveBeenCalled();
  });

  it("returns 400 for validation failures from executeHoldPayment", async () => {
    mockExecuteHoldPayment.mockResolvedValue({
      success: false,
      error: "Unknown token NOTATOKEN",
      failureKind: "validation",
    });

    const res = await post({
      network: "tempo-testnet",
      tokenConfig: "NOTATOKEN",
      amount: "1",
      recipientAddress: "0x1111111111111111111111111111111111111111",
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("NOTATOKEN");
    expect(recordIdempotentResponseMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "proceed" }),
      expect.any(Response),
      "release"
    );
  });

  it("returns a generic 500 for infrastructure failures", async () => {
    mockExecuteHoldPayment.mockResolvedValue({
      success: false,
      error: "Turnkey signing failed: secret detail",
      failureKind: "infrastructure",
    });

    const res = await post({
      network: "tempo-testnet",
      tokenConfig: "usdc",
      amount: "1",
      recipientAddress: "0x1111111111111111111111111111111111111111",
    });

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Failed to create held payment");
    expect(body.error).not.toContain("Turnkey");
    expect(recordIdempotentResponseMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "proceed" }),
      expect.any(Response),
      "release"
    );
  });
});
