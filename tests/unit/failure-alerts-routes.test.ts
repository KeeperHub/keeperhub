import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm/sql";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  requeueForEvaluation: vi.fn(),
  auth: vi.fn(),
  roleRows: [] as { role: string }[],
  joins: [] as unknown[],
  wheres: [] as unknown[],
  saveOrgSettings: vi.fn(async () => ({ rulesChanged: true })),
  pauseOrgAlerts: vi.fn(),
  resumeOrgAlerts: vi.fn(),
  sendTest: vi.fn(),
  saveWorkflowOverride: vi.fn(),
  loadWorkflowForAlerts: vi.fn(),
  loadHistory: vi.fn(),
  recordAuditEvent: vi.fn(),
}));

vi.mock("@/lib/middleware/auth-helpers", () => ({
  getDualAuthContext: (...args: unknown[]) => mocks.auth(...args),
}));

// The member-role lookup: select().from(member).innerJoin(organization).where().limit().
vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn((table: unknown) => {
          mocks.joins.push(table);
          return {
            where: vi.fn((where: unknown) => {
              mocks.wheres.push(where);
              return { limit: vi.fn(async () => mocks.roleRows) };
            }),
          };
        }),
        where: vi.fn(() => ({ limit: vi.fn(async () => []) })),
      })),
    })),
  },
}));

vi.mock("@/lib/notifications/failure-alerts/settings", () => ({
  CHANNEL_KINDS: ["slack", "discord", "telegram", "pagerduty"],
  SettingsError: class SettingsError extends Error {
    status = 400;
  },
  loadOrgSettingsView: vi.fn(async () => ({ enabled: true })),
  parseOrgSettings: vi.fn(async () => ({ channels: [] })),
  saveOrgSettings: mocks.saveOrgSettings,
  requeueForEvaluation: mocks.requeueForEvaluation,
  loadHistory: mocks.loadHistory,
  historyToCsv: vi.fn(() => ""),
}));

vi.mock("@/lib/notifications/failure-alerts/org-pause", () => ({
  pauseOrgAlerts: mocks.pauseOrgAlerts,
  resumeOrgAlerts: mocks.resumeOrgAlerts,
}));

vi.mock("@/lib/notifications/failure-alerts/test-send", () => ({
  sendTest: mocks.sendTest,
}));

vi.mock("@/lib/notifications/failure-alerts/workflow-settings", () => ({
  loadWorkflowForAlerts: mocks.loadWorkflowForAlerts,
  loadWorkflowAlertView: vi.fn(async () => ({})),
  saveWorkflowOverride: mocks.saveWorkflowOverride,
}));

vi.mock("@/lib/notifications/failure-alerts/messages", () => ({
  appBaseUrl: () => "http://localhost:3000",
  renderSample: () => ({ subject: "", html: "", chat: "", summary: "" }),
  pauseActorName: () => null,
  nameOf: () => null,
}));

vi.mock("@/lib/notifications/org-recipients", () => ({
  loadOrgMembers: vi.fn(async () => []),
}));

vi.mock("@/lib/security/audit-log", () => ({
  recordAuditEvent: mocks.recordAuditEvent,
  buildAuditMetadata: () => ({}),
}));

const orgRoute = await import(
  "@/app/api/organizations/[organizationId]/failure-alerts/route"
);
const pauseRoute = await import(
  "@/app/api/organizations/[organizationId]/failure-alerts/pause/route"
);
const testRoute = await import(
  "@/app/api/organizations/[organizationId]/failure-alerts/test/route"
);
const historyRoute = await import(
  "@/app/api/organizations/[organizationId]/failure-alerts/history/route"
);
const previewRoute = await import(
  "@/app/api/organizations/[organizationId]/failure-alerts/preview/route"
);
const workflowRoute = await import(
  "@/app/api/workflows/[workflowId]/failure-alerts/route"
);

const ORG = "org_a";
const OTHER_ORG = "org_b";

type Call = () => Promise<Response>;

