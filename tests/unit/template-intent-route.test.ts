import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory cookie store that mimics Next.js cookies() helper.
type StoredCookie = {
  name: string;
  value: string;
  path?: string;
  sameSite?: "lax" | "strict" | "none";
  httpOnly?: boolean;
  maxAge?: number;
};

const cookieStore = new Map<string, StoredCookie>();

const mockCookies = vi.fn(() =>
  Promise.resolve({
    get: (name: string) => cookieStore.get(name),
    set: (cookie: StoredCookie) => {
      // maxAge=0 effectively clears the cookie (browser semantics) — our
      // assertions read both .get() and the captured .set() arg, so we
      // keep the entry around with maxAge=0 for inspection.
      cookieStore.set(cookie.name, cookie);
    },
  })
);

vi.mock("next/headers", () => ({
  cookies: () => mockCookies(),
}));

// Import AFTER the mocks are registered.
import { GET, POST } from "@/app/api/auth/template-intent/route";

const COOKIE_NAME = "pending_template";

function buildPostRequest(body: unknown): Request {
  return new Request("http://localhost/api/auth/template-intent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("/api/auth/template-intent", () => {
  beforeEach(() => {
    cookieStore.clear();
    mockCookies.mockClear();
  });

  describe("POST", () => {
    it("sets pending_template cookie with HttpOnly + SameSite=Lax + Path=/ + Max-Age=600 when given a valid workflowId", async () => {
      const res = await POST(buildPostRequest({ workflowId: "wf_abc" }));

      expect(res.status).toBe(200);
      const cookie = cookieStore.get(COOKIE_NAME);
      expect(cookie).toBeDefined();
      expect(cookie?.value).toBe("wf_abc");
      expect(cookie?.path).toBe("/");
      expect(cookie?.sameSite).toBe("lax");
      expect(cookie?.httpOnly).toBe(true);
      expect(cookie?.maxAge).toBe(600);
    });

    it("returns 400 when workflowId is missing from body", async () => {
      const res = await POST(buildPostRequest({}));
      expect(res.status).toBe(400);
      expect(cookieStore.get(COOKIE_NAME)).toBeUndefined();
    });

    it("returns 400 when workflowId is not a string", async () => {
      const res = await POST(buildPostRequest({ workflowId: 42 }));
      expect(res.status).toBe(400);
      expect(cookieStore.get(COOKIE_NAME)).toBeUndefined();
    });

    it("returns 400 when workflowId is empty string", async () => {
      const res = await POST(buildPostRequest({ workflowId: "" }));
      expect(res.status).toBe(400);
      expect(cookieStore.get(COOKIE_NAME)).toBeUndefined();
    });

    it("returns 400 when workflowId exceeds 128 chars", async () => {
      const long = "x".repeat(129);
      const res = await POST(buildPostRequest({ workflowId: long }));
      expect(res.status).toBe(400);
      expect(cookieStore.get(COOKIE_NAME)).toBeUndefined();
    });

    it("returns 400 when body is not valid JSON", async () => {
      const res = await POST(buildPostRequest("{not-json"));
      expect(res.status).toBe(400);
    });
  });

  describe("GET", () => {
    it("returns null workflowId when no cookie present", async () => {
      const res = await GET();
      expect(res.status).toBe(200);
      const data = (await res.json()) as { workflowId: string | null };
      expect(data.workflowId).toBeNull();
    });

    it("returns the workflowId when cookie present, and clears it (Max-Age=0)", async () => {
      cookieStore.set(COOKIE_NAME, {
        name: COOKIE_NAME,
        value: "wf_xyz",
      });

      const res = await GET();
      expect(res.status).toBe(200);
      const data = (await res.json()) as { workflowId: string | null };
      expect(data.workflowId).toBe("wf_xyz");

      // The clear-write should have replaced the entry with maxAge=0 + value=""
      const cleared = cookieStore.get(COOKIE_NAME);
      expect(cleared?.value).toBe("");
      expect(cleared?.maxAge).toBe(0);
      expect(cleared?.httpOnly).toBe(true);
      expect(cleared?.sameSite).toBe("lax");
      expect(cleared?.path).toBe("/");
    });

    it("two consecutive GETs return id then null (atomic clear)", async () => {
      cookieStore.set(COOKIE_NAME, {
        name: COOKIE_NAME,
        value: "wf_first",
      });

      const first = await GET();
      const firstData = (await first.json()) as { workflowId: string | null };
      expect(firstData.workflowId).toBe("wf_first");

      // Simulate browser dropping the cookie after Max-Age=0 by removing it
      // from the store before the second call.
      cookieStore.delete(COOKIE_NAME);

      const second = await GET();
      const secondData = (await second.json()) as { workflowId: string | null };
      expect(secondData.workflowId).toBeNull();
    });
  });
});
