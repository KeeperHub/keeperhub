import { beforeEach, describe, expect, it, vi } from "vitest";

// Drives the REAL broadcast route handler with the auth stack stubbed. Org
// owners on OAuth/API-key may release without MFA; interactive sessions still
// clear step-up before releaseHeldPaymentNow.

vi.mock("server-only", () => ({}));

const {
  mockResolveCreatorContext,
  mockGetOrgRole,
  mockAuthorizeAction,
  mockGetHeldPaymentForOrg,
  mockReleaseHeldPaymentNow,
  mockGetSession,
} = vi.hoisted(() => ({
  mockResolveCreatorContext: vi.fn(),
  mockGetOrgRole: vi.fn(),
  mockAuthorizeAction: vi.fn(),
  mockGetHeldPaymentForOrg: vi.fn(),
  mockReleaseHeldPaymentNow: vi.fn(),
  mockGetSession: vi.fn(),
}));

vi.mock("@/lib/middleware/auth-helpers", () => ({
  resolveCreatorContext: mockResolveCreatorContext,
}));
vi.mock("@/lib/middleware/require-scope", () => ({
  requireScope: () => null,
}));
vi.mock("@/lib/security/org-role", () => ({
  getOrgRole: mockGetOrgRole,
}));
vi.mock("@/lib/middleware/authorize-action", () => ({
  authorizeAction: mockAuthorizeAction,
}));
vi.mock("@/lib/mfa/step-up-policy", () => ({
  STEP_UP_ACTIONS: {
    tempoHeldPaymentBroadcast: "tempo_held_payment_broadcast",
  },
}));
vi.mock("@/lib/tempo/held-payments", () => ({
  getHeldPaymentForOrg: mockGetHeldPaymentForOrg,
}));
vi.mock("@/lib/tempo/release-held-payment", () => ({
  releaseHeldPaymentNow: mockReleaseHeldPaymentNow,
}));
const beginIdempotentFromRequestMock = vi.fn().mockResolvedValue({
  kind: "proceed",
});
const recordIdempotentResponseMock = vi.fn(
  (_outcome: unknown, response: Response, _disposition?: string) =>
    Promise.resolve(response)
);

vi.mock("@/lib/idempotency", () => ({
  beginIdempotentFromRequest: (...args: unknown[]) =>
    beginIdempotentFromRequestMock(...args),
  idempotencyEarlyResponse: vi.fn().mockReturnValue(null),
  recordIdempotentResponse: (
    outcome: unknown,
    response: Response,
    disposition?: string
  ) => recordIdempotentResponseMock(outcome, response, disposition),
}));
vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: mockGetSession } },
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

const { POST } = await import(
  "@/app/api/tempo/held-payments/[id]/broadcast/route"
);

function post(body: Record<string, unknown> = {}): Promise<Response> {
  const request = new Request(
    "http://localhost/api/tempo/held-payments/hp-1/broadcast",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  return POST(request, { params: Promise.resolve({ id: "hp-1" }) });
}

const SESSION_OWNER = {
  authMethod: "session" as const,
  userId: "user-1",
  organizationId: "org-1",
  scope: "mcp:write",
  apiKeyId: undefined,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveCreatorContext.mockResolvedValue(SESSION_OWNER);
  mockGetOrgRole.mockResolvedValue("owner");
  mockGetHeldPaymentForOrg.mockResolvedValue({
    status: "pending",
    validBefore: 9_999_999_999,
  });
  mockGetSession.mockResolvedValue({
    user: { id: "user-1", email: "owner@example.com" },
  });
  mockAuthorizeAction.mockResolvedValue({ ok: true });
  mockReleaseHeldPaymentNow.mockResolvedValue({
    ok: true,
    transactionHash: "0xabc",
  });
});

describe("POST /api/tempo/held-payments/[id]/broadcast authorization", () => {
  it("allows an API-key / OAuth owner to release without step-up MFA", async () => {
    mockResolveCreatorContext.mockResolvedValue({
      ...SESSION_OWNER,
      authMethod: "api-key",
      apiKeyId: "key-1",
    });

    const res = await post();
    expect(res.status).toBe(200);
    expect(mockAuthorizeAction).not.toHaveBeenCalled();
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockReleaseHeldPaymentNow).toHaveBeenCalledWith({
      paymentId: "hp-1",
      organizationId: "org-1",
      userId: "user-1",
    });
  });

  it("rejects a non-owner org member with 403", async () => {
    mockGetOrgRole.mockResolvedValue("member");

    const res = await post();
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/owners/i);
    expect(mockAuthorizeAction).not.toHaveBeenCalled();
    expect(mockReleaseHeldPaymentNow).not.toHaveBeenCalled();
  });

  it("returns the step-up challenge and does not reserve idempotency when MFA is unsatisfied", async () => {
    mockAuthorizeAction.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "signature_required" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    });

    const res = await post();
    expect(res.status).toBe(401);
    expect(mockReleaseHeldPaymentNow).not.toHaveBeenCalled();
    expect(beginIdempotentFromRequestMock).not.toHaveBeenCalled();
  });

  it("fast-rejects a non-pending row before reaching step-up MFA", async () => {
    mockGetHeldPaymentForOrg.mockResolvedValue({
      status: "broadcasting",
      validBefore: 9_999_999_999,
    });

    const res = await post();
    expect(res.status).toBe(409);
    expect(mockAuthorizeAction).not.toHaveBeenCalled();
    expect(mockReleaseHeldPaymentNow).not.toHaveBeenCalled();
    expect(beginIdempotentFromRequestMock).not.toHaveBeenCalled();
  });

  it("releases the payment once owner + session + step-up all pass", async () => {
    const res = await post({ signature: "0xdeadbeef" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; transactionHash: string };
    expect(body).toMatchObject({
      ok: true,
      status: "confirmed",
      transactionHash: "0xabc",
    });
    expect(mockReleaseHeldPaymentNow).toHaveBeenCalledWith({
      paymentId: "hp-1",
      organizationId: "org-1",
      userId: "user-1",
    });
  });
});