function req(method: string, body?: unknown): Request {
  return new Request("http://localhost/api/x", {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const orgCtx = (organizationId = ORG) => ({
  params: Promise.resolve({ organizationId }),
});
const wfCtx = { params: Promise.resolve({ workflowId: "wf_1" }) };

const TEST_BODY = {
  channel: "pagerduty",
  integrationId: "int_1",
  destination: "",
  pagerDutyMode: "page",
};

const writes: Record<string, (org?: string) => Call> = {
  "PUT settings": (org) => () =>
    orgRoute.PUT(req("PUT", { threshold: 3 }), orgCtx(org)),
  "PUT pause": (org) => () =>
    pauseRoute.PUT(req("PUT", { until: "2099-01-01T00:00:00Z" }), orgCtx(org)),
  "DELETE pause": (org) => () => pauseRoute.DELETE(req("DELETE"), orgCtx(org)),
  "POST test": (org) => () =>
    testRoute.POST(req("POST", TEST_BODY), orgCtx(org)),
  "PUT workflow": () => () =>
    workflowRoute.PUT(req("PUT", { mode: "custom" }), wfCtx),
};

const reads: Record<string, (org?: string) => Call> = {
  "GET settings": (org) => () => orgRoute.GET(req("GET"), orgCtx(org)),
  "GET history": (org) => () => historyRoute.GET(req("GET"), orgCtx(org)),
  "GET preview": (org) => () => previewRoute.GET(req("GET"), orgCtx(org)),
  "GET workflow": () => () => workflowRoute.GET(req("GET"), wfCtx),
};

const all = { ...writes, ...reads };

function signedIn(overrides: Record<string, unknown> = {}): void {
  mocks.auth.mockResolvedValue({
    userId: "user_1",
    organizationId: ORG,
    authMethod: "session",
    apiKeyId: null,
    isAnonymous: false,
    ...overrides,
  });
}

function expectNoSideEffects(): void {
  expect(mocks.saveOrgSettings).not.toHaveBeenCalled();
  expect(mocks.pauseOrgAlerts).not.toHaveBeenCalled();
  expect(mocks.resumeOrgAlerts).not.toHaveBeenCalled();
  expect(mocks.sendTest).not.toHaveBeenCalled();
  expect(mocks.saveWorkflowOverride).not.toHaveBeenCalled();
  expect(mocks.recordAuditEvent).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("FAILURE_ALERTS_ROLLOUT", "all");
  mocks.roleRows = [{ role: "owner" }];
  mocks.joins.length = 0;
  mocks.wheres.length = 0;
  mocks.loadWorkflowForAlerts.mockResolvedValue({
    id: "wf_1",
    organizationId: ORG,
  });
  mocks.loadHistory.mockResolvedValue({ entries: [], nextCursor: null });
  mocks.sendTest.mockResolvedValue({ delivered: true });
  mocks.saveWorkflowOverride.mockResolvedValue({ rulesChanged: true });
  mocks.pauseOrgAlerts.mockResolvedValue({
    until: new Date("2099-01-01T00:00:00Z"),
    reason: null,
  });
  signedIn();
});

describe("failure-alerts routes: rollout", () => {
  it.each(Object.entries(all))(
    "%s answers 404 when the rollout is off",
    async (_name, call) => {
      vi.stubEnv("FAILURE_ALERTS_ROLLOUT", "off");
      const res = await call()();
      expect(res.status).toBe(404);
      expectNoSideEffects();
    }
  );

  it.each(Object.entries(all))(
    "%s answers 404 when the org is not on the rollout list",
    async (_name, call) => {
      vi.stubEnv("FAILURE_ALERTS_ROLLOUT", `orgs:${OTHER_ORG}`);
      const res = await call()();
      expect(res.status).toBe(404);
      expectNoSideEffects();
    }
  );

  it.each(Object.entries(all))(
    "%s works for an org on the rollout",
    async (_name, call) => {
      vi.stubEnv("FAILURE_ALERTS_ROLLOUT", `orgs:${ORG}`);
      const res = await call()();
      expect(res.status).toBe(200);
    }
  );
});

describe("failure-alerts routes: who may call", () => {
  it.each(Object.entries(writes))(
    "%s refuses a plain member with 403",
    async (_name, call) => {
      mocks.roleRows = [{ role: "member" }];
      const res = await call()();
      expect(res.status).toBe(403);
      expectNoSideEffects();
    }
  );

  it.each(Object.entries(writes))(
    "%s lets an admin change it, like an owner",
    async (_name, call) => {
      mocks.roleRows = [{ role: "admin" }];
      const res = await call()();
      expect(res.status).toBe(200);
    }
  );

  it.each(Object.entries(reads))(
    "%s lets a plain member read",
    async (_name, call) => {
      mocks.roleRows = [{ role: "member" }];
      const res = await call()();
      expect(res.status).toBe(200);
    }
  );

  it.each(Object.entries(all).filter(([name]) => !name.includes("workflow")))(
    "%s refuses an API key bound to a different org",
    async (_name, call) => {
      signedIn({
        authMethod: "api-key",
        apiKeyId: "key_1",
        organizationId: ORG,
      });
      const res = await call(OTHER_ORG)();
      expect(res.status).toBe(403);
      // Refused before any membership lookup.
      expect(mocks.wheres).toHaveLength(0);
      expectNoSideEffects();
    }
  );

  it.each(Object.entries(writes))(
    "%s refuses an OAuth mcp:read token",
    async (_name, call) => {
      signedIn({ authMethod: "oauth", scope: "mcp:read" });
      const res = await call()();
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "insufficient_scope" });
      expectNoSideEffects();
    }
  );

  it("refuses a caller who is not a member, or whose org is deactivated", async () => {
    mocks.roleRows = [];
    const res = await orgRoute.GET(req("GET"), orgCtx());
    expect(res.status).toBe(403);
  });

  it("only counts membership of an org that is not deactivated", async () => {
    await orgRoute.GET(req("GET"), orgCtx());
    const { organization } = await import("@/lib/db/schema");
    expect(mocks.joins).toEqual([organization]);
    const { sql } = new PgDialect().sqlToQuery(mocks.wheres[0] as SQL);
    expect(sql).toContain('"organization"."deactivated_at" is null');
  });
});

