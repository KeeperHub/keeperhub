/**
 * Unit tests for POST/GET /api/auth/scan-intent — FUNNEL-02 cookie behaviour.
 *
 * RED scaffold (Wave 0, Plan 54-01). All tests fail against the throw-stub;
 * they turn GREEN when the real implementation lands in Plan 54-02.
 *
 * Coverage:
 *   - POST sets a pending_scan HttpOnly cookie (sameSite=lax, maxAge=600, path=/)
 *   - POST validates: intent required, max 2048 chars, must be valid JSON
 *   - POST validates: body must be parseable JSON
 *   - GET returns the parsed intent and atomically clears the cookie (maxAge=0)
 *   - GET with no cookie returns { intent: null }
 *   - GET with malformed cookie value returns { intent: null } (graceful degradation)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// ---------------------------------------------------------------------------
// In-memory cookie store that mimics Next.js cookies() helper.
// ---------------------------------------------------------------------------

type StoredCookie = {
  name: string;
  value: string;
  path?: string;
  sameSite?: "lax" | "strict" | "none";
  httpOnly?: boolean;
  secure?: boolean;
  maxAge?: number;
};

const cookieStore = new Map<string, StoredCookie>();

const mockCookies = vi.fn(() =>
  Promise.resolve({
    get: (name: string) => cookieStore.get(name),
    set: (cookie: StoredCookie) => {
      // maxAge=0 clears in the browser; keep the entry for inspection.
      cookieStore.set(cookie.name, cookie);
    },
  })
);

vi.mock("next/headers", () => ({
  cookies: () => mockCookies(),
}));

// Import AFTER mocks are hoisted.
import { GET, POST } from "@/app/api/auth/scan-intent/route";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const COOKIE_NAME = "pending_scan";
const MAX_INTENT_LENGTH = 2048;

/**
 * Valid serialised intent payload.
 * The id field comes from SuggestionDescriptor.id (NOT a "suggestionSlug" field
 * — no such field exists on SuggestionDescriptor).
 */
const VALID_INTENT_JSON = JSON.stringify({
  id: "health-aave-v3-42161",
  address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  name: "Aave V3 Health Factor Alert",
  description: "Monitor HF on Arbitrum. Alert when HF drops below 1.5.",
  category: "health",
  chainId: 42_161,
  readOrWrite: "read",
  protocol: "aave-v3",
  usdValue: 5000,
  confirmInputs: { threshold: "1.5" },
  riskNote: "Read-only monitoring.",
  mode: "schedule",
});

function buildPostRequest(body: unknown): Request {
  return new Request("http://localhost/api/auth/scan-intent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("/api/auth/scan-intent", () => {
  beforeEach(() => {
    cookieStore.clear();
    mockCookies.mockClear();
  });

  describe("POST", () => {
    it("sets pending_scan cookie with httpOnly=true, sameSite=lax, path=/, maxAge=600 for a valid intent", async () => {
      const res = await POST(buildPostRequest({ intent: VALID_INTENT_JSON }));

      expect(res.status).toBe(200);
      const cookie = cookieStore.get(COOKIE_NAME);
      expect(cookie).toBeDefined();
      expect(cookie?.httpOnly).toBe(true);
      expect(cookie?.sameSite).toBe("lax");
      expect(cookie?.path).toBe("/");
      expect(cookie?.maxAge).toBe(600);
    });

    it("returns 400 when intent field is missing from body", async () => {
      const res = await POST(buildPostRequest({}));
      expect(res.status).toBe(400);
      expect(cookieStore.get(COOKIE_NAME)).toBeUndefined();
    });

    it(`returns 400 when intent exceeds the ${MAX_INTENT_LENGTH}-char cap`, async () => {
      const oversized = "x".repeat(MAX_INTENT_LENGTH + 1);
      const res = await POST(buildPostRequest({ intent: oversized }));
      expect(res.status).toBe(400);
      expect(cookieStore.get(COOKIE_NAME)).toBeUndefined();
    });

    it("returns 400 when intent is not valid JSON", async () => {
      const res = await POST(buildPostRequest({ intent: "{not-json" }));
      expect(res.status).toBe(400);
      expect(cookieStore.get(COOKIE_NAME)).toBeUndefined();
    });

    it("returns 400 when the request body itself is not parseable JSON", async () => {
      const res = await POST(buildPostRequest("{not-json"));
      expect(res.status).toBe(400);
    });

    it("sets secure=false in non-production environments (CR-01)", async () => {
      const res = await POST(buildPostRequest({ intent: VALID_INTENT_JSON }));
      expect(res.status).toBe(200);
      const cookie = cookieStore.get(COOKIE_NAME);
      // NODE_ENV is "test" in this environment — secure must be false.
      expect(cookie?.secure).toBe(false);
    });

    it("sets secure=true when NODE_ENV is production (CR-01)", async () => {
      vi.stubEnv("NODE_ENV", "production");
      cookieStore.clear();
      try {
        const res = await POST(buildPostRequest({ intent: VALID_INTENT_JSON }));
        expect(res.status).toBe(200);
        const cookie = cookieStore.get(COOKIE_NAME);
        expect(cookie?.secure).toBe(true);
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  describe("GET", () => {
    it("returns { intent: null } when no cookie is present", async () => {
      const res = await GET();
      expect(res.status).toBe(200);
      const data = (await res.json()) as { intent: unknown };
      expect(data.intent).toBeNull();
    });

    it("returns the parsed intent object and atomically clears the cookie (maxAge=0)", async () => {
      cookieStore.set(COOKIE_NAME, {
        name: COOKIE_NAME,
        value: VALID_INTENT_JSON,
      });

      const res = await GET();
      expect(res.status).toBe(200);
      const data = (await res.json()) as { intent: { id: string } | null };
      expect(data.intent).not.toBeNull();
      // The id field from SuggestionDescriptor.id — NOT a "suggestionSlug" field.
      expect(data.intent?.id).toBe("health-aave-v3-42161");

      const cleared = cookieStore.get(COOKIE_NAME);
      expect(cleared?.value).toBe("");
      expect(cleared?.maxAge).toBe(0);
      expect(cleared?.httpOnly).toBe(true);
      expect(cleared?.sameSite).toBe("lax");
      expect(cleared?.path).toBe("/");
    });

    it("returns { intent: null } when cookie value is malformed JSON (graceful degradation)", async () => {
      cookieStore.set(COOKIE_NAME, {
        name: COOKIE_NAME,
        value: "{bad-json",
      });

      const res = await GET();
      expect(res.status).toBe(200);
      const data = (await res.json()) as { intent: unknown };
      expect(data.intent).toBeNull();
    });
  });
});
