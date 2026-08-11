/**
 * Unit tests for FUNNEL-02 callbackURL address preservation.
 *
 * RED scaffold (Wave 0, Plan 54-01). All tests fail against the throw-stub;
 * they turn GREEN when the real implementation lands in Plan 54-02.
 *
 * FUNNEL-02 requires that after the OAuth round-trip the user lands on
 * `/scan?address=0x…` so the scan page repopulates the scanned address even
 * if the cookie has expired. The mechanism:
 *   1. The CTA sets the pending_scan cookie with the full intent (including
 *      the `address` field from the SuggestionDescriptor scan context).
 *   2. The GET route returns the intent so PendingScanRunner can reconstruct
 *      the callbackURL `/scan?address=${intent.address}`.
 *   3. The idempotency key uses `intent.id` (SuggestionDescriptor.id) —
 *      NOT a non-existent "suggestionSlug" field; using a missing field
 *      would collapse all suggestions into a single sessionStorage slot.
 *
 * Coverage:
 *   - POST round-trip: address is preserved in the stored cookie payload
 *   - GET returns address field for callbackURL construction
 *   - GET returns id field (not "suggestionSlug") for idempotency key
 *   - Distinct intents (different id values) produce distinct idempotency keys
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// ---------------------------------------------------------------------------
// In-memory cookie store — same helper as scan-intent-cookie.test.ts
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
      cookieStore.set(cookie.name, cookie);
    },
  })
);

vi.mock("next/headers", () => ({
  cookies: () => mockCookies(),
}));

import { GET, POST } from "@/app/api/auth/scan-intent/route";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const COOKIE_NAME = "pending_scan";

const KNOWN_ADDRESS = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

type ScanIntent = {
  id: string;
  address: string;
  name: string;
  description: string;
  category: string;
  chainId: number;
  readOrWrite: "read" | "write";
  confirmInputs: Record<string, string>;
  riskNote: string;
  mode: "run" | "schedule";
  protocol?: string;
  usdValue?: number | null;
};

const INTENT_A: ScanIntent = {
  id: "health-aave-v3-42161",
  address: KNOWN_ADDRESS,
  name: "Aave V3 Health Factor Alert",
  description: "Monitor HF on Arbitrum.",
  category: "health",
  chainId: 42_161,
  readOrWrite: "read",
  confirmInputs: { threshold: "1.5" },
  riskNote: "Read-only monitoring.",
  mode: "schedule",
};

const INTENT_B: ScanIntent = {
  id: "yield-lido-1",
  address: KNOWN_ADDRESS,
  name: "Lido Yield Monitor",
  description: "Track stETH rewards.",
  category: "yield",
  chainId: 1,
  readOrWrite: "read",
  confirmInputs: {},
  riskNote: "Read-only.",
  mode: "run",
};

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

describe("FUNNEL-02: scan intent address preservation for callbackURL", () => {
  beforeEach(() => {
    cookieStore.clear();
    mockCookies.mockClear();
  });

  it("POST stores the address field so GET can return it for callbackURL construction", async () => {
    const postRes = await POST(
      buildPostRequest({ intent: JSON.stringify(INTENT_A) })
    );
    expect(postRes.status).toBe(200);

    // Simulate the browser keeping the cookie, then GET reads it.
    const getRes = await GET();
    expect(getRes.status).toBe(200);
    const data = (await getRes.json()) as { intent: ScanIntent | null };

    expect(data.intent).not.toBeNull();
    expect(data.intent?.address).toBe(KNOWN_ADDRESS);
    // callbackURL for FUNNEL-02 would be: `/scan?address=${data.intent.address}`
    const callbackUrl = `/scan?address=${encodeURIComponent(data.intent?.address ?? "")}`;
    expect(callbackUrl).toBe(
      `/scan?address=${encodeURIComponent(KNOWN_ADDRESS)}`
    );
  });

  it("GET returns the intent.id field (SuggestionDescriptor.id) for idempotency key derivation", async () => {
    cookieStore.set(COOKIE_NAME, {
      name: COOKIE_NAME,
      value: JSON.stringify(INTENT_A),
    });

    const res = await GET();
    const data = (await res.json()) as { intent: ScanIntent | null };

    // The idempotency key must use intent.id (descriptor.id).
    // There is no "suggestionSlug" field on SuggestionDescriptor.
    expect(data.intent?.id).toBe("health-aave-v3-42161");
    // Verify the id is truthy and distinct — not undefined (which would
    // collapse all suggestions into the same sessionStorage slot).
    expect(typeof data.intent?.id).toBe("string");
    expect(data.intent?.id?.length).toBeGreaterThan(0);
  });

  it("two different suggestions produce distinct id values for separate idempotency slots", async () => {
    // First intent
    cookieStore.set(COOKIE_NAME, {
      name: COOKIE_NAME,
      value: JSON.stringify(INTENT_A),
    });
    const resA = await GET();
    const dataA = (await resA.json()) as { intent: ScanIntent | null };

    // Simulate cookie being re-set with a different suggestion.
    cookieStore.set(COOKIE_NAME, {
      name: COOKIE_NAME,
      value: JSON.stringify(INTENT_B),
    });
    const resB = await GET();
    const dataB = (await resB.json()) as { intent: ScanIntent | null };

    expect(dataA.intent?.id).toBe("health-aave-v3-42161");
    expect(dataB.intent?.id).toBe("yield-lido-1");
    // Distinct ids → distinct sessionStorage keys → no cross-suggestion collision.
    expect(dataA.intent?.id).not.toBe(dataB.intent?.id);
  });

  it("GET returns intent.mode so PendingScanRunner can choose run vs schedule path", async () => {
    cookieStore.set(COOKIE_NAME, {
      name: COOKIE_NAME,
      value: JSON.stringify(INTENT_A),
    });

    const res = await GET();
    const data = (await res.json()) as { intent: ScanIntent | null };

    expect(data.intent?.mode).toBe("schedule");
  });
});

// ---------------------------------------------------------------------------
// resolveCallbackUrl: same-origin open-redirect guard (Task 2, Plan 54-02)
// ---------------------------------------------------------------------------

import { resolveCallbackUrl } from "@/lib/auth/resolve-callback-url";

describe("resolveCallbackUrl: same-origin guard", () => {
  const FALLBACK = "/";

  it("returns a safe relative path as-is", () => {
    expect(resolveCallbackUrl("/scan?address=0xabc", FALLBACK)).toBe(
      "/scan?address=0xabc"
    );
  });

  it("returns a plain path as-is", () => {
    expect(resolveCallbackUrl("/workflows", FALLBACK)).toBe("/workflows");
  });

  it("rejects scheme-relative URL starting with // (open redirect)", () => {
    expect(resolveCallbackUrl("//evil.com", FALLBACK)).toBe(FALLBACK);
  });

  it("rejects absolute https URL (open redirect)", () => {
    expect(resolveCallbackUrl("https://evil.com", FALLBACK)).toBe(FALLBACK);
  });

  it("rejects absolute http URL (open redirect)", () => {
    expect(resolveCallbackUrl("http://evil.com", FALLBACK)).toBe(FALLBACK);
  });

  it("rejects backslash after leading slash (/\\\\evil.com)", () => {
    expect(resolveCallbackUrl("/\\evil.com", FALLBACK)).toBe(FALLBACK);
  });

  it("rejects bare backslash form (\\\\evil.com)", () => {
    expect(resolveCallbackUrl("\\evil.com", FALLBACK)).toBe(FALLBACK);
  });

  it("returns fallback when redirectTo is undefined", () => {
    expect(resolveCallbackUrl(undefined, FALLBACK)).toBe(FALLBACK);
  });

  it("returns fallback when redirectTo is an empty string", () => {
    expect(resolveCallbackUrl("", FALLBACK)).toBe(FALLBACK);
  });

  it("returns the custom fallback path when redirectTo is unsafe", () => {
    expect(resolveCallbackUrl("//evil.com", "/scan")).toBe("/scan");
  });

  // WR-02: percent-encoded bypass forms that some OAuth providers decode
  // before issuing the redirect (e.g. "/%2f%2fevil.com" → "//evil.com").

  it("rejects percent-encoded double-slash with leading slash (/%2f%2fevil.com) (WR-02)", () => {
    expect(resolveCallbackUrl("/%2f%2fevil.com", FALLBACK)).toBe(FALLBACK);
  });

  it("rejects percent-encoded double-slash uppercase (/%2F%2Fevil.com) (WR-02)", () => {
    expect(resolveCallbackUrl("/%2F%2Fevil.com", FALLBACK)).toBe(FALLBACK);
  });

  it("rejects percent-encoded backslash (/%5cevil.com) (WR-02)", () => {
    expect(resolveCallbackUrl("/%5cevil.com", FALLBACK)).toBe(FALLBACK);
  });

  it("rejects percent-encoded backslash uppercase (/%5Cevil.com) (WR-02)", () => {
    expect(resolveCallbackUrl("/%5Cevil.com", FALLBACK)).toBe(FALLBACK);
  });

  it("rejects leading whitespace before // (space before slashes) (WR-02)", () => {
    expect(resolveCallbackUrl(" //evil.com", FALLBACK)).toBe(FALLBACK);
  });

  it("rejects leading tab control character before path (WR-02)", () => {
    expect(resolveCallbackUrl("\tevil.com", FALLBACK)).toBe(FALLBACK);
  });

  it("still accepts a valid path containing literal percent-encoding for other chars (WR-02)", () => {
    const safe = `/scan?address=${encodeURIComponent("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045")}`;
    expect(resolveCallbackUrl(safe, FALLBACK)).toBe(safe);
  });
});