describe("failure-alerts routes: workflow from another org", () => {
  beforeEach(() => {
    mocks.loadWorkflowForAlerts.mockResolvedValue({
      id: "wf_1",
      organizationId: OTHER_ORG,
    });
  });

  it.each([
    ["GET", () => workflowRoute.GET(req("GET"), wfCtx)],
    ["PUT", () => workflowRoute.PUT(req("PUT", { mode: "custom" }), wfCtx)],
  ])("%s answers 404 to an API key from another org", async (_m, call) => {
    signedIn({ authMethod: "api-key", apiKeyId: "key_1" });
    const res = await call();
    expect(res.status).toBe(404);
    expectNoSideEffects();
  });

  it.each([
    ["GET", () => workflowRoute.GET(req("GET"), wfCtx)],
    ["PUT", () => workflowRoute.PUT(req("PUT", { mode: "custom" }), wfCtx)],
  ])("%s answers 404 to a session user outside that org", async (_m, call) => {
    mocks.roleRows = [];
    const res = await call();
    expect(res.status).toBe(404);
    expectNoSideEffects();
  });

  it("answers 404 for an unknown workflow id", async () => {
    mocks.loadWorkflowForAlerts.mockResolvedValue(null);
    const res = await workflowRoute.GET(req("GET"), wfCtx);
    expect(res.status).toBe(404);
  });
});

describe("PUT pause audit", () => {
  it("audits the parsed until and reason, not the raw body", async () => {
    const until = new Date("2099-01-01T00:00:00Z");
    mocks.pauseOrgAlerts.mockResolvedValue({ until, reason: "Maintenance" });
    const res = await pauseRoute.PUT(
      req("PUT", {
        until: "2099-01-01T00:00:00+00:00",
        reason: `   Maintenance   ${"x".repeat(5000)}`,
        extra: { nested: true },
      }),
      orgCtx()
    );
    expect(res.status).toBe(200);
    expect(mocks.recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "org.failure_alerts_paused",
        after: { until: until.toISOString(), reason: "Maintenance" },
      })
    );
  });
});

describe("re-queue only when the rules change", () => {
  it.each([true, false])(
    "org save with rulesChanged %s",
    async (rulesChanged) => {
      mocks.saveOrgSettings.mockResolvedValueOnce({ rulesChanged });
      const res = await orgRoute.PUT(req("PUT", { threshold: 3 }), orgCtx());
      expect(res.status).toBe(200);
      expect(mocks.requeueForEvaluation).toHaveBeenCalledTimes(
        rulesChanged ? 1 : 0
      );
    }
  );

  it.each([true, false])(
    "workflow save with rulesChanged %s",
    async (rulesChanged) => {
      mocks.saveWorkflowOverride.mockResolvedValueOnce({ rulesChanged });
      const res = await workflowRoute.PUT(
        req("PUT", { mode: "custom" }),
        wfCtx
      );
      expect(res.status).toBe(200);
      expect(mocks.requeueForEvaluation).toHaveBeenCalledTimes(
        rulesChanged ? 1 : 0
      );
    }
  );
});

describe("GET history page", () => {
  it.each(["0", "1.5", "1e300", "100001"])(
    "refuses page=%s without querying",
    async (page) => {
      const res = await historyRoute.GET(
        new Request(`http://localhost/api/x?page=${page}`),
        orgCtx()
      );
      expect(res.status).toBe(400);
      expect(mocks.loadHistory).not.toHaveBeenCalled();
    }
  );

  it("accepts the last allowed page", async () => {
    const res = await historyRoute.GET(
      new Request("http://localhost/api/x?page=100000"),
      orgCtx()
    );
    expect(res.status).toBe(200);
  });
});
