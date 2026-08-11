/**
 * Integration tests for POST /api/agentic-wallet/link.
 *
 * Full auth matrix (8 scenarios, >= 8 required by plan):
 *   1. HMAC + session + unlinked wallet -> 200 {ok:true}
 *   2. HMAC + session + already-linked-to-same-user -> 200 {ok:true, already:true}
 *   3. HMAC + session + already-linked-to-different-user -> 409 ALREADY_LINKED
 *   4. HMAC + session + wallet not found -> 404 WALLET_NOT_FOUND
 *   5. HMAC only, no session -> 401 MISSING_SESSION
 *   6. Session only, no HMAC -> 401 (HMAC verify fires first, "Missing HMAC headers")
 *   7. HMAC sub-org != body.subOrgId -> 403 SUB_ORG_MISMATCH (tight regex /sub-org mismatch/)
 *   8. Invalid JSON body -> 400 INVALID_JSON
 *
 * Strategy: mirror tests/integration/agentic-wallet-approval-lifecycle.test.ts
 * -- hoisted mocks for auth.api.getSession, lookupHmacSecret (which
 * verifyHmacRequest uses internally), and the db.update/db.select drizzle
 * chains used by the route. Real HMAC signing via buildHmacHeaders() ensures
 * the verifyHmacRequest path is exercised end-to-end.
 */
import { createHash, createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TEST_SECRET =
  "cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe";

const {
  mockLookupSecret,
  mockGetSession,
  mockDbUpdate,
  mockDbUpdateSet,
  mockDbUpdateWhere,
  mockDbUpdateReturning,
  mockDbSelectLimit,
} = vi.hoisted(() => {
  const updateReturning = vi.fn();
  const updateWhere = vi.fn(() => ({ returning: updateReturning }));
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const selectLimit = vi.fn();
  return {
    mockLookupSecret: vi.fn(),
    mockGetSession: vi.fn(),
    mockDbUpdate: vi.fn(() => ({ set: updateSet })),
    mockDbUpdateSet: updateSet,
    mockDbUpdateWhere: updateWhere,
    mockDbUpdateReturning: updateReturning,
    mockDbSelectLimit: selectLimit,
  };
});

vi.mock("@/lib/agentic-wallet/hmac-secret-store", () => ({
  lookupHmacSecret: mockLookupSecret,
  listActiveHmacSecrets: async (
    subOrgId: string
  ): Promise<{ secret: string; keyVersion: number }[]> => {
    const one = await mockLookupSecret(subOrgId, undefined);
    return one ? [one] : [];
  },
}));

vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: mockGetSession } },
}));

vi.mock("@/lib/db", () => ({
  db: {
    update: mockDbUpdate,
    select: (): {
      from: () => { where: () => { limit: typeof mockDbSelectLimit } };
    } => ({
      from: () => ({
        where: () => ({ limit: mockDbSelectLimit }),
      }),
    }),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  agenticWallets: {
    id: "id",
    subOrgId: "sub_org_id",
    linkedUserId: "linked_user_id",
    linkedAt: "linked_at",
  },
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "DATABASE" },
  logSystemError: vi.fn(),
}));

const { POST } = await import("@/app/api/agentic-wallet/link/route");

// ---------------------------------------------------------------------------
// HMAC helper: exact signing string shape from lib/agentic-wallet/hmac.ts.
//   signingString = `${method}\n${pathname}\n${sha256_hex(body)}\n${timestamp}`
//   signature     = hex(hmac_sha256(secret, signingString))
// ---------------------------------------------------------------------------

function buildHmacHeaders(
  subOrgId: string,
  body: string,
  secret: string = TEST_SECRET
): Record<string, string> {
  const path = "/api/agentic-wallet/link";
  const ts = Math.floor(Date.now() / 1000).toString();
  const digest = createHash("sha256").update(body).digest("hex");
  // REVIEW HI-05: subOrgId is bound into the signed string.
  const sig = createHmac("sha256", secret)
    .update(`POST\n${path}\n${subOrgId}\n${digest}\n${ts}`)
    .digest("hex");
  return {
    "Content-Type": "application/json",
    "X-KH-Sub-Org": subOrgId,
    "X-KH-Timestamp": ts,
    "X-KH-Signature": sig,
  };
}

function makeReq(headers: Record<string, string>, body: string): Request {
  return new Request("http://localhost:3000/api/agentic-wallet/link", {
    method: "POST",
    headers,
    body,
  });
}

beforeEach(() => {
  mockLookupSecret.mockReset();
  mockGetSession.mockReset();
  mockDbUpdate.mockClear();
  mockDbUpdateSet.mockClear();
  mockDbUpdateWhere.mockClear();
  mockDbUpdateReturning.mockReset();
  mockDbSelectLimit.mockReset();

  // Default: secret store returns TEST_SECRET for any known sub-org.
  mockLookupSecret.mockImplementation(async (subOrgId: string) => {
    if (subOrgId === "subOrg_A" || subOrgId === "subOrg_B") {
      return { secret: TEST_SECRET, keyVersion: 1 };
    }
    return null;
  });
  // Default session: user_test
  mockGetSession.mockResolvedValue({ user: { id: "user_test" } });
});

