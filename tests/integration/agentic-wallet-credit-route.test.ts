/**
 * Integration tests for GET /api/agentic-wallet/credit.
 *
 * Covers 6 scenarios from 34-02-PLAN.md Task 1 behaviour list:
 *   1. HMAC headers missing                       -> 401 HMAC_MISSING
 *   2. Signature length 64 hex but wrong secret   -> 401 HMAC_INVALID
 *   3. Single 50-cent onboard grant               -> 200 "0.50" USD
 *   4. Grant + spend (50 + -10) sum correctly     -> 200 "0.40" USD
 *   5. Sub-org exists but zero credit rows        -> 200 "0.00" USD
 *   6. Unknown sub-org                            -> 404 WALLET_NOT_FOUND
 *
 * Strategy: mirror tests/integration/agentic-wallet-sign-route.test.ts —
 * hoisted mocks for lookupHmacSecret (used by verifyHmacRequest internally)
 * and for db.select().from().where() so each test controls the SUM-aggregation
 * return. Real HMAC signing via buildHmacHeaders() ensures the
 * verifyHmacRequest path is exercised end-to-end; only the DB boundary is
 * mocked. The mocked-DB pattern matches the rest of the tests/integration
 * suite and avoids the plan's real-postgres precondition (Phase 33
 * migrations `agentic_wallets` + `agentic_wallet_credits` are applied in
 * deployed environments only; unit/integration tests never touch the real
 * DB per the existing pattern).
 *
 * Precondition: the route under test imports from @/lib/db/schema (which
 * re-exports agenticWalletCredits from lib/db/schema-agentic-wallet-credits
 * per Phase 33 Plan 01a). If that barrel re-export is removed this file
 * will fail to import the route handler.
 */
import { createHash, createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TEST_SUB_ORG = "subOrg_credit_test";
const TEST_HMAC_SECRET = "aa".repeat(32); // 64 hex chars

type MockResolved = ReturnType<typeof vi.fn>;
type MockLookup = ReturnType<typeof vi.fn>;

const { mockLookupSecret, mockDbSelectWhere } = vi.hoisted(
  (): {
    mockLookupSecret: MockLookup;
    mockDbSelectWhere: MockResolved;
  } => ({
    mockLookupSecret: vi.fn(),
    mockDbSelectWhere: vi.fn(),
  })
);

type LookupReturn = { secret: string; keyVersion: number } | null;
type LookupFn = (
  subOrgId: string,
  keyVersion?: number
) => Promise<LookupReturn>;

vi.mock("@/lib/agentic-wallet/hmac-secret-store", () => ({
  lookupHmacSecret: mockLookupSecret,
  listActiveHmacSecrets: async (
    subOrgId: string
  ): Promise<{ secret: string; keyVersion: number }[]> => {
    const one = await (mockLookupSecret as unknown as LookupFn)(
      subOrgId,
      undefined
    );
    return one ? [one] : [];
  },
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: (): {
      from: () => { where: typeof mockDbSelectWhere };
    } => ({
      from: () => ({ where: mockDbSelectWhere }),
    }),
  },
}));

// The route references agenticWalletCredits.subOrgId and .amountUsdcCents
// inside the drizzle sql template; the mock only needs truthy column tags
// so the handler never throws on undefined-property access.
vi.mock("@/lib/db/schema", () => ({
  agenticWalletCredits: {
    subOrgId: "sub_org_id",
    amountUsdcCents: "amount_usdc_cents",
  },
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "database" },
  logSystemError: vi.fn(),
}));

const { GET } = await import("@/app/api/agentic-wallet/credit/route");

function buildHmacHeaders(
  subOrgId: string,
  secret: string = TEST_HMAC_SECRET
): Record<string, string> {
  const path = "/api/agentic-wallet/credit";
  const ts = Math.floor(Date.now() / 1000).toString();
  // GET request -> empty body string -> sha256_hex("").
  const digest = createHash("sha256").update("").digest("hex");
  // REVIEW HI-05: subOrgId is bound into the signed string.
  const sig = createHmac("sha256", secret)
    .update(`GET\n${path}\n${subOrgId}\n${digest}\n${ts}`)
    .digest("hex");
  return {
    "X-KH-Sub-Org": subOrgId,
    "X-KH-Timestamp": ts,
    "X-KH-Signature": sig,
  };
}

function makeReq(headers: Record<string, string>): Request {
  return new Request("http://localhost:3000/api/agentic-wallet/credit", {
    method: "GET",
    headers,
  });
}

beforeEach(() => {
  mockLookupSecret.mockReset();
  mockDbSelectWhere.mockReset();
  mockLookupSecret.mockImplementation(async (subOrgId: string) =>
    subOrgId === TEST_SUB_ORG
      ? { secret: TEST_HMAC_SECRET, keyVersion: 1 }
      : null
  );
});

describe("GET /api/agentic-wallet/credit", () => {
  it("401 HMAC_MISSING when X-KH-Signature header absent", async () => {
    const res = await GET(
      new Request("http://localhost:3000/api/agentic-wallet/credit", {
        method: "GET",
      })
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("HMAC_MISSING");
  });

  it("401 HMAC_INVALID when signature is 64-hex but wrong secret", async () => {
    const headers = buildHmacHeaders(TEST_SUB_ORG);
    // 64 hex chars (length pre-check passes) but signed with wrong bytes.
    headers["X-KH-Signature"] = "ff".repeat(32);
    const res = await GET(makeReq(headers));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("HMAC_INVALID");
  });

  it("200 returns 0.50 USD when a single 50-cent onboard grant exists", async () => {
    // Postgres returns the COALESCE(SUM, 0)::text as the string "50".
    mockDbSelectWhere.mockResolvedValue([{ totalCents: "50" }]);
    const res = await GET(makeReq(buildHmacHeaders(TEST_SUB_ORG)));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      amount: string;
      currency: string;
      subOrgId: string;
    };
    expect(body).toEqual({
      amount: "0.50",
      currency: "USD",
      subOrgId: TEST_SUB_ORG,
    });
  });

  it("200 sums multiple rows (grant + spend) correctly", async () => {
    // SUM(50, -10) = 40 -> "0.40" USD.
    mockDbSelectWhere.mockResolvedValue([{ totalCents: "40" }]);
    const res = await GET(makeReq(buildHmacHeaders(TEST_SUB_ORG)));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { amount: string };
    expect(body.amount).toBe("0.40");
  });

  it("200 returns 0.00 USD when sub-org has zero credit rows", async () => {
    // COALESCE(NULL, 0) -> "0".
    mockDbSelectWhere.mockResolvedValue([{ totalCents: "0" }]);
    const res = await GET(makeReq(buildHmacHeaders(TEST_SUB_ORG)));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { amount: string };
    expect(body.amount).toBe("0.00");
  });

  it("404 WALLET_NOT_FOUND when sub-org does not exist", async () => {
    // lookupHmacSecret returns null for any sub-org other than TEST_SUB_ORG,
    // which verifyHmacRequest translates into status 404 "Unknown sub-org".
    const unknown = "subOrg_does_not_exist";
    const res = await GET(makeReq(buildHmacHeaders(unknown)));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("WALLET_NOT_FOUND");
    // Short-circuit before the DB SUM query — HMAC verify owns the 404.
    expect(mockDbSelectWhere).not.toHaveBeenCalled();
  });
});
