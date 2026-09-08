/**
 * Integration tests for POST /api/auth/signup-conflict.
 *
 * Run with: pnpm vitest tests/integration/signup-conflict-route.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { queue } = vi.hoisted(() => ({ queue: [] as unknown[][] }));

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => {
          const rows = queue.shift() ?? [];
          return Object.assign(Promise.resolve(rows), {
            limit: () => Promise.resolve(rows),
          });
        },
      }),
    }),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  users: { id: "id", email: "email" },
  accounts: { userId: "userId", providerId: "providerId" },
}));

vi.mock("drizzle-orm", () => ({
  eq: () => ({}),
}));

vi.mock("@/lib/security/login-risk", () => ({
  resolveClientIpFromHeaders: () => "127.0.0.1",
}));

import { __resetSignupConflictRateLimit } from "@/app/api/auth/_lib/signup-conflict-rate-limit";
import { POST } from "@/app/api/auth/signup-conflict/route";

type ConflictBody = {
  oauthOnly?: boolean;
  providers?: string[];
  error?: string;
  detail?: string;
};

function post(email: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/api/auth/signup-conflict", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    })
  );
}

describe("POST /api/auth/signup-conflict", () => {
  beforeEach(() => {
    queue.length = 0;
    __resetSignupConflictRateLimit();
  });

  it("reports the provider for an OAuth-only account", async () => {
    queue.push([{ id: "user-1" }], [{ providerId: "github" }]);

    const response = await post("oauth@example.com");
    expect(response.status).toBe(200);
    const body = (await response.json()) as ConflictBody;
    expect(body.oauthOnly).toBe(true);
    expect(body.providers).toEqual(["github"]);
  });

  it("deduplicates and keeps every linked OAuth provider", async () => {
    queue.push(
      [{ id: "user-1" }],
      [
        { providerId: "github" },
        { providerId: "google" },
        { providerId: "github" },
      ]
    );

    const response = await post("both@example.com");
    const body = (await response.json()) as ConflictBody;
    expect(body.oauthOnly).toBe(true);
    expect(body.providers).toEqual(["github", "google"]);
  });

  it("does not flag an account that has a credential password", async () => {
    queue.push(
      [{ id: "user-1" }],
      [{ providerId: "credential" }, { providerId: "github" }]
    );

    const response = await post("linked@example.com");
    const body = (await response.json()) as ConflictBody;
    expect(body.oauthOnly).toBe(false);
    expect(body.providers).toBeUndefined();
  });

  it("names only providers a signup form can route to", async () => {
    // Wallet (SIWE) accounts are MFA-exempt on a different axis and carry a
    // synthetic address, so there is nothing to send the user to here.
    queue.push([{ id: "user-1" }], [{ providerId: "siwe" }]);

    const response = await post("wallet@example.com");
    const body = (await response.json()) as ConflictBody;
    expect(body.oauthOnly).toBe(false);
  });

  it("answers identically for an unregistered address, so it is not an existence oracle", async () => {
    queue.push([]);
    const unknown = (await (
      await post("nobody@example.com")
    ).json()) as ConflictBody;

    queue.push([{ id: "user-1" }], [{ providerId: "credential" }]);
    const credential = (await (
      await post("known@example.com")
    ).json()) as ConflictBody;

    expect(unknown).toEqual(credential);
  });

  it("rejects a missing email", async () => {
    const response = await post(undefined);
    expect(response.status).toBe(400);
    const body = (await response.json()) as ConflictBody;
    expect(body.error).toBe("invalid_input");
  });

  it("rate limits repeated lookups for the same address", async () => {
    for (let i = 0; i < 5; i++) {
      queue.push([]);
      expect((await post("victim@example.com")).status).toBe(200);
    }

    const response = await post("victim@example.com");
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBeTruthy();
    const body = (await response.json()) as ConflictBody;
    expect(body.error).toBe("rate_limited");
  });
});