describe("POST /api/agentic-wallet/link", () => {
  it("links an unlinked wallet for HMAC+session caller (200 ok)", async () => {
    mockDbUpdateReturning.mockResolvedValue([{ id: "wallet_1" }]);
    const body = JSON.stringify({ subOrgId: "subOrg_A" });
    const res = await POST(makeReq(buildHmacHeaders("subOrg_A", body), body));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; already?: boolean };
    expect(json).toEqual({ ok: true });
    // Verify the DB update path was invoked exactly once, proving the handler
    // reached the linkedUserId/linkedAt write step.
    expect(mockDbUpdate).toHaveBeenCalledTimes(1);
    // The set() call carries the user id + linkedAt timestamp.
    const setCalls = mockDbUpdateSet.mock.calls as unknown as [
      { linkedUserId: string; linkedAt: Date },
    ][];
    expect(setCalls.length).toBeGreaterThan(0);
    const setArg = setCalls[0]?.[0];
    expect(setArg?.linkedUserId).toBe("user_test");
    expect(setArg?.linkedAt).toBeInstanceOf(Date);
  });

  it("returns 200 already:true when wallet is already linked to the same user (idempotent)", async () => {
    mockDbUpdateReturning.mockResolvedValue([]); // 0 rows updated
    mockDbSelectLimit.mockResolvedValue([{ linkedUserId: "user_test" }]);
    const body = JSON.stringify({ subOrgId: "subOrg_A" });
    const res = await POST(makeReq(buildHmacHeaders("subOrg_A", body), body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, already: true });
  });

  it("returns 409 ALREADY_LINKED when wallet is linked to a different user", async () => {
    mockDbUpdateReturning.mockResolvedValue([]);
    mockDbSelectLimit.mockResolvedValue([{ linkedUserId: "someone_else" }]);
    const body = JSON.stringify({ subOrgId: "subOrg_A" });
    const res = await POST(makeReq(buildHmacHeaders("subOrg_A", body), body));
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: string; code: string };
    expect(json.code).toBe("ALREADY_LINKED");
  });

  it("returns 404 WALLET_NOT_FOUND when wallet sub-org is completely missing", async () => {
    // The HMAC path will succeed (lookupHmacSecret returns the secret), but
    // after the 0-row update the re-read also returns empty.
    mockDbUpdateReturning.mockResolvedValue([]);
    mockDbSelectLimit.mockResolvedValue([]);
    const body = JSON.stringify({ subOrgId: "subOrg_A" });
    const res = await POST(makeReq(buildHmacHeaders("subOrg_A", body), body));
    expect(res.status).toBe(404);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe("WALLET_NOT_FOUND");
  });

  it("returns 401 MISSING_SESSION when session is missing (HMAC alone is not enough)", async () => {
    mockGetSession.mockResolvedValue(null);
    const body = JSON.stringify({ subOrgId: "subOrg_A" });
    const res = await POST(makeReq(buildHmacHeaders("subOrg_A", body), body));
    expect(res.status).toBe(401);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe("MISSING_SESSION");
    // The handler must NOT have reached the DB update step.
    expect(mockDbUpdate).not.toHaveBeenCalled();
  });

  it("returns 401 HMAC_INVALID when HMAC headers are missing (session alone is not enough)", async () => {
    const body = JSON.stringify({ subOrgId: "subOrg_A" });
    // No HMAC headers -> verifyHmacRequest returns {ok:false, error:"Missing HMAC headers"}
    const res = await POST(
      makeReq({ "Content-Type": "application/json" }, body)
    );
    expect(res.status).toBe(401);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe("HMAC_INVALID");
    expect(mockDbUpdate).not.toHaveBeenCalled();
  });

  it("returns 403 SUB_ORG_MISMATCH when HMAC sub-org does not match body.subOrgId", async () => {
    // Sign with subOrg_A's HMAC secret but put subOrg_B in the body.
    const body = JSON.stringify({ subOrgId: "subOrg_B" });
    const res = await POST(makeReq(buildHmacHeaders("subOrg_A", body), body));
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: string; code: string };
    // Tight regex per plan acceptance criterion WARNING 8.
    expect(json.error).toMatch(/sub-org mismatch/);
    expect(json.code).toBe("SUB_ORG_MISMATCH");
    expect(mockDbUpdate).not.toHaveBeenCalled();
  });

  it("returns 400 INVALID_JSON on unparseable body", async () => {
    const body = "not-json";
    const res = await POST(makeReq(buildHmacHeaders("subOrg_A", body), body));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe("INVALID_JSON");
    expect(mockDbUpdate).not.toHaveBeenCalled();
  });
});
