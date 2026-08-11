/**
 * F-001: Open Dynamic Client Registration accepted arbitrary redirect_uri
 * schemes. POST /api/oauth/register must reject dangerous/custom schemes and
 * non-loopback http at registration (400) and must never persist them, while
 * still accepting the redirect shapes real MCP clients use (https any host,
 * http on loopback).
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

function buildRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mockStoreOAuthClient.mockClear();
});

describe("POST /api/oauth/register -- redirect_uri scheme allowlist (F-001)", () => {
  const dangerous = [
    "javascript:alert(1)",
    "data:text/html,x",
    "file:///etc/passwd",
    "intent://scan/#Intent;scheme=zxing;end",
    "http://evil.com/cb",
  ];

  for (const uri of dangerous) {
    it(`rejects ${uri} with 400 and does not persist the client`, async () => {
      const response = await POST(
        buildRequest({
          client_name: "Malicious Client",
          redirect_uris: [uri],
        })
      );

      expect(response.status).toBe(400);
      expect(mockStoreOAuthClient).not.toHaveBeenCalled();
    });
  }

  const accepted = [
    "https://example.com/callback",
    "http://localhost:8080/callback",
    "http://127.0.0.1:1234/cb",
    "http://[::1]:9000/cb",
  ];

  for (const uri of accepted) {
    it(`accepts ${uri} with 201`, async () => {
      const response = await POST(
        buildRequest({
          client_name: "Legitimate Client",
          redirect_uris: [uri],
        })
      );

      expect(response.status).toBe(201);
      expect(mockStoreOAuthClient).toHaveBeenCalledTimes(1);
    });
  }

  it("rejects the whole registration when any redirect_uri is dangerous", async () => {
    const response = await POST(
      buildRequest({
        client_name: "Mixed Client",
        redirect_uris: ["https://ok.com/cb", "javascript:alert(1)"],
      })
    );

    expect(response.status).toBe(400);
    expect(mockStoreOAuthClient).not.toHaveBeenCalled();
  });
});
