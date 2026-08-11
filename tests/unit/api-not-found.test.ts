/**
 * Catch-all 404 handler returns the canonical structured envelope.
 *
 * The envelope shape itself is exercised by api-error-envelope.test.ts;
 * this file pins the catch-all's contract: every body-bearing verb returns
 * a 404 with {error:"not_found", detail:"Route <METHOD> <path> not found",
 * request_id:<string>}, Content-Type: application/json, and
 * Cache-Control: no-store. HEAD is special-cased: same status and headers,
 * but no body (RFC 9110).
 *
 * Routing precedence (more specific routes win over [...slug]) is a
 * property of the Next.js App Router, not of this file; it is exercised
 * end-to-end by the live probe in deploy-keeperhub.yaml. The repo's
 * existing /api/auth/[...all] and /api/execute/[...slug] catch-alls live
 * at deeper segments and therefore take precedence by construction.
 */
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import {
  DELETE,
  GET,
  HEAD,
  OPTIONS,
  PATCH,
  POST,
  PUT,
} from "@/app/api/[...slug]/route";

function buildRequest(
  method: string,
  path: string,
  extraHeaders?: HeadersInit
) {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: extraHeaders,
  });
}

// HEAD is excluded here because it intentionally returns no body; it has
// its own test below.
const HANDLERS = {
  GET,
  POST,
  PUT,
  PATCH,
  DELETE,
  OPTIONS,
} as const;

describe("/api/[...slug] catch-all 404", () => {
  for (const [method, handler] of Object.entries(HANDLERS)) {
    it(`${method} unknown route returns structured not_found envelope`, async () => {
      const path = "/api/this-route-does-not-exist";
      const response = handler(buildRequest(method, path));
      expect(response.status).toBe(404);
      expect(response.headers.get("Content-Type")).toContain(
        "application/json"
      );
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("not_found");
      expect(body.detail).toBe(`Route ${method} ${path} not found`);
      expect(typeof body.request_id).toBe("string");
      expect((body.request_id as string).length).toBeGreaterThan(0);
    });
  }

  it("echoes inbound x-request-id so clients can correlate", async () => {
    const response = GET(
      buildRequest("GET", "/api/missing", {
        "x-request-id": "trace-abc-123",
      })
    );
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.request_id).toBe("trace-abc-123");
    expect(response.headers.get("x-request-id")).toBe("trace-abc-123");
  });

  it("HEAD returns a body-less 404 with the same status and cache headers", async () => {
    const path = "/api/this-route-does-not-exist";
    const response = HEAD(buildRequest("HEAD", path));
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(typeof response.headers.get("x-request-id")).toBe("string");
    const text = await response.text();
    expect(text).toBe("");
  });

  it("encodes the request method and path verbatim in detail", async () => {
    const response = POST(
      buildRequest("POST", "/api/me", { "content-type": "application/json" })
    );
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.detail).toBe("Route POST /api/me not found");
  });
});

// A base URL that already ends in /api produces /api/api/... . That is a
// configuration mistake with one cause, so it gets its own code rather than
// being indistinguishable from a wrong path.
describe("/api/[...slug] doubled prefix", () => {
  it("names the cause instead of returning a bare not_found", async () => {
    const response = GET(buildRequest("GET", "/api/api/chains"));
    expect(response.status).toBe(404);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("doubled_api_prefix");
    expect(body.detail).toContain("/api twice");
  });

  it("hints the corrected path with the duplicate segment removed", async () => {
    const response = GET(buildRequest("GET", "/api/api/chains"));
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.hint).toContain("/api/chains");
    expect(body.hint).not.toContain("/api/api/chains");
  });

  it("catches the bare doubled root", async () => {
    const response = GET(buildRequest("GET", "/api/api"));
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("doubled_api_prefix");
  });

  it("applies to every verb", async () => {
    for (const [method, handler] of Object.entries(HANDLERS)) {
      const response = handler(buildRequest(method, "/api/api/workflows"));
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("doubled_api_prefix");
    }
  });

  it("leaves a path that merely contains api elsewhere alone", async () => {
    const response = GET(buildRequest("GET", "/api/workflows/api/runs"));
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("not_found");
  });

  it("keeps the canonical envelope fields", async () => {
    const response = GET(
      buildRequest("GET", "/api/api/chains", { "x-request-id": "trace-dup-1" })
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.request_id).toBe("trace-dup-1");
  });
});
