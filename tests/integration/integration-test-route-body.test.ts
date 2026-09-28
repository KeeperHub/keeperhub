/**
 * Integration tests for POST /api/integrations/[integrationId]/test
 *
 * The Test button sends no request body when the user changed nothing, while
 * the shared API client sets the JSON content type on every request. The route
 * must read that as "test what is stored" rather than rejecting it as
 * malformed input.
 *
 * Run with: pnpm vitest tests/integration/integration-test-route-body.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetIntegration, mockHandleDatabaseTest, mockHandlePluginTest } =
  vi.hoisted(() => ({
    mockGetIntegration: vi.fn(),
    mockHandleDatabaseTest: vi.fn(),
    mockHandlePluginTest: vi.fn(),
  }));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/db/integrations", () => ({
  getIntegration: mockGetIntegration,
}));

vi.mock("@/lib/db/test-connection", () => ({
  handleDatabaseTest: mockHandleDatabaseTest,
  handlePluginTest: mockHandlePluginTest,
}));

vi.mock("@/lib/middleware/auth-helpers", () => ({
  getDualAuthContext: vi.fn(() =>
    Promise.resolve({
      userId: "user-1",
      organizationId: "org-1",
      scope: undefined,
      authMethod: "session",
    })
  ),
}));

vi.mock("@/lib/middleware/require-scope", () => ({
  requireScope: vi.fn(() => null),
}));

import { POST } from "@/app/api/integrations/[integrationId]/test/route";

const STORED_DB_CONFIG = { connectionString: "postgres://stored/db" };
const STORED_DISCORD_CONFIG = {
  webhookUrl: "https://discord.com/api/webhooks/stored",
};

function post(
  body?: BodyInit,
  contentType = "application/json"
): Promise<Response> {
  const request = new Request("http://localhost/api/integrations/int-1/test", {
    method: "POST",
    headers: { "Content-Type": contentType },
    ...(body === undefined ? {} : { body }),
  });
  return POST(request, {
    params: Promise.resolve({ integrationId: "int-1" }),
  }) as Promise<Response>;
}

describe("POST /api/integrations/[integrationId]/test body parsing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetIntegration.mockResolvedValue({
      id: "int-1",
      type: "database",
      config: STORED_DB_CONFIG,
    });
    mockHandleDatabaseTest.mockResolvedValue({
      status: "success",
      message: "Connected",
    });
    mockHandlePluginTest.mockResolvedValue({
      status: "success",
      message: "Connected",
    });
  });

  it("tests the stored credential when a database sends no body", async () => {
    const response = await post();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "success",
      message: "Connected",
    });
    expect(mockHandleDatabaseTest).toHaveBeenCalledWith(STORED_DB_CONFIG);
  });

  it("tests the stored credential when a plugin sends no body", async () => {
    mockGetIntegration.mockResolvedValue({
      id: "int-1",
      type: "discord",
      config: STORED_DISCORD_CONFIG,
    });

    const response = await post();

    expect(response.status).toBe(200);
    expect(mockHandlePluginTest).toHaveBeenCalledWith(
      "discord",
      STORED_DISCORD_CONFIG
    );
  });

  it("treats a whitespace-only body as no body", async () => {
    const response = await post("   \n  ");

    expect(response.status).toBe(200);
    expect(mockHandleDatabaseTest).toHaveBeenCalledWith(STORED_DB_CONFIG);
  });

  it("still merges overrides over the stored config", async () => {
    mockGetIntegration.mockResolvedValue({
      id: "int-1",
      type: "database",
      config: { host: "stored-host", port: "5432" },
    });

    const response = await post(
      JSON.stringify({ configOverrides: { host: "typed-host" } })
    );

    expect(response.status).toBe(200);
    expect(mockHandleDatabaseTest).toHaveBeenCalledWith(
      expect.objectContaining({ host: "typed-host", port: "5432" })
    );
  });

  it("still drops keys the save is about to remove", async () => {
    mockGetIntegration.mockResolvedValue({
      id: "int-1",
      type: "database",
      config: { host: "stored-host", password: "stored-password" },
    });

    const response = await post(
      JSON.stringify({ clearedConfigKeys: ["password"] })
    );

    expect(response.status).toBe(200);
    const [testedConfig] = mockHandleDatabaseTest.mock.calls[0];
    expect(testedConfig).not.toHaveProperty("password");
  });

  it("rejects a malformed body", async () => {
    const response = await post("{not json");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid JSON in request body",
    });
    expect(mockHandleDatabaseTest).not.toHaveBeenCalled();
  });

  it.each([["null"], ["[1,2]"], ['"string"']])(
    "rejects a non-object body: %s",
    async (body) => {
      const response = await post(body);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "Invalid JSON in request body",
      });
      expect(mockHandleDatabaseTest).not.toHaveBeenCalled();
    }
  );

  it("ignores a body sent without the JSON content type", async () => {
    const response = await post("not json at all", "text/plain");

    expect(response.status).toBe(200);
    expect(mockHandleDatabaseTest).toHaveBeenCalledWith(STORED_DB_CONFIG);
  });
});
