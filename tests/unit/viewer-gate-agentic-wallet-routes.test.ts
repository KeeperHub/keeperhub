import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Approving or rejecting a wallet request authorizes a signature, and a viewer
 * has read-only access. The proxy already refuses them, but it answers from a
 * short-lived cache and neither route carries a gated resolver, so each asks
 * again. What matters is that the refusal comes before the step-up check and
 * before anything resolves the request, so a demotion takes hold at once.
 */

const getSession = vi.fn();
const isViewerForRequest = vi.fn();
const authorizeAction = vi.fn();

vi.mock("@/lib/auth", () => ({ auth: { api: { getSession } } }));
vi.mock("@/lib/security/viewer-gate", () => ({ isViewerForRequest }));
vi.mock("@/lib/middleware/authorize-action", () => ({
  authorizeAction,
  STEP_UP_ACTIONS: {
    agenticWalletApprove: "agentic_wallet.approve",
    agenticWalletReject: "agentic_wallet.reject",
  },
}));
vi.mock("@/lib/security/audit-log", () => ({
  recordAuditEvent: vi.fn(),
  buildAuditMetadata: () => ({}),
}));
vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "DATABASE", UNKNOWN: "UNKNOWN" },
  logSystemError: vi.fn(),
  logSystemWarn: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

function request(path: string): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

const PARAMS = { params: Promise.resolve({ id: "req_1" }) };

describe("viewers on the agentic wallet approve and reject routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSession.mockResolvedValue({
      user: { id: "u1" },
      session: { activeOrganizationId: "org_1" },
    });
    isViewerForRequest.mockResolvedValue(true);
  });

  it("refuses a viewer approving a request", async () => {
    const { POST } = await import(
      "@/app/api/agentic-wallet/[id]/approve/route"
    );

    const response = await POST(request("/api/agentic-wallet/req_1/approve"), {
      ...PARAMS,
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "viewer_read_only",
    });
    // Before the step-up check, so the refusal costs the viewer no OTP.
    expect(authorizeAction).not.toHaveBeenCalled();
  });

  it("refuses a viewer rejecting a request", async () => {
    const { POST } = await import("@/app/api/agentic-wallet/[id]/reject/route");

    const response = await POST(request("/api/agentic-wallet/req_1/reject"), {
      ...PARAMS,
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "viewer_read_only",
    });
    expect(authorizeAction).not.toHaveBeenCalled();
  });

  it("asks about the acting user in their active organization", async () => {
    const { POST } = await import(
      "@/app/api/agentic-wallet/[id]/approve/route"
    );
    await POST(request("/api/agentic-wallet/req_1/approve"), { ...PARAMS });

    expect(isViewerForRequest).toHaveBeenCalledWith(
      expect.anything(),
      "u1",
      "org_1"
    );
  });

  it("lets a member through to the step-up check", async () => {
    isViewerForRequest.mockResolvedValue(false);
    authorizeAction.mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 401 }),
    });
    const { POST } = await import(
      "@/app/api/agentic-wallet/[id]/approve/route"
    );

    const response = await POST(request("/api/agentic-wallet/req_1/approve"), {
      ...PARAMS,
    });

    expect(authorizeAction).toHaveBeenCalled();
    expect(response.status).toBe(401);
  });
});
