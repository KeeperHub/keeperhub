/**
 * KEEP-828: the registration route rejects malformed metadata with a 400 from
 * the shared validator before storing a client, and still accepts a valid DCR
 * body carrying extra RFC 7591 fields.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockStoreOAuthClient } = vi.hoisted(() => ({
  mockStoreOAuthClient: vi.fn(async () => undefined),
}));

vi.mock("@/lib/mcp/oauth-store", () => ({
  storeOAuthClient: mockStoreOAuthClient,
}));

vi.mock("@/lib/mcp/rate-limit", () => ({
  checkIpRateLimit: () => ({ allowed: true, retryAfter: 0 }),
  getClientIp: () => "127.0.0.1",
}));

import { POST } from "@/app/api/oauth/register/route";

function buildRequest(body: unknown): Request {
  return new Request("http://localhost/api/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mockStoreOAuthClient.mockClear();
});

describe("POST /api/oauth/register input validation (KEEP-828)", () => {
  it("returns 400 and stores nothing when client_name is missing", async () => {
    const response = await POST(
      buildRequest({ redirect_uris: ["https://example.com/cb"] })
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Validation failed");
    expect(mockStoreOAuthClient).not.toHaveBeenCalled();
  });

  it("returns 400 when redirect_uris is empty", async () => {
    const response = await POST(
      buildRequest({ client_name: "App", redirect_uris: [] })
    );

    expect(response.status).toBe(400);
    expect(mockStoreOAuthClient).not.toHaveBeenCalled();
  });

  it("accepts a valid registration carrying extra RFC 7591 metadata", async () => {
    const response = await POST(
      buildRequest({
        client_name: "App",
        redirect_uris: ["https://example.com/cb"],
        logo_uri: "https://example.com/logo.png",
      })
    );

    expect(response.status).toBe(201);
    expect(mockStoreOAuthClient).toHaveBeenCalledTimes(1);
  });
});
