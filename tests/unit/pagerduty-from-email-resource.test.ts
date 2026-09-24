import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { safeFetch } = vi.hoisted(() => ({ safeFetch: vi.fn() }));
vi.mock("@/lib/safe-fetch", () => ({
  safeFetch,
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

const { mockGetIntegrationFromDb } = vi.hoisted(() => ({
  mockGetIntegrationFromDb: vi.fn(),
}));
vi.mock("@/lib/db/integrations", () => ({
  getIntegration: (...args: unknown[]) => mockGetIntegrationFromDb(...args),
}));

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/lib/middleware/auth-helpers", () => ({
  getDualAuthContext: (...args: unknown[]) => mockAuth(...args),
}));

const { mockRequireScope } = vi.hoisted(() => ({ mockRequireScope: vi.fn() }));
vi.mock("@/lib/middleware/require-scope", () => ({
  requireScope: (...args: unknown[]) => mockRequireScope(...args),
}));

const { mockCreatorDeactivated } = vi.hoisted(() => ({
  mockCreatorDeactivated: vi.fn(),
}));
vi.mock("@/lib/integrations/authorization", () => ({
  isIntegrationCreatorDeactivated: (...args: unknown[]) =>
    mockCreatorDeactivated(...args),
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { EXTERNAL_SERVICE: "external_service" },
  logUserError: vi.fn(),
}));

import { GET } from "@/app/api/integrations/[integrationId]/pagerduty/resources/route";

const params = Promise.resolve({ integrationId: "int-1" });

function get() {
  return GET(
    new Request(
      "https://app.keeperhub.com/api/integrations/int-1/pagerduty/resources?resource=from-email"
    ),
    { params }
  );
}

function connectionConfig(config: Record<string, unknown>) {
  mockGetIntegrationFromDb.mockResolvedValue({
    id: "int-1",
    type: "pagerduty",
    createdBy: "user-1",
    config,
  });
}

beforeEach(() => {
  safeFetch.mockReset();
  mockGetIntegrationFromDb.mockReset();
  mockAuth.mockReset();
  mockRequireScope.mockReset();
  mockCreatorDeactivated.mockReset();

  mockAuth.mockResolvedValue({
    userId: "user-1",
    organizationId: "org-1",
    scope: "mcp:read",
    authMethod: "session",
  });
  mockRequireScope.mockReturnValue(undefined);
  mockCreatorDeactivated.mockResolvedValue(false);
  connectionConfig({ apiToken: "tok", fromEmail: "oncall@acme.io" });
});

/**
 * Whether a Create Incident node has a From email to run with.
 *
 * The connection form marks the field optional because only this one action
 * reads it, so the editor cannot tell from the node alone whether the node
 * will fail. The address lives on the connection and never reaches the
 * browser, which is why the question is answered here rather than from config
 * the editor already holds.
 */
describe("GET pagerduty/resources?resource=from-email", () => {
  it("reports one that is set", async () => {
    const body = await (await get()).json();
    expect(body).toEqual({ hasFromEmail: true });
  });

  it("reports a missing one, which is what the warning hangs on", async () => {
    connectionConfig({ apiToken: "tok" });
    const body = await (await get()).json();
    expect(body).toEqual({ hasFromEmail: false });
  });

  /** Whitespace is not an address, and the step trims before checking too. */
  it("does not count a blank one as set", async () => {
    connectionConfig({ apiToken: "tok", fromEmail: "   " });
    const body = await (await get()).json();
    expect(body).toEqual({ hasFromEmail: false });
  });

  /**
   * The address itself is deliberately not in the response. The editor only
   * has to say whether the node can run; echoing a stored connection value
   * back to the browser is how the edit form got its own bug.
   */
  it("returns the answer and not the address", async () => {
    const body = await (await get()).json();
    expect(JSON.stringify(body)).not.toContain("oncall@acme.io");
  });

  /** No PagerDuty call: the question is about what KeeperHub stores. */
  it("does not call PagerDuty", async () => {
    await get();
    expect(safeFetch).not.toHaveBeenCalled();
  });

  /**
   * The freeze has to hold on every route that reads a connection directly,
   * not only the ones that page.
   */
  it("still refuses a deactivated creator's connection", async () => {
    mockCreatorDeactivated.mockResolvedValue(true);
    const response = await get();
    expect(response.status).toBe(403);
    expect(await response.json()).not.toHaveProperty("hasFromEmail");
  });

  it("refuses a connection that is not PagerDuty", async () => {
    mockGetIntegrationFromDb.mockResolvedValue({
      id: "int-1",
      type: "discord",
      createdBy: "user-1",
      config: {},
    });
    expect((await get()).status).toBe(400);
  });
});
