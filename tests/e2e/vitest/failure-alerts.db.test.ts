import "dotenv/config";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq, isNull, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EXECUTION_LIMIT_REFUSAL } from "../../../lib/billing/dispatch-refusal";
import {
  failureAlertChannels,
  failureAlertDeliveries,
  integrations,
  member,
  organization,
  orgFailureAlertSettings,
  securityAuditLog,
  users,
  workflowExecutions,
  workflowFailureAlertOverrides,
  workflowFailureAlertQueue,
  workflowFailureIncidents,
  workflowSchedules,
  workflows,
} from "../../../lib/db/schema";
import { parseHistoryCursor } from "../../../lib/notifications/failure-alerts/history-entry";
import { SKIP_REASON } from "../../../lib/notifications/failure-alerts/stored-reasons";

// vitest runs in Node, not an SSR context.
vi.mock("server-only", () => ({}));

// tests/setup.ts stubs @/lib/db; the cycle must read and write Postgres.
vi.unmock("@/lib/db");

// Discord, Telegram, Slack and PagerDuty answer from here, so CI never reaches the internet.
const providers = vi.hoisted(() => {
  type Call = { url: string; method: string; body: string };
  const calls: Call[] = [];
  const DEAD = "fa-dead";
  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  function answer(url: URL, method: string, marker: string): Response {
    const dead = marker.includes(DEAD);
    switch (url.hostname) {
      case "discord.com":
        if (dead) {
          return json(404, { message: "Unknown Webhook", code: 10_015 });
        }
        return method === "GET"
          ? json(200, { id: "1", type: 1 })
          : new Response(null, { status: 204 });
      case "api.telegram.org":
        return dead
          ? json(401, {
              ok: false,
              error_code: 401,
              description: "Unauthorized",
            })
          : json(200, { ok: true, result: { id: -1001, type: "group" } });
      case "slack.com":
        return json(
          200,
          dead ? { ok: false, error: "invalid_auth" } : { ok: true }
        );
      case "api.pagerduty.com": {
        if (dead) {
          return json(401, { error: { message: "Unauthorized", code: 2006 } });
        }
        const serviceId = decodeURIComponent(url.pathname.split("/")[2] ?? "");
        if (url.pathname.includes("/integrations/")) {
          return json(200, {
            integration: { id: "PFAINT1", integration_key: "fa-live-routing" },
          });
        }
        return json(200, {
          service: {
            id: serviceId,
            name: "Fake service",
            status: "active",
            html_url: `https://fa.pagerduty.com/service-directory/${serviceId}`,
            integrations: [
              { id: "PFAINT1", type: "events_api_v2_inbound_integration" },
            ],
          },
        });
      }
      case "events.pagerduty.com":
        return json(202, { status: "success", message: "Event processed" });
      default:
        throw new TypeError(`fetch failed: ${url.hostname} is not stubbed`);
    }
  }

  function safeFetch(
    input: string | URL,
    init: RequestInit & { plugin?: string } = {}
  ): Promise<Response> {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const body = typeof init.body === "string" ? init.body : "";
    const auth = new Headers(init.headers).get("authorization") ?? "";
    const marker = `${url.href} ${auth} ${body}`;
    // Only this suite's fake credentials get an answer; anything else looks like no network.
    if (!marker.includes("fa-")) {
      return Promise.reject(
        new TypeError(`fetch failed: ${url.hostname} is not stubbed`)
      );
    }
    calls.push({ url: url.href, method, body });
    return Promise.resolve(answer(url, method, marker));
  }

  return { calls, safeFetch };
});

vi.mock("@/lib/safe-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/safe-fetch")>()),
  safeFetch: providers.safeFetch,
}));

type Db = typeof import("@/lib/db")["db"];
type Cycle = typeof import("@/lib/notifications/failure-alerts/cycle");
type Settings = typeof import("@/lib/notifications/failure-alerts/settings");
type WorkflowSettings =
  typeof import("@/lib/notifications/failure-alerts/workflow-settings");
type TestSend = typeof import("@/lib/notifications/failure-alerts/test-send");
type OrgPause = typeof import("@/lib/notifications/failure-alerts/org-pause");
type Watchdog = typeof import("@/lib/notifications/failure-alerts/watchdog");
type Policy = typeof import("@/lib/notifications/failure-alerts/policy");
type OrgRecipients = typeof import("@/lib/notifications/org-recipients");
type CreateIntegration =
  typeof import("@/lib/db/integrations")["createIntegration"];

const SKIP =
  !process.env.DATABASE_URL || process.env.SKIP_INFRA_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL ?? "";

const PREFIX = "test_failure_alerts_";
const RUN = Date.now().toString(36);
const APP = "http://localhost:3000";
const MINUTE = 60_000;
const SUITE_TIMEOUT = 120_000;

type Mail = { to: string; subject: string; text: string };
type Org = { orgId: string; userId: string; email: string; name: string };

const mails: Mail[] = [];
let emailStatus = 202;
let sendGrid: Server;

let db: Db;
let cycle: Cycle;
let settings: Settings;
let workflowSettings: WorkflowSettings;
let testSend: TestSend;
let orgPause: OrgPause;
let watchdog: Watchdog;
let policy: Policy;
let orgRecipients: OrgRecipients;
let createIntegration: CreateIntegration;
let syncWorkflowSchedule: typeof import("@/lib/schedule-service")["syncWorkflowSchedule"];
let resetOrgCircuitBreaker: typeof import("@/lib/execute/org-circuit-breaker")["resetOrgCircuitBreaker"];

const savedEnv: Record<string, string | undefined> = {};
const orgIds: string[] = [];
let counter = 0;

const nextId = (kind: string): string => {
  counter += 1;
  return `${PREFIX}${RUN}_${kind}${counter}`;
};

const at = (minutesFromNow: number): Date =>
  new Date(Date.now() + minutesFromNow * MINUTE);

function setEnv(key: string, value: string): void {
  if (!(key in savedEnv)) {
    savedEnv[key] = process.env[key];
  }
  process.env[key] = value;
}

/** Answers SendGrid's v3 mail/send shape and records what it took. */
function startSendGridStub(): Promise<Server> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (emailStatus === 202) {
        const parsed = JSON.parse(body);
        mails.push({
          to: parsed.personalizations[0].to[0].email,
          subject: parsed.personalizations[0].subject,
          text: parsed.content[0].value,
        });
      }
      res.statusCode = emailStatus;
      res.end(emailStatus === 202 ? "" : '{"errors":["stub outage"]}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

/** Removes every row this suite made, including the append-only audit rows. */
async function cleanup(): Promise<void> {
  const client = postgres(DATABASE_URL, { max: 1 });
  const pattern = `${PREFIX}%`;
  try {
    await client.begin(async (tx) => {
      // The audit log is append-only; the replica role skips its guard (and every cascade).
      await tx`SET LOCAL session_replication_role = 'replica'`;
      await tx`DELETE FROM security_audit_log WHERE organization_id LIKE ${pattern} OR resource_id LIKE ${pattern}`;
      await tx`DELETE FROM alert_deliveries WHERE organization_id LIKE ${pattern}`;
      await tx`DELETE FROM alert_incidents WHERE organization_id LIKE ${pattern}`;
      await tx`DELETE FROM alert_methods WHERE organization_id LIKE ${pattern}`;
      await tx`DELETE FROM alert_overrides WHERE organization_id LIKE ${pattern}`;
      await tx`DELETE FROM alert_queue WHERE workflow_id LIKE ${pattern}`;
      await tx`DELETE FROM alert_email_usage WHERE organization_id LIKE ${pattern}`;
      await tx`DELETE FROM alert_settings WHERE organization_id LIKE ${pattern}`;
      await tx`DELETE FROM workflow_executions WHERE workflow_id LIKE ${pattern}`;
      await tx`DELETE FROM workflow_schedules WHERE workflow_id LIKE ${pattern}`;
      await tx`DELETE FROM workflows WHERE id LIKE ${pattern}`;
      await tx`DELETE FROM integrations WHERE organization_id LIKE ${pattern}`;
      await tx`DELETE FROM member WHERE organization_id LIKE ${pattern}`;
      await tx`DELETE FROM organization WHERE id LIKE ${pattern}`;
      await tx`DELETE FROM users WHERE id LIKE ${pattern}`;
    });
  } finally {
    await client.end();
  }
}

async function makeOrg(
  tag: string,
  options: { walletOnly?: boolean } = {}
): Promise<Org> {
  const userId = nextId(`user_${tag}_`);
  const orgId = nextId(`org_${tag}_`);
  const email = options.walletOnly
    ? `0x${`${tag}${RUN}`.padEnd(40, "0").slice(0, 40)}@wallet.keeperhub.com`
    : `${tag}-${RUN}@failure-alerts.test`;
  const name = `FA ${tag} ${RUN}`;
  await db.insert(users).values({
    id: userId,
    name: `${tag} owner`,
    email,
    emailVerified: !options.walletOnly,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(organization).values({
    id: orgId,
    name,
    slug: orgId.replaceAll("_", "-"),
    createdAt: new Date(),
  });
  await db.insert(member).values({
    id: nextId("member_"),
    organizationId: orgId,
    userId,
    role: "owner",
    createdAt: new Date(),
  });
  // Only this suite's orgs are switched on, so the cycle never alerts anyone else.
  orgIds.push(orgId);
  setEnv("FAILURE_ALERTS_ROLLOUT", `orgs:${orgIds.join(",")}`);
  return { orgId, userId, email, name };
}

/** Keeps an org in the database but outside the rollout. */
function leaveRollout(org: Org): void {
  orgIds.splice(orgIds.indexOf(org.orgId), 1);
  setEnv("FAILURE_ALERTS_ROLLOUT", `orgs:${orgIds.join(",")}`);
}

async function addSchedule(workflowId: string): Promise<void> {
  await db.insert(workflowSchedules).values({
    workflowId,
    cronExpression: "*/5 * * * *",
    createdAt: at(-120),
    updatedAt: at(-120),
  });
}

async function makeWorkflow(
  org: Org,
  name: string,
  triggerType = "Schedule"
): Promise<string> {
  const id = nextId("wf_");
  await db.insert(workflows).values({
    id,
    name: wfName(name),
    userId: org.userId,
    organizationId: org.orgId,
    nodes: [
      {
        id: "trigger",
        type: "trigger",
        position: { x: 0, y: 0 },
        data: { type: "trigger", label: "Trigger", config: { triggerType } },
      },
    ],
    edges: [],
    enabled: true,
  });
  return id;
}

async function addRun(
  org: Org,
  workflowId: string,
  status:
    | "success"
    | "error"
    | "skipped"
    | "system_error"
    | "phantom"
    | "pending",
  options: {
    at?: Date;
    source?: string;
    credential?: string;
    errorType?: "system" | "user";
  } = {}
): Promise<void> {
  const startedAt = options.at ?? new Date();
  await db.insert(workflowExecutions).values({
    id: nextId("run_"),
    workflowId,
    userId: org.userId,
    organizationId: org.orgId,
    status,
    triggerSource: options.source ?? "schedule",
    triggeredByCredentialType: options.credential ?? null,
    startedAt,
    completedAt: new Date(startedAt.getTime() + 1000),
    error: status === "error" ? "execution reverted (RPC 429)" : null,
    errorType: options.errorType ?? null,
  });
}

/** Skip the 30-minute recovery hold: make held recovery rows due now. */
async function endRecoveryHold(orgId: string): Promise<void> {
  await db
    .update(failureAlertDeliveries)
    .set({ nextAttemptAt: new Date() })
    .where(
      and(
        eq(failureAlertDeliveries.organizationId, orgId),
        eq(failureAlertDeliveries.kind, "recovery"),
        eq(failureAlertDeliveries.state, "pending")
      )
    );
}

async function addFailures(
  org: Org,
  workflowId: string,
  count: number,
  firstAt = -6
): Promise<void> {
  for (let i = 0; i < count; i++) {
    await addRun(org, workflowId, "error", { at: at(firstAt + i) });
  }
}

const runCycle = (): ReturnType<Cycle["runFailureAlertCycle"]> =>
  cycle.runFailureAlertCycle(APP);

async function openIncident(
  workflowId: string
): Promise<typeof workflowFailureIncidents.$inferSelect | undefined> {
  const [row] = await db
    .select()
    .from(workflowFailureIncidents)
    .where(
      and(
        eq(workflowFailureIncidents.workflowId, workflowId),
        isNull(workflowFailureIncidents.resolvedAt)
      )
    );
  return row;
}

async function incidentById(
  id: string | undefined
): Promise<typeof workflowFailureIncidents.$inferSelect | undefined> {
  const [row] = await db
    .select()
    .from(workflowFailureIncidents)
    .where(eq(workflowFailureIncidents.id, id ?? ""));
  return row;
}

async function deliveriesOf(
  orgId: string
): Promise<(typeof failureAlertDeliveries.$inferSelect)[]> {
  return await db
    .select()
    .from(failureAlertDeliveries)
    .where(eq(failureAlertDeliveries.organizationId, orgId));
}

async function channelById(
  id: string
): Promise<typeof failureAlertChannels.$inferSelect | undefined> {
  const [row] = await db
    .select()
    .from(failureAlertChannels)
    .where(eq(failureAlertChannels.id, id));
  return row;
}

async function isEnabled(workflowId: string): Promise<boolean | undefined> {
  const [row] = await db
    .select({ enabled: workflows.enabled })
    .from(workflows)
    .where(eq(workflows.id, workflowId));
  return row?.enabled;
}

async function setEnabled(workflowId: string, enabled: boolean): Promise<void> {
  await db
    .update(workflows)
    .set({ enabled })
    .where(eq(workflows.id, workflowId));
}

const mailsTo = (org: Org): Mail[] => mails.filter((m) => m.to === org.email);

/** Workflow names are data, not copy, so they survive wording changes. */
const wfName = (name: string): string => `${name} ${RUN}`;

const mailsAbout = (org: Org, name: string): Mail[] =>
  mailsTo(org).filter(
    (m) => m.subject.includes(wfName(name)) || m.text.includes(wfName(name))
  );

async function deliveredEmailCount(org: Org): Promise<number> {
  return (await deliveriesOf(org.orgId)).filter(
    (d) => d.channel === "email" && d.state === "delivered"
  ).length;
}

/** Delivered emails of one kind; kinds are stable where the wording is not. */
async function sentEmails(
  org: Org,
  kind: string
): Promise<(typeof failureAlertDeliveries.$inferSelect)[]> {
  return (await deliveriesOf(org.orgId)).filter(
    (d) => d.kind === kind && d.channel === "email" && d.state === "delivered"
  );
}

type ChannelKind = "discord" | "telegram" | "pagerduty" | "slack";
type Health = "live" | "dead";
type Channel = typeof failureAlertChannels.$inferSelect & { token: string };

/** An org-shared connection plus a method row; health picks the fake provider's answer. */
async function makeChannel(
  org: Org,
  kind: ChannelKind,
  role: "always" | "backup",
  health: Health,
  options: { checked?: boolean; destination?: string } = {}
): Promise<Channel> {
  const token = `fa-${health}-${nextId("tok_")}`;
  const configs: Record<ChannelKind, Record<string, string>> = {
    discord: { webhookUrl: `https://discord.com/api/webhooks/1/${token}` },
    telegram: { botToken: `123456:${token}` },
    pagerduty: { apiToken: token },
    slack: { apiKey: `xoxb-${token}` },
  };
  const destinations: Record<ChannelKind, string> = {
    discord: "",
    telegram: "-1001",
    pagerduty: "PFA0001",
    slack: "#alerts",
  };
  const integration = await createIntegration({
    userId: org.userId,
    name: `${kind} ${health}`,
    type: kind,
    config: configs[kind] as never,
    organizationId: org.orgId,
  });
  const [channel] = await db
    .insert(failureAlertChannels)
    .values({
      organizationId: org.orgId,
      kind,
      integrationId: integration.id,
      destination: options.destination ?? destinations[kind],
      role,
      // A checked channel skips the silent check, so the send path itself runs.
      lastHealthCheckAt: options.checked === false ? null : new Date(),
    })
    .returning();
  if (!channel) {
    throw new Error("channel insert returned nothing");
  }
  return { ...channel, token };
}

/** A connection the org can pick, with no method row yet (what the editor sends for a new one). */
async function makeConnection(
  org: Org,
  kind: ChannelKind,
  health: Health
): Promise<string> {
  const channel = await makeChannel(org, kind, "always", health);
  await db
    .delete(failureAlertChannels)
    .where(eq(failureAlertChannels.id, channel.id));
  return channel.integrationId;
}

const callsTo = (
  fragment: string
): { url: string; method: string; body: string }[] =>
  providers.calls.filter((c) => c.url.includes(fragment));

async function settingsError(run: () => Promise<unknown>): Promise<{
  message: string;
  status?: number;
}> {
  try {
    await run();
  } catch (error) {
    return {
      message: (error as Error).message,
      status: (error as { status?: number }).status,
    };
  }
  return { message: "" };
}

const PAUSED_WORDING = /turned off/i;
const TEST_WORDING = /test/i;
const PAGED_WORDING = /paged/i;
const EMAIL_WORDING = /email/i;

describe.skipIf(SKIP)("workflow failure alerts (real Postgres)", () => {
  beforeAll(async () => {
    await cleanup();
    sendGrid = await startSendGridStub();
    const { port } = sendGrid.address() as AddressInfo;
    setEnv("SENDGRID_API_URL", `http://127.0.0.1:${port}/v3/mail/send`);
    setEnv("SENDGRID_API_KEY", "stub-key");
    setEnv("FAILURE_ALERTS_ROLLOUT", "orgs:");
    setEnv("NEXT_PUBLIC_BILLING_ENABLED", "true");
    setEnv(
      "INTEGRATION_ENCRYPTION_KEY",
      process.env.INTEGRATION_ENCRYPTION_KEY ?? "ab".repeat(32)
    );
    // lib/email reads SENDGRID_API_URL at load, so the app modules load after the env is set.
    vi.resetModules();
    ({ db } = await import("@/lib/db"));
    ({ createIntegration } = await import("@/lib/db/integrations"));
    cycle = await import("@/lib/notifications/failure-alerts/cycle");
    settings = await import("@/lib/notifications/failure-alerts/settings");
    workflowSettings = await import(
      "@/lib/notifications/failure-alerts/workflow-settings"
    );
    testSend = await import("@/lib/notifications/failure-alerts/test-send");
    orgPause = await import("@/lib/notifications/failure-alerts/org-pause");
    watchdog = await import("@/lib/notifications/failure-alerts/watchdog");
    policy = await import("@/lib/notifications/failure-alerts/policy");
    orgRecipients = await import("@/lib/notifications/org-recipients");
    ({ syncWorkflowSchedule } = await import("@/lib/schedule-service"));
    ({ resetOrgCircuitBreaker } = await import(
      "@/lib/execute/org-circuit-breaker"
    ));
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await new Promise<void>((resolve) => {
      if (sendGrid) {
        sendGrid.close(() => resolve());
      } else {
        resolve();
      }
    });
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }, 60_000);

  // Steps run in order and share one org: one streak from launch to recovery.
  describe("detection and streaks", { timeout: SUITE_TIMEOUT }, () => {
    let acme: Org;
    let wf: string;
    let incidentId: string | undefined;

    beforeAll(async () => {
      acme = await makeOrg("acme");
      wf = await makeWorkflow(acme, "OETH Vault TVL Watchdog");
      await addRun(acme, wf, "success", { at: at(-120) });
    });

    it("emails a launch notice to the owner of an org that already had runs", async () => {
      await runCycle();
      expect(await sentEmails(acme, "launch_notice")).toHaveLength(1);
      expect(mailsTo(acme)).toHaveLength(1);
      const [row] = await db
        .select()
        .from(orgFailureAlertSettings)
        .where(eq(orgFailureAlertSettings.organizationId, acme.orgId));
      expect(row?.countingSince).toBeTruthy();
    });

    it("does not open an incident at 2 automated failures (manual, skipped and system errors do not count)", async () => {
      for (let i = 0; i < 2; i++) {
        await addRun(acme, wf, "error", { at: at(-5 + i * 0.5) });
      }
      await addRun(acme, wf, "error", {
        at: at(-2.5),
        source: "manual",
        credential: "session",
      });
      await addRun(acme, wf, "skipped", { at: at(-2) });
      await addRun(acme, wf, "system_error", { at: at(-1.5) });
      await runCycle();
      expect(await openIncident(wf)).toBeUndefined();
    });

    it("opens an incident and emails the owner at the 3rd automated failure (the default), linking to the Runs tab", async () => {
      await addRun(acme, wf, "error", { at: at(-1) });
      await runCycle();
      const incident = await openIncident(wf);
      incidentId = incident?.id;
      expect(incident?.failureCount).toBe(3);
      expect(await sentEmails(acme, "alert")).toHaveLength(1);
      const alert = mailsAbout(acme, "OETH Vault TVL Watchdog").at(-1);
      expect(alert?.text).toContain(`/workflows/${wf}?tab=runs`);
    });

    it("sends no second alert for the same streak and keeps counting", async () => {
      const before = mailsTo(acme).length;
      await addRun(acme, wf, "error");
      await addRun(acme, wf, "error");
      await runCycle();
      expect(mailsTo(acme)).toHaveLength(before);
      expect((await openIncident(wf))?.failureCount).toBe(5);
    });

    it("sends a daily reminder while it keeps failing", async () => {
      await db
        .update(workflowFailureIncidents)
        .set({ lastNotifiedAt: at(-25 * 60) })
        .where(eq(workflowFailureIncidents.workflowId, wf));
      await runCycle();
      expect(await sentEmails(acme, "reminder")).toHaveLength(1);
    });

    it("resolves on an automated success and sends the recovery after the 30-minute hold", async () => {
      await addRun(acme, wf, "success");
      await runCycle();
      expect(await openIncident(wf)).toBeUndefined();
      expect(await sentEmails(acme, "recovery")).toHaveLength(0);
      const held = (await deliveriesOf(acme.orgId)).find(
        (d) => d.kind === "recovery"
      );
      expect(held?.state).toBe("pending");
      expect(held?.nextAttemptAt.getTime()).toBeGreaterThan(
        Date.now() + 25 * 60 * 1000
      );
      await endRecoveryHold(acme.orgId);
      await runCycle();
      expect(await sentEmails(acme, "recovery")).toHaveLength(1);
    });

    it("drops an alert taken over after the workflow recovered instead of sending it", async () => {
      const staleId = nextId("delivery_");
      const lateTo = `late-${RUN}@failure-alerts.test`;
      await db.insert(failureAlertDeliveries).values({
        id: staleId,
        organizationId: acme.orgId,
        incidentId: incidentId ?? "",
        kind: "alert",
        sequence: 99,
        channel: "email",
        recipient: lateTo,
        dedupKey: `${staleId}-stale`,
        state: "sending",
        attempts: 1,
        nextAttemptAt: at(-60),
        updatedAt: at(-60),
      });
      await runCycle();
      const [row] = await db
        .select()
        .from(failureAlertDeliveries)
        .where(eq(failureAlertDeliveries.id, staleId));
      expect(row?.state).toBe("skipped");
      expect(mails.some((m) => m.to === lateTo)).toBe(false);
    });
  });

  // Each case has its own workflow in one org with a 1-hour time limit.
  describe("streak rules", { timeout: SUITE_TIMEOUT }, () => {
    let eps: Org;

    beforeAll(async () => {
      eps = await makeOrg("eps");
      await db.insert(orgFailureAlertSettings).values({
        organizationId: eps.orgId,
        threshold: 5,
        timeLimitMinutes: 60,
        countingSince: at(-24 * 60),
      });
    });

    it("opens a time-limit incident at 2 failures over an hour apart, and closes it quietly when paused", async () => {
      const slow = await makeWorkflow(eps, "Slow schedule");
      await addRun(eps, slow, "error", { at: at(-180) });
      await addRun(eps, slow, "error", { at: at(-90) });
      await runCycle();
      expect((await openIncident(slow))?.openedBy).toBe("time");

      // Pausing writes no run, so only the sweep can notice.
      await setEnabled(slow, false);
      const before = mailsAbout(eps, "Slow schedule").length;
      await runCycle();
      const [closed] = await db
        .select()
        .from(workflowFailureIncidents)
        .where(eq(workflowFailureIncidents.workflowId, slow));
      expect(closed?.resolvedReason).toBe("disabled");
      expect(mailsAbout(eps, "Slow schedule")).toHaveLength(before);
    });

    it("opens no incident while muted, re-checks when the mute ends, then alerts", async () => {
      const muted = await makeWorkflow(eps, "Muted one");
      await db.insert(workflowFailureAlertOverrides).values({
        workflowId: muted,
        organizationId: eps.orgId,
        mutedUntil: at(60),
      });
      await addFailures(eps, muted, 5);
      await runCycle();
      expect(await openIncident(muted)).toBeUndefined();
      const [queued] = await db
        .select()
        .from(workflowFailureAlertQueue)
        .where(eq(workflowFailureAlertQueue.workflowId, muted));
      expect(queued?.dueAt.getTime()).toBeGreaterThan(Date.now());

      await db
        .update(workflowFailureAlertOverrides)
        .set({ mutedUntil: at(-1) })
        .where(eq(workflowFailureAlertOverrides.workflowId, muted));
      await db
        .update(workflowFailureAlertQueue)
        .set({ dueAt: at(-1) })
        .where(eq(workflowFailureAlertQueue.workflowId, muted));
      await runCycle();
      expect(await openIncident(muted)).toBeDefined();
    });

    it("never alerts for a manual-only workflow", async () => {
      const manual = await makeWorkflow(eps, "Manual only", "Manual");
      for (let i = 0; i < 6; i++) {
        await addRun(eps, manual, "error", {
          at: at(-6 + i),
          source: "manual",
          credential: "session",
        });
      }
      await runCycle();
      expect(await openIncident(manual)).toBeUndefined();
    });

    it("counts API-key runs even though they are labelled manual", async () => {
      const api = await makeWorkflow(eps, "API driven");
      for (let i = 0; i < 5; i++) {
        await addRun(eps, api, "error", {
          at: at(-6 + i),
          source: "manual",
          credential: "org_api_key",
        });
      }
      await runCycle();
      expect(await openIncident(api)).toBeDefined();
    });

    it("queues the alert of an incident that was opened but never queued (crash in between)", async () => {
      const lostWf = await makeWorkflow(eps, "Lost alert");
      const [lost] = await db
        .insert(workflowFailureIncidents)
        .values({
          organizationId: eps.orgId,
          workflowId: lostWf,
          openedBy: "count",
          threshold: 5,
          failureCount: 5,
          firstFailedAt: at(-30),
          lastFailedAt: at(-6),
          openedAt: at(-5),
        })
        .returning();
      await runCycle();
      expect((await incidentById(lost?.id))?.alertQueuedAt).toBeTruthy();
      const rows = (await deliveriesOf(eps.orgId)).filter(
        (d) => d.incidentId === lost?.id
      );
      expect(rows.length).toBeGreaterThan(0);
    });
  });

  // Independent cases, each with its own org.
  describe("concurrency and grouping", { timeout: SUITE_TIMEOUT }, () => {
    it("two cycles at once open one incident and send one alert", async () => {
      const org = await makeOrg("parallel");
      const wf = await makeWorkflow(org, "Rebalance vault");
      await addFailures(org, wf, 5);
      await Promise.all([runCycle(), runCycle()]);
      const incidents = await db
        .select()
        .from(workflowFailureIncidents)
        .where(eq(workflowFailureIncidents.workflowId, wf));
      expect(incidents).toHaveLength(1);
      expect(await sentEmails(org, "alert")).toHaveLength(1);
      // One mail per delivered row: nothing was sent twice.
      expect(mailsTo(org)).toHaveLength(await deliveredEmailCount(org));
    });

    it("a grouped email notes a workflow that ran out of funds earlier, from how the incident opened", async () => {
      const org = await makeOrg("omicron");
      const names = ["Funds Keeper", "Plain Keeper A", "Plain Keeper B"];
      for (const name of names) {
        const id = await makeWorkflow(org, name);
        await db.insert(workflowFailureIncidents).values({
          organizationId: org.orgId,
          workflowId: id,
          openedBy: name === "Funds Keeper" ? "funding" : "count",
          threshold: 5,
          failureCount: 5,
          firstFailedAt: at(-30),
          lastFailedAt: at(-6),
          lastError: "execution reverted",
          openedAt: at(-5),
        });
      }
      await runCycle();
      const grouped = mailsTo(org).find((m) =>
        names.every((n) => m.text.includes(wfName(n)))
      );
      // Its latest error is not a funds error, so no "Wallet out of funds:" prefix.
      expect(grouped?.text).toContain(
        `${wfName("Funds Keeper")}: 5 failed runs in a row, ran out of funds earlier`
      );
      expect(grouped?.text).not.toContain("Wallet out of funds:");
      expect(grouped?.text).not.toContain(
        `${wfName("Plain Keeper A")}: 5 failed runs in a row, ran out of funds earlier`
      );
    });

    it("the low-email warning says nobody is told once used up when no chat method works", async () => {
      const org = await makeOrg("pi");
      await db.execute(sql`
        INSERT INTO alert_email_usage (organization_id, period_start, sent)
        VALUES (${org.orgId}, date_trunc('month', now() AT TIME ZONE 'UTC'), 79)
      `);
      const wf = await makeWorkflow(org, "Keeper near cap");
      await addFailures(org, wf, 5);
      await runCycle();
      await runCycle();
      const warning = (await sentEmails(org, "cap_warning")).length;
      expect(warning).toBe(1);
      const mail = mailsTo(org).find((m) => m.subject.includes("80 of"));
      expect(mail?.text).toContain("nobody is told");
    });

    it("three workflows failing in one cycle send one grouped email naming all three", async () => {
      const org = await makeOrg("delta");
      const names = ["Vault A", "Vault B", "Vault C"];
      for (const name of names) {
        await addFailures(org, await makeWorkflow(org, name), 5);
      }
      await runCycle();
      const alerts = await sentEmails(org, "alert");
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.context?.incidentIds).toHaveLength(3);
      const grouped = mailsTo(org).filter((m) =>
        names.every((n) => m.text.includes(wfName(n)))
      );
      expect(grouped.length).toBeGreaterThan(0);
      expect(mailsTo(org)).toHaveLength(await deliveredEmailCount(org));
    });
  });

  // Steps run in order and share one org: an email outage, then plan B, then recovery.
  describe("delivery, backups and retries", { timeout: SUITE_TIMEOUT }, () => {
    let acme: Org;
    let wf: string;
    let incidentId: string | undefined;
    let discord: Channel;

    beforeAll(async () => {
      acme = await makeOrg("outage");
      discord = await makeChannel(acme, "discord", "backup", "dead");
      wf = await makeWorkflow(acme, "Harvest keeper");
      await addFailures(acme, wf, 5);
    });

    afterAll(() => {
      emailStatus = 202;
    });

    it("retries an email the provider refused with 503, about a minute out", async () => {
      emailStatus = 503;
      await runCycle();
      incidentId = (await openIncident(wf))?.id;
      const row = (await deliveriesOf(acme.orgId)).find(
        (d) =>
          d.incidentId === incidentId && d.channel === "email" && !d.isBackup
      );
      expect(row?.state, row?.lastError ?? "").toBe("retrying");
      expect(row?.lastStatus).toBe(503);
      expect(row?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    });

    it("queues the backup channel once the backup wait is over, with the reason", async () => {
      await db
        .update(failureAlertDeliveries)
        .set({ backupAt: at(-1) })
        .where(
          and(
            eq(failureAlertDeliveries.incidentId, incidentId ?? ""),
            eq(failureAlertDeliveries.channel, "email")
          )
        );
      await runCycle();
      const row = (await deliveriesOf(acme.orgId)).find(
        (d) => d.incidentId === incidentId && d.channel === "discord"
      );
      expect(row?.isBackup).toBe(true);
      expect(String(row?.context?.backupReason ?? "")).toMatch(EMAIL_WORDING);
    });

    it("treats a deleted Discord webhook as a permanent failure and pauses the channel", async () => {
      const row = (await deliveriesOf(acme.orgId)).find(
        (d) => d.incidentId === incidentId && d.channel === "discord"
      );
      expect(row?.state, `${row?.lastStatus} ${row?.lastError}`).toBe("failed");
      expect(row?.lastStatus).toBe(404);
      const posts = callsTo(discord.token).filter((c) => c.method === "POST");
      expect(posts).toHaveLength(1);
      const after = await channelById(discord.id);
      expect(after?.pausedAt).toBeTruthy();
      expect(after?.pausedReason).toBeTruthy();
    });

    it("delivers the late alert and the paused-channel notice once email recovers", async () => {
      emailStatus = 202;
      await db
        .update(failureAlertDeliveries)
        .set({ nextAttemptAt: at(-1) })
        .where(
          and(
            eq(failureAlertDeliveries.organizationId, acme.orgId),
            eq(failureAlertDeliveries.state, "retrying")
          )
        );
      await runCycle();
      expect(mailsAbout(acme, "Harvest keeper").length).toBeGreaterThan(0);
      expect(await sentEmails(acme, "alert")).toHaveLength(1);
      expect(await sentEmails(acme, "channel_paused")).toHaveLength(1);
    });
  });

  // Independent cases, each with its own org and PagerDuty or chat channel.
  describe("PagerDuty and chat channels", { timeout: SUITE_TIMEOUT }, () => {
    it("PagerDuty with a bad token fails for good and sends a backup email saying nobody was paged", async () => {
      const org = await makeOrg("beta");
      await makeChannel(org, "pagerduty", "always", "dead");
      const wf = await makeWorkflow(org, "Liquidation guard");
      await addFailures(org, wf, 5);
      await runCycle();
      const rows = await deliveriesOf(org.orgId);
      const page = rows.find((d) => d.channel === "pagerduty");
      expect(page?.state, page?.lastError ?? "").toBe("failed");
      expect(page?.lastStatus).toBe(401);
      const backup = rows.find(
        (d) => d.channel === "email" && d.isBackup && d.state === "delivered"
      );
      expect(backup).toBeDefined();
      expect(String(backup?.context?.backupReason ?? "")).toMatch(
        PAGED_WORDING
      );
    });

    it("pages PagerDuty and resolves the same incident key on recovery", async () => {
      const org = await makeOrg("pdlive");
      const channel = await makeChannel(org, "pagerduty", "always", "live");
      const wf = await makeWorkflow(org, "Paging keeper");
      await addFailures(org, wf, 5);
      await runCycle();
      const page = (await deliveriesOf(org.orgId)).find(
        (d) => d.channelId === channel.id && d.kind === "alert"
      );
      expect(page?.state, page?.lastError ?? "").toBe("delivered");

      await addRun(org, wf, "success");
      await runCycle();
      await endRecoveryHold(org.orgId);
      await runCycle();
      const resolveRow = (await deliveriesOf(org.orgId)).find(
        (d) => d.channelId === channel.id && d.kind === "recovery"
      );
      expect(resolveRow?.state, resolveRow?.lastError ?? "").toBe("delivered");
      const events = callsTo("events.pagerduty.com/v2/enqueue")
        .map(
          (c) =>
            JSON.parse(c.body) as {
              event_action: string;
              dedup_key: string;
              payload?: { summary?: string };
            }
        )
        .filter(
          (e) =>
            e.event_action === "resolve" ||
            e.payload?.summary?.includes(wfName("Paging keeper"))
        );
      const trigger = events.find((e) => e.event_action === "trigger");
      expect(trigger?.dedup_key).toBeTruthy();
      expect(
        events.some(
          (e) =>
            e.event_action === "resolve" && e.dedup_key === trigger?.dedup_key
        )
      ).toBe(true);
    });

    it("posts the alert to a working Discord channel set to Always", async () => {
      const org = await makeOrg("chat");
      const channel = await makeChannel(org, "discord", "always", "live");
      const wf = await makeWorkflow(org, "Discord keeper");
      await addFailures(org, wf, 5);
      await runCycle();
      const row = (await deliveriesOf(org.orgId)).find(
        (d) => d.channelId === channel.id
      );
      expect(row?.state, row?.lastError ?? "").toBe("delivered");
      const posts = callsTo(channel.token).filter((c) => c.method === "POST");
      expect(posts).toHaveLength(1);
      expect(posts[0]?.body).toContain(wfName("Discord keeper"));
    });
  });

  describe("Free plan cap", { timeout: SUITE_TIMEOUT }, () => {
    it("caps an alert email over 100 a month but still sends the one-time launch notice", async () => {
      const org = await makeOrg("gamma");
      await db.execute(sql`
        INSERT INTO alert_email_usage (organization_id, period_start, sent)
        VALUES (${org.orgId}, date_trunc('month', now() AT TIME ZONE 'UTC'), 100)
      `);
      const wf = await makeWorkflow(org, "Keeper capped");
      await addFailures(org, wf, 5);
      await runCycle();
      const rows = await deliveriesOf(org.orgId);
      expect(
        rows.some(
          (d) =>
            d.kind === "alert" && d.channel === "email" && d.state === "capped"
        )
      ).toBe(true);
      expect(await sentEmails(org, "launch_notice")).toHaveLength(1);
      expect(mailsTo(org)).toHaveLength(1);
    });

    it("sends a test email to the caller, marked as a test, without counting it", async () => {
      const org = await makeOrg("tester");
      const usage = async (): Promise<number> => {
        const rows = await db.execute<{ sent: number }>(sql`
          SELECT sent FROM alert_email_usage WHERE organization_id = ${org.orgId}
        `);
        return Number([...rows][0]?.sent ?? 0);
      };
      const before = await usage();
      const result = await testSend.sendTest({
        organizationId: org.orgId,
        userId: org.userId,
        request: { channel: "email", to: "me" },
      });
      expect(result.delivered, result.message).toBe(true);
      const [mail] = mailsTo(org);
      expect(mail?.subject).toMatch(TEST_WORDING);
      expect(await usage()).toBe(before);
    });
  });

  // Steps run in order and share one org.
  describe("channel health and pause", { timeout: SUITE_TIMEOUT }, () => {
    let org: Org;
    let dead: Channel;
    let live: Channel;

    beforeAll(async () => {
      org = await makeOrg("health");
      dead = await makeChannel(org, "discord", "always", "dead", {
        checked: false,
      });
      live = await makeChannel(org, "telegram", "always", "live", {
        checked: false,
      });
    });

    it("the silent check pauses a dead channel without posting to it", async () => {
      await runCycle();
      const after = await channelById(dead.id);
      expect(after?.pausedAt).toBeTruthy();
      expect(after?.pausedReason).toBeTruthy();
      const deliveries = await deliveriesOf(org.orgId);
      expect(deliveries.some((d) => d.channelId === dead.id)).toBe(false);
      const calls = callsTo(dead.token);
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((c) => c.method === "GET")).toBe(true);
    });

    it("leaves a working channel live, records the check and posts nothing", async () => {
      const after = await channelById(live.id);
      expect(after?.pausedAt).toBeNull();
      expect(after?.lastHealthCheckAt).toBeTruthy();
      const calls = callsTo(live.token);
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((c) => c.url.includes("/getChat"))).toBe(true);
    });

    it("tells the owner the channel was paused", async () => {
      await runCycle();
      expect(await sentEmails(org, "channel_paused")).toHaveLength(1);
    });

    it("a workflow's own method that dies tells the owner, the alert people and the workflow's people, and is flagged", async () => {
      const own = await makeOrg("wfdead");
      const addUser = async (tag: string, role: string): Promise<string> => {
        const id = nextId(`user_${tag}_`);
        await db.insert(users).values({
          id,
          name: tag,
          email: `${tag}-${RUN}@failure-alerts.test`,
          emailVerified: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        await db.insert(member).values({
          id: nextId("member_"),
          organizationId: own.orgId,
          userId: id,
          role,
          createdAt: new Date(),
        });
        return id;
      };
      const oncall = await addUser("wfdead-oncall", "admin");
      const dev = await addUser("wfdead-dev", "member");
      // The org's alerts go to on-call only, so the owner is not among them.
      await db.insert(orgFailureAlertSettings).values({
        organizationId: own.orgId,
        threshold: 5,
        recipientUserIds: [oncall],
        countingSince: at(-60),
      });
      const wf = await makeWorkflow(own, "Vault keeper");
      await db.insert(workflowFailureAlertOverrides).values({
        workflowId: wf,
        organizationId: own.orgId,
        customChannels: true,
        recipientUserIds: [dev],
      });
      const telegram = await makeChannel(own, "telegram", "always", "dead", {
        checked: false,
      });
      await db
        .update(failureAlertChannels)
        .set({ workflowId: wf })
        .where(eq(failureAlertChannels.id, telegram.id));

      await runCycle();
      await runCycle();

      const notices = (await deliveriesOf(own.orgId)).filter(
        (d) => d.kind === "channel_paused" && d.channel === "email"
      );
      expect(new Set(notices.map((d) => d.recipient))).toEqual(
        new Set([
          own.email,
          `wfdead-oncall-${RUN}@failure-alerts.test`,
          `wfdead-dev-${RUN}@failure-alerts.test`,
        ])
      );
      expect(notices[0]?.context?.workflowId).toBe(wf);
      expect(String(notices[0]?.context?.workflowName)).toContain(
        "Vault keeper"
      );
      const mail = mailsTo(own).find((m) =>
        m.subject.includes("stopped working for the workflow Vault keeper")
      );
      expect(mail?.text).toContain(`/workflows/${wf}`);

      const view = await settings.loadOrgSettingsView(own.orgId, own.userId);
      expect(view.customWorkflows.find((w) => w.id === wf)?.brokenMethods).toBe(
        1
      );
    });

    it("a Telegram test with a revoked token reports the provider error and records it", async () => {
      const telegram = await makeChannel(org, "telegram", "always", "dead");
      const result = await testSend.sendTest({
        organizationId: org.orgId,
        userId: org.userId,
        request: {
          channel: "telegram",
          integrationId: telegram.integrationId,
          destination: "-1001",
          channelId: telegram.id,
        },
      });
      expect(result.delivered).toBe(false);
      expect(result.classification).toBe("permanent");
      const after = await channelById(telegram.id);
      expect(after?.lastTestOk).toBe(false);
      expect(after?.lastTestedAt).toBeTruthy();
    });

    it("flags a wallet-only org as unreachable and records that nobody could be emailed", async () => {
      const wallet = await makeOrg("wallet", { walletOnly: true });
      const wf = await makeWorkflow(wallet, "Wallet keeper");
      await addFailures(wallet, wf, 5);
      await runCycle();
      const state = await settings.loadInAppAlertState(wallet.orgId);
      expect(state).toEqual({
        unreachable: true,
        failingWorkflows: 1,
        pausedUntil: null,
      });
      const rows = await deliveriesOf(wallet.orgId);
      expect(
        rows.some(
          (d) => d.recipient === "(nobody reachable)" && d.state === "failed"
        )
      ).toBe(true);
    });
  });

  // Steps run in order and share one org with a five-minute schedule.
  describe("missed runs", { timeout: SUITE_TIMEOUT }, () => {
    let theta: Org;
    let wf: string;
    let incidentId: string | undefined;

    beforeAll(async () => {
      theta = await makeOrg("theta");
      wf = await makeWorkflow(theta, "Hourly Rebalancer");
      await db.insert(workflowSchedules).values({
        workflowId: wf,
        cronExpression: "*/5 * * * *",
        createdAt: at(-120),
        updatedAt: at(-120),
      });
      await db.insert(orgFailureAlertSettings).values({
        organizationId: theta.orgId,
        countingSince: at(-120),
      });
    });

    it("opens a not-running alert for a schedule that has not run", async () => {
      await runCycle();
      const incident = await openIncident(wf);
      incidentId = incident?.id;
      expect(incident?.openedBy).toBe("missed");
      expect(await sentEmails(theta, "alert")).toHaveLength(1);
      expect(mailsAbout(theta, "Hourly Rebalancer")).toHaveLength(1);
    });

    it("sends the not-running alert once", async () => {
      await runCycle();
      expect(await sentEmails(theta, "alert")).toHaveLength(1);
    });

    it("a run started by a person does not end it", async () => {
      await addRun(theta, wf, "success", { at: at(0.2), source: "manual" });
      await runCycle();
      expect((await incidentById(incidentId))?.resolvedAt).toBeNull();
    });

    it("closes with a running-again message once it runs", async () => {
      await addRun(theta, wf, "success", { at: at(0.5) });
      await runCycle();
      expect((await incidentById(incidentId))?.resolvedReason).toBe("ran");
      expect(await sentEmails(theta, "recovery")).toHaveLength(1);
    });
  });

  // Late schedules in orgs outside the rollout still point at a scheduler outage.
  describe("missed runs during a scheduler outage", {
    timeout: SUITE_TIMEOUT,
  }, () => {
    let mu: Org;
    let longAgo: string;
    let recent: string;
    let lastRunAt: Date;
    const outageWorkflows: string[] = [];

    beforeAll(async () => {
      for (const tag of ["byA", "byB", "byC"]) {
        const bystander = await makeOrg(tag);
        leaveRollout(bystander);
        for (let i = 0; i < 7; i++) {
          const id = await makeWorkflow(bystander, `Bystander ${tag} ${i}`);
          await addSchedule(id);
          outageWorkflows.push(id);
        }
      }
      mu = await makeOrg("mu");
      await db.insert(orgFailureAlertSettings).values({
        organizationId: mu.orgId,
        countingSince: at(-120),
      });
      longAgo = await makeWorkflow(mu, "Five Minute Poller");
      recent = await makeWorkflow(mu, "Five Minute Pricer");
      outageWorkflows.push(longAgo, recent);
      for (const id of [longAgo, recent]) {
        await addSchedule(id);
      }
      lastRunAt = at(-60);
      await addRun(mu, longAgo, "success", { at: lastRunAt });
      await addRun(mu, recent, "success", { at: at(-20) });
    });

    afterAll(async () => {
      for (const id of outageWorkflows) {
        await setEnabled(id, false);
      }
    });

    it("holds a fresh miss, but not one that started over 30 minutes ago, and names its first missed run", async () => {
      await runCycle();
      expect(await openIncident(recent)).toBeUndefined();
      const incident = await openIncident(longAgo);
      expect(incident?.openedBy).toBe("missed");
      const first = incident?.firstFailedAt.getTime() ?? 0;
      expect(first).toBeGreaterThan(lastRunAt.getTime());
      expect(first).toBeLessThanOrEqual(lastRunAt.getTime() + 6 * MINUTE);
    });
  });

  // Steps run in order: an org with a schedule that never ran and no stored start.
  describe("missed runs without a stored start", {
    timeout: SUITE_TIMEOUT,
  }, () => {
    let nu: Org;
    let wf: string;
    let stored: Date | null | undefined;

    const countingSince = async (): Promise<Date | null | undefined> => {
      const [row] = await db
        .select({ countingSince: orgFailureAlertSettings.countingSince })
        .from(orgFailureAlertSettings)
        .where(eq(orgFailureAlertSettings.organizationId, nu.orgId));
      return row?.countingSince;
    };

    beforeAll(async () => {
      nu = await makeOrg("nu");
      wf = await makeWorkflow(nu, "Stopped Before Rollout");
      await addSchedule(wf);
    });

    it("stores the start on its first cycle and alerts nothing yet", async () => {
      await runCycle();
      expect(await openIncident(wf)).toBeUndefined();
      stored = await countingSince();
      expect(stored).toBeTruthy();
      expect(stored?.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it("measures later cycles from the stored start, so it alerts", async () => {
      await cycle.runFailureAlertCycle(APP, at(6));
      expect((await openIncident(wf))?.openedBy).toBe("missed");
      expect((await countingSince())?.getTime()).toBe(stored?.getTime());
    });
  });

  // Steps run in order: schedules that come back after a gap count from their return.
  describe("missed runs after a gap", { timeout: SUITE_TIMEOUT }, () => {
    let pi: Org;
    let haltedOrg: Org;
    let reenabled: string;
    let recron: string;
    let unhalted: string;
    let backAt: Date;

    const scheduleNodes = (cron: string) =>
      [
        {
          id: "trigger",
          type: "trigger",
          position: { x: 0, y: 0 },
          data: {
            type: "trigger",
            label: "Trigger",
            config: { triggerType: "Schedule", scheduleCron: cron },
          },
        },
      ] as Parameters<typeof syncWorkflowSchedule>[1];

    beforeAll(async () => {
      pi = await makeOrg("regap");
      haltedOrg = await makeOrg("unhalted");
      for (const org of [pi, haltedOrg]) {
        await db.insert(orgFailureAlertSettings).values({
          organizationId: org.orgId,
          countingSince: at(-300),
        });
      }
      reenabled = await makeWorkflow(pi, "Turned Back On");
      await addSchedule(reenabled);
      await addRun(pi, reenabled, "success", { at: at(-118) });
      await setEnabled(reenabled, false);
      recron = await makeWorkflow(pi, "Cron Changed");
      await db.insert(workflowSchedules).values({
        workflowId: recron,
        cronExpression: "0 0 1 1 *",
        createdAt: at(-120),
        updatedAt: at(-120),
      });
      unhalted = await makeWorkflow(haltedOrg, "Back From Halt");
      await addSchedule(unhalted);
      await db
        .update(organization)
        .set({ haltedAt: at(-120) })
        .where(eq(organization.id, haltedOrg.orgId));
      await runCycle();
    });

    it("does not alert when a workflow, a new cron or a halted org comes back", async () => {
      // The same writes the enable toggle, a cron save and Reset make.
      backAt = new Date();
      await setEnabled(reenabled, true);
      await syncWorkflowSchedule(reenabled, scheduleNodes("*/5 * * * *"), {
        restart: true,
      });
      await syncWorkflowSchedule(recron, scheduleNodes("*/5 * * * *"));
      const reset = await resetOrgCircuitBreaker({
        organizationId: haltedOrg.orgId,
        requestedByUserId: haltedOrg.userId,
      });
      expect(reset).toEqual({ reset: true, wasHalted: true });
      await runCycle();
      for (const id of [reenabled, recron, unhalted]) {
        expect(await openIncident(id)).toBeUndefined();
      }
    });

    it("still alerts when it then misses a run", async () => {
      await cycle.runFailureAlertCycle(APP, at(16));
      for (const id of [reenabled, recron, unhalted]) {
        const incident = await openIncident(id);
        expect(incident?.openedBy).toBe("missed");
        expect(incident?.firstFailedAt.getTime()).toBeGreaterThan(
          backAt.getTime()
        );
      }
    });
  });

  // Deactivation does not reach workflows.deactivated_at, and halting stops dispatch.
  describe("deactivated and halted orgs", { timeout: SUITE_TIMEOUT }, () => {
    const cases: { org: Org; wf: string; incidentId?: string }[] = [];

    beforeAll(async () => {
      for (const tag of ["deactivated_org", "halted_org"]) {
        const org = await makeOrg(tag);
        const wf = await makeWorkflow(org, `Keeper ${tag}`);
        await addFailures(org, wf, 5);
        cases.push({ org, wf });
      }
      await runCycle();
      for (const item of cases) {
        item.incidentId = (await openIncident(item.wf))?.id;
      }
    });

    it("closes a deactivated org's incident, holds a halted org's quietly, and sends no reminder", async () => {
      expect(cases.every((item) => item.incidentId)).toBe(true);
      const [halted, deactivated] = cases;
      await db
        .update(organization)
        .set({ haltedAt: new Date() })
        .where(eq(organization.id, halted.org.orgId));
      await db
        .update(organization)
        .set({ deactivatedAt: new Date() })
        .where(eq(organization.id, deactivated.org.orgId));
      for (const item of cases) {
        await db
          .update(workflowFailureIncidents)
          .set({ lastNotifiedAt: at(-25 * 60) })
          .where(eq(workflowFailureIncidents.id, item.incidentId ?? ""));
      }
      await runCycle();
      const kept = await incidentById(halted.incidentId);
      expect(kept?.resolvedAt).toBeNull();
      expect((await incidentById(deactivated.incidentId))?.resolvedReason).toBe(
        "disabled"
      );
      for (const item of cases) {
        expect(await sentEmails(item.org, "reminder")).toHaveLength(0);
      }

      // Lifting the halt continues the same incident: no second alert.
      const alertsBefore = (await deliveriesOf(halted.org.orgId)).filter(
        (d) => d.kind === "alert"
      ).length;
      await db
        .update(organization)
        .set({ haltedAt: null })
        .where(eq(organization.id, halted.org.orgId));
      await addFailures(halted.org, halted.wf, 2, -1);
      await runCycle();
      expect((await openIncident(halted.wf))?.id).toBe(halted.incidentId);
      expect(
        (await deliveriesOf(halted.org.orgId)).filter((d) => d.kind === "alert")
      ).toHaveLength(alertsBefore);
    });
  });

  describe("flapping workflows", { timeout: SUITE_TIMEOUT }, () => {
    it("reopens the same incident on a failure inside the recovery hold, with no new alert or page", async () => {
      const org = await makeOrg("flap");
      await db.insert(orgFailureAlertSettings).values({
        organizationId: org.orgId,
        countingSince: at(-24 * 60),
      });
      const pd = await makeChannel(org, "pagerduty", "always", "live");
      const wf = await makeWorkflow(org, "Flapping keeper");
      await addFailures(org, wf, 5, -20);
      await runCycle();
      const first = await openIncident(wf);
      expect(first).toBeTruthy();
      const alerts = (await deliveriesOf(org.orgId)).filter(
        (d) => d.kind === "alert"
      ).length;

      await addRun(org, wf, "success", { at: at(-10) });
      await runCycle();
      expect(await openIncident(wf)).toBeUndefined();
      await addRun(org, wf, "error", { at: at(-5) });
      await runCycle();

      expect((await openIncident(wf))?.id).toBe(first?.id);
      const rows = await deliveriesOf(org.orgId);
      expect(rows.filter((d) => d.kind === "alert")).toHaveLength(alerts);
      const recoveries = rows.filter((d) => d.kind === "recovery");
      expect(recoveries.length).toBeGreaterThan(0);
      expect(recoveries.every((d) => d.state === "skipped")).toBe(true);
      expect(await sentEmails(org, "recovery")).toHaveLength(0);
      const resolves = () =>
        callsTo("events.pagerduty.com/v2/enqueue")
          .map(
            (c) =>
              JSON.parse(c.body) as { event_action: string; dedup_key: string }
          )
          .filter((e) => e.dedup_key === `kh-fa-${first?.id}`);
      expect(
        resolves().filter((e) => e.event_action === "resolve")
      ).toHaveLength(0);

      // Healthy again for the whole hold: one recovery, and the same page resolved.
      await addRun(org, wf, "success", { at: at(-1) });
      await runCycle();
      await endRecoveryHold(org.orgId);
      await runCycle();
      expect(await sentEmails(org, "recovery")).toHaveLength(1);
      const pageResolve = (await deliveriesOf(org.orgId)).find(
        (d) =>
          d.channelId === pd.id && d.kind === "recovery" && d.sequence === 1
      );
      expect(pageResolve?.state, pageResolve?.lastError ?? "").toBe(
        "delivered"
      );
      expect(
        resolves().filter((e) => e.event_action === "resolve")
      ).toHaveLength(1);
      expect(
        resolves().filter((e) => e.event_action === "trigger")
      ).toHaveLength(1);

      // The recovery went out: a later streak is a new incident.
      await addFailures(org, wf, 5, 0);
      await runCycle();
      const next = await openIncident(wf);
      expect(next?.id).toBeTruthy();
      expect(next?.id).not.toBe(first?.id);
    });

    it("opens a new incident when the failure comes after the hold", async () => {
      const org = await makeOrg("flapafter");
      await db.insert(orgFailureAlertSettings).values({
        organizationId: org.orgId,
        countingSince: at(-24 * 60),
      });
      const wf = await makeWorkflow(org, "Settled keeper");
      await addFailures(org, wf, 5, -120);
      await runCycle();
      const first = await openIncident(wf);
      await addRun(org, wf, "success", { at: at(-100) });
      await runCycle();
      await db
        .update(workflowFailureIncidents)
        .set({ resolvedAt: at(-95) })
        .where(eq(workflowFailureIncidents.id, first?.id ?? ""));
      await addRun(org, wf, "error", { at: at(-5) });
      await runCycle();
      expect(await openIncident(wf)).toBeUndefined();
      expect((await incidentById(first?.id))?.resolvedReason).toBe("success");
    });
  });

  describe("platform errors and the time rule", {
    timeout: SUITE_TIMEOUT,
  }, () => {
    let org: Org;

    beforeAll(async () => {
      org = await makeOrg("sys");
      await db.insert(orgFailureAlertSettings).values({
        organizationId: org.orgId,
        threshold: 3,
        timeLimitMinutes: 60,
        countingSince: at(-24 * 60),
      });
    });

    it("steps over our own platform errors: they neither count nor break the streak", async () => {
      const ours = await makeWorkflow(org, "Platform failures");
      await addRun(org, ours, "error", { at: at(-4), errorType: "system" });
      await addRun(org, ours, "error", { at: at(-3), errorType: "system" });
      await addRun(org, ours, "error", { at: at(-2), errorType: "system" });
      await runCycle();
      expect(await openIncident(ours)).toBeUndefined();

      const mixed = await makeWorkflow(org, "Mixed failures");
      await addRun(org, mixed, "error", { at: at(-5), errorType: "user" });
      await addRun(org, mixed, "error", { at: at(-4), errorType: "system" });
      await addRun(org, mixed, "error", { at: at(-3) });
      await addRun(org, mixed, "error", { at: at(-2), errorType: "system" });
      await addRun(org, mixed, "error", { at: at(-1) });
      await runCycle();
      const incident = await openIncident(mixed);
      expect(incident?.openedBy).toBe("count");
      expect(incident?.failureCount).toBe(3);
    });

    it("needs two failures for the time rule, and never turns the workflow off for it", async () => {
      const once = await makeWorkflow(org, "One slow failure");
      await addRun(org, once, "error", { at: at(-120) });
      await runCycle();
      expect(await openIncident(once)).toBeUndefined();

      const twice = await makeWorkflow(org, "Two slow failures");
      await db.insert(workflowFailureAlertOverrides).values({
        workflowId: twice,
        organizationId: org.orgId,
        pauseWorkflow: true,
      });
      await addRun(org, twice, "error", { at: at(-120) });
      await addRun(org, twice, "error", { at: at(-30) });
      await runCycle();
      const incident = await openIncident(twice);
      expect(incident?.openedBy).toBe("time");
      expect(incident?.workflowPausedAt).toBeNull();
      expect(await isEnabled(twice)).toBe(true);
    });
  });

  describe("stale deliveries", { timeout: SUITE_TIMEOUT }, () => {
    it("drops rows queued over an hour ago and their backups, but retries younger ones", async () => {
      const org = await makeOrg("stale");
      const insert = async (
        tag: string,
        patch: Partial<typeof failureAlertDeliveries.$inferInsert>
      ): Promise<string> => {
        const id = nextId("delivery_");
        await db.insert(failureAlertDeliveries).values({
          id,
          organizationId: org.orgId,
          kind: "alerts_resumed",
          sequence: 0,
          channel: "email",
          recipient: org.email,
          dedupKey: `${id}-${tag}`,
          ...patch,
        });
        return id;
      };
      const old = await insert("old", {
        state: "retrying",
        attempts: 3,
        createdAt: at(-61),
        nextAttemptAt: at(-1),
      });
      const young = await insert("young", {
        state: "retrying",
        attempts: 2,
        createdAt: at(-50),
        nextAttemptAt: at(-1),
      });
      const failedOld = await insert("failedold", {
        kind: "alert",
        state: "failed",
        attempts: 1,
        createdAt: at(-61),
        nextAttemptAt: at(-61),
        backupAt: at(-46),
      });
      await runCycle();
      const rows = await deliveriesOf(org.orgId);
      const byId = (id: string) => rows.find((d) => d.id === id);
      expect(byId(old)?.state).toBe("skipped");
      expect(byId(old)?.lastError).toBe(SKIP_REASON.stale);
      expect(byId(young)?.state).toBe("delivered");
      expect(byId(failedOld)?.backupSentAt).not.toBeNull();
      expect(rows.filter((d) => d.isBackup)).toHaveLength(0);
    });
  });

  describe("orgs outside the rollout", { timeout: SUITE_TIMEOUT }, () => {
    let sigma: Org;
    let dead: Channel;
    let rowId: string;
    let queued: string;

    beforeAll(async () => {
      sigma = await makeOrg("sigma");
      dead = await makeChannel(sigma, "discord", "always", "dead", {
        checked: false,
      });
      queued = await makeWorkflow(sigma, "Outside Keeper");
      rowId = nextId("delivery_");
      await db.insert(failureAlertDeliveries).values({
        id: rowId,
        organizationId: sigma.orgId,
        kind: "alerts_resumed",
        sequence: 0,
        channel: "email",
        recipient: sigma.email,
        dedupKey: `${rowId}-outside`,
        state: "pending",
        nextAttemptAt: at(-1),
      });
      await db
        .insert(workflowFailureAlertQueue)
        .values({ workflowId: queued, dueAt: at(-60) })
        .onConflictDoUpdate({
          target: workflowFailureAlertQueue.workflowId,
          set: { dueAt: at(-60) },
        });
      leaveRollout(sigma);
    });

    it("sends nothing, health-checks nothing and drops its queued work", async () => {
      await runCycle();
      const [row] = await db
        .select()
        .from(failureAlertDeliveries)
        .where(eq(failureAlertDeliveries.id, rowId));
      expect(row?.state).toBe("skipped");
      expect(mailsTo(sigma)).toHaveLength(0);
      const channel = await channelById(dead.id);
      expect(channel?.lastHealthCheckAt).toBeNull();
      expect(channel?.pausedAt).toBeNull();
      expect(callsTo(dead.token)).toHaveLength(0);
      const left = await db
        .select()
        .from(workflowFailureAlertQueue)
        .where(eq(workflowFailureAlertQueue.workflowId, queued));
      expect(left).toHaveLength(0);
    });

    it("while the rollout is off, clears due queue rows so no backlog waits for it", async () => {
      await db
        .insert(workflowFailureAlertQueue)
        .values({ workflowId: queued, dueAt: at(-60) })
        .onConflictDoUpdate({
          target: workflowFailureAlertQueue.workflowId,
          set: { dueAt: at(-60) },
        });
      setEnv("FAILURE_ALERTS_ROLLOUT", "off");
      try {
        const report = await runCycle();
        expect(report.disabled).toBe(true);
        expect(report.errors).toEqual([]);
      } finally {
        setEnv("FAILURE_ALERTS_ROLLOUT", `orgs:${orgIds.join(",")}`);
      }
      const left = await db
        .select()
        .from(workflowFailureAlertQueue)
        .where(eq(workflowFailureAlertQueue.workflowId, queued));
      expect(left).toHaveLength(0);
    });
  });

  // Steps run in order and share one org; each story has its own workflow.
  describe("workflow auto-pause and resume", { timeout: SUITE_TIMEOUT }, () => {
    let eta: Org;
    let wf: string;
    let lateWf: string;
    let pausedIncidentId: string | undefined;
    let lateIncidentId: string | undefined;

    beforeAll(async () => {
      eta = await makeOrg("eta");
      wf = await makeWorkflow(eta, "Auto Pause Keeper");
      await db.insert(workflowFailureAlertOverrides).values({
        workflowId: wf,
        organizationId: eta.orgId,
        threshold: 2,
        pauseWorkflow: true,
      });
      // Starts the org's count before any failure.
      await runCycle();
    });

    it("turns the workflow off at its limit and the alert says so", async () => {
      await addRun(eta, wf, "error", { at: at(-3) });
      await addRun(eta, wf, "error", { at: at(-2) });
      await runCycle();
      const incident = await openIncident(wf);
      pausedIncidentId = incident?.id;
      expect(await isEnabled(wf)).toBe(false);
      expect(incident?.workflowPausedAt).toBeTruthy();
      const [alert] = mailsAbout(eta, "Auto Pause Keeper");
      expect(alert?.subject).toMatch(PAUSED_WORDING);
    });

    it("writes the pause to the audit log", async () => {
      const [audit] = await db
        .select()
        .from(securityAuditLog)
        .where(
          and(
            eq(securityAuditLog.resourceId, wf),
            eq(securityAuditLog.action, "workflow.paused_by_failure_alerts")
          )
        );
      expect(audit).toBeDefined();
    });

    it("keeps the incident open while the workflow is off", async () => {
      await runCycle();
      expect((await openIncident(wf))?.id).toBe(pausedIncidentId);
    });

    it("one failure after turning it back on does not pause it again", async () => {
      await setEnabled(wf, true);
      await addRun(eta, wf, "error", { at: at(0.1) });
      await runCycle();
      expect(await isEnabled(wf)).toBe(true);
    });

    it("still failing after turning it back on: paused again, and told", async () => {
      const before = mailsAbout(eta, "Auto Pause Keeper").length;
      await addRun(eta, wf, "error", { at: at(0.2) });
      await runCycle();
      expect(await isEnabled(wf)).toBe(false);
      const about = mailsAbout(eta, "Auto Pause Keeper");
      expect(about).toHaveLength(before + 1);
      expect(about.at(-1)?.subject).toMatch(PAUSED_WORDING);
    });

    it("fixed and turned back on: the incident resolves as a recovery", async () => {
      await setEnabled(wf, true);
      await addRun(eta, wf, "success", { at: at(0.3) });
      await runCycle();
      expect((await incidentById(pausedIncidentId))?.resolvedReason).toBe(
        "success"
      );
    });

    it("alerts without pausing when the pause option is off", async () => {
      lateWf = await makeWorkflow(eta, "Late Pause Keeper");
      for (const m of [6, 5, 4, 3, 2]) {
        await addRun(eta, lateWf, "error", { at: at(-m) });
      }
      await runCycle();
      expect(await isEnabled(lateWf)).toBe(true);
      lateIncidentId = (await openIncident(lateWf))?.id;
      expect(lateIncidentId).toBeDefined();
    });

    it("ticking pause after the alert pauses the still-failing workflow and says so", async () => {
      const before = mailsAbout(eta, "Late Pause Keeper").length;
      await db.insert(workflowFailureAlertOverrides).values({
        workflowId: lateWf,
        organizationId: eta.orgId,
        pauseWorkflow: true,
      });
      await addRun(eta, lateWf, "error", { at: at(0.4) });
      await runCycle();
      expect(await isEnabled(lateWf)).toBe(false);
      const about = mailsAbout(eta, "Late Pause Keeper");
      expect(about).toHaveLength(before + 1);
      expect(about.at(-1)?.subject).toMatch(PAUSED_WORDING);
    });

    it("records turning it back on in the database", async () => {
      await setEnabled(lateWf, true);
      expect(
        (await incidentById(lateIncidentId))?.workflowResumedAt
      ).toBeTruthy();
    });

    it("turned back on, then off by hand: the incident closes like any paused workflow", async () => {
      await setEnabled(lateWf, false);
      await runCycle();
      expect((await incidentById(lateIncidentId))?.resolvedReason).toBe(
        "disabled"
      );
    });
  });

  // Steps run in order and share one org.
  describe("org-wide pause", { timeout: SUITE_TIMEOUT }, () => {
    let iota: Org;
    let wf: string;

    beforeAll(async () => {
      iota = await makeOrg("iota");
      wf = await makeWorkflow(iota, "Maintenance Keeper");
      await runCycle();
    });

    it("tells people about the pause, with the reason", async () => {
      await orgPause.pauseOrgAlerts({
        organizationId: iota.orgId,
        until: at(60).toISOString(),
        reason: "Vault upgrade",
        by: "An owner",
        now: new Date(),
      });
      await runCycle();
      expect(await sentEmails(iota, "alerts_paused")).toHaveLength(1);
      expect(mailsTo(iota).some((m) => m.text.includes("Vault upgrade"))).toBe(
        true
      );
    });

    it("alerts nothing while paused", async () => {
      for (const m of [5, 4, 3, 2, 1]) {
        await addRun(iota, wf, "error", { at: at(-m) });
      }
      await runCycle();
      expect(await sentEmails(iota, "alert")).toHaveLength(0);
      expect(await openIncident(wf)).toBeUndefined();
    });

    it("on resume says so and reports what kept failing", async () => {
      await orgPause.resumeOrgAlerts({
        organizationId: iota.orgId,
        by: "An owner",
        now: new Date(),
      });
      await runCycle();
      expect(await sentEmails(iota, "alerts_resumed")).toHaveLength(1);
      expect(await openIncident(wf)).toBeDefined();
      expect(await sentEmails(iota, "alert")).toHaveLength(1);
      expect(mailsAbout(iota, "Maintenance Keeper").length).toBeGreaterThan(0);
    });

    it("shows the account a pause came from, a wallet as its address", async () => {
      const org = await makeOrg("pauseacct");
      const walletId = nextId("user_pauseacct_wallet_");
      const address = `0x${"7".repeat(40)}`;
      await db.insert(users).values({
        id: walletId,
        name: "Wallet admin",
        email: `${address}@wallet.keeperhub.com`,
        emailVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.insert(member).values({
        id: nextId("member_"),
        organizationId: org.orgId,
        userId: walletId,
        role: "admin",
        createdAt: new Date(),
      });
      await orgPause.pauseOrgAlerts({
        organizationId: org.orgId,
        until: at(60).toISOString(),
        reason: null,
        by: "Wallet admin",
        byUserId: walletId,
        now: new Date(),
      });
      await orgPause.resumeOrgAlerts({
        organizationId: org.orgId,
        by: "Owner",
        byUserId: org.userId,
        now: new Date(),
      });
      const { entries } = await settings.loadHistory(org.orgId, { page: 1 });
      const paused = entries.find((e) => e.kind === "alerts_paused");
      const resumed = entries.find((e) => e.kind === "alerts_resumed");
      expect(paused?.by).toBe("Wallet admin");
      expect(paused?.byAccount).toBe(address);
      expect(resumed?.byAccount).toBe(org.email);
    });

    it("stores the reason as one line without control or bidi characters", async () => {
      const org = await makeOrg("reasonclean");
      await orgPause.pauseOrgAlerts({
        organizationId: org.orgId,
        until: at(60).toISOString(),
        reason: "Vault\u202e upgrade\n\tnow",
        by: null,
        now: new Date(),
      });
      const [row] = await db
        .select({ reason: orgFailureAlertSettings.pauseReason })
        .from(orgFailureAlertSettings)
        .where(eq(orgFailureAlertSettings.organizationId, org.orgId));
      expect(row?.reason).toBe("Vault upgrade now");
    });

    it("allows 5 pauses an hour, then refuses more but still resumes", async () => {
      const org = await makeOrg("pauselimit");
      const pause = () =>
        orgPause.pauseOrgAlerts({
          organizationId: org.orgId,
          until: at(60).toISOString(),
          reason: null,
          by: null,
          now: new Date(),
        });
      for (let i = 0; i < 5; i++) {
        await pause();
      }
      const error = await settingsError(pause);
      expect(error.status).toBe(429);
      expect(error.message).toContain("5 times in the last hour");
      await orgPause.resumeOrgAlerts({
        organizationId: org.orgId,
        by: null,
        now: new Date(),
      });
      const [row] = await db
        .select({ until: orgFailureAlertSettings.pausedUntil })
        .from(orgFailureAlertSettings)
        .where(eq(orgFailureAlertSettings.organizationId, org.orgId));
      expect(row?.until).toBeNull();
    });

    it("pauses sent at once still stop at 5 an hour", async () => {
      const org = await makeOrg("pauserace");
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () =>
          orgPause.pauseOrgAlerts({
            organizationId: org.orgId,
            until: at(60).toISOString(),
            reason: null,
            by: null,
            now: new Date(),
          })
        )
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    });

    it("refuses a pause longer than 7 days", async () => {
      const error = await settingsError(() =>
        orgPause.pauseOrgAlerts({
          organizationId: iota.orgId,
          until: at(8 * 24 * 60).toISOString(),
          reason: null,
          by: null,
          now: new Date(),
        })
      );
      expect(error.status).toBe(400);
      expect(error.message).toContain("7 days");
    });
  });

  // Steps run in order and share one org; its workflow turns off at its limit.
  describe("messages held by an org pause", { timeout: SUITE_TIMEOUT }, () => {
    let lambda: Org;
    let wf: string;
    let until: Date;
    let incidentId: string | undefined;

    const heldRows = async () =>
      (await deliveriesOf(lambda.orgId)).filter(
        (d) => d.incidentId === incidentId && !d.isBackup
      );

    beforeAll(async () => {
      lambda = await makeOrg("lambda");
      wf = await makeWorkflow(lambda, "Held Keeper");
      await db.insert(workflowFailureAlertOverrides).values({
        workflowId: wf,
        organizationId: lambda.orgId,
        threshold: 2,
        pauseWorkflow: true,
      });
      until = at(60);
      await orgPause.pauseOrgAlerts({
        organizationId: lambda.orgId,
        until: until.toISOString(),
        reason: null,
        by: "An owner",
        now: new Date(),
      });
    });

    afterAll(() => {
      emailStatus = 202;
    });

    it("turns the workflow off and holds its message until the pause ends", async () => {
      await addRun(lambda, wf, "error", { at: at(-2) });
      await addRun(lambda, wf, "error", { at: at(-1) });
      await runCycle();
      incidentId = (await openIncident(wf))?.id;
      expect(await isEnabled(wf)).toBe(false);
      const rows = await heldRows();
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.state).toBe("pending");
        expect(row.nextAttemptAt.getTime()).toBe(until.getTime());
      }
    });

    it("the pause notice counts the workflows set to turn off", async () => {
      const notice = (await deliveriesOf(lambda.orgId)).find(
        (d) => d.kind === "alerts_paused"
      );
      expect(notice?.context?.pausingWorkflows).toBe(1);
    });

    it("extending the pause keeps them held until the new end", async () => {
      until = at(120);
      await orgPause.pauseOrgAlerts({
        organizationId: lambda.orgId,
        until: until.toISOString(),
        reason: null,
        by: "An owner",
        now: new Date(),
      });
      await runCycle();
      expect(await sentEmails(lambda, "alert")).toHaveLength(0);
      for (const row of await heldRows()) {
        expect(row.nextAttemptAt.getTime()).toBe(until.getTime());
        expect(row.backupAt?.getTime()).toBe(until.getTime() + 15 * MINUTE);
      }
    });

    it("refuses an extension past 7 days from when the pause began", async () => {
      const [settingsRow] = await db
        .select()
        .from(orgFailureAlertSettings)
        .where(eq(orgFailureAlertSettings.organizationId, lambda.orgId));
      const began = settingsRow?.pausedAt?.getTime() ?? 0;
      expect(began).toBeGreaterThan(0);
      const error = await settingsError(() =>
        orgPause.pauseOrgAlerts({
          organizationId: lambda.orgId,
          until: new Date(
            began + 7 * 24 * 60 * MINUTE + 30 * MINUTE
          ).toISOString(),
          reason: null,
          by: null,
          now: at(90),
        })
      );
      expect(error.status).toBe(400);
      expect(error.message).toContain("7 days");
    });

    it("resumed early, they go now, retry a passing error, and backups wait their usual time", async () => {
      // As if the pause had held them for over a day.
      await db
        .update(failureAlertDeliveries)
        .set({ createdAt: at(-25 * 60) })
        .where(eq(failureAlertDeliveries.incidentId, incidentId ?? ""));
      await orgPause.resumeOrgAlerts({
        organizationId: lambda.orgId,
        by: "An owner",
        now: new Date(),
      });
      emailStatus = 503;
      await runCycle();
      const email = (await heldRows()).find((d) => d.channel === "email");
      expect(email?.state, email?.lastError ?? "").toBe("retrying");
      expect(email?.backupSentAt).toBeNull();
      expect(email?.backupAt?.getTime()).toBeGreaterThan(at(10).getTime());
    });
  });

  // Independent cases, each with its own paused org.
  describe("nothing leaks out of an org pause", {
    timeout: SUITE_TIMEOUT,
  }, () => {
    const pause = async (org: Org, until: Date): Promise<void> => {
      await orgPause.pauseOrgAlerts({
        organizationId: org.orgId,
        until: until.toISOString(),
        reason: null,
        by: null,
        now: new Date(),
      });
    };

    it("an alert re-queued after a crash waits for the pause to end", async () => {
      const nu = await makeOrg("nu_requeue");
      const until = at(60);
      await pause(nu, until);
      const lostWf = await makeWorkflow(nu, "Lost during pause");
      const [lost] = await db
        .insert(workflowFailureIncidents)
        .values({
          organizationId: nu.orgId,
          workflowId: lostWf,
          openedBy: "count",
          threshold: 5,
          failureCount: 5,
          firstFailedAt: at(-30),
          lastFailedAt: at(-6),
          openedAt: at(-5),
        })
        .returning();
      await runCycle();
      expect((await incidentById(lost?.id))?.alertQueuedAt).toBeTruthy();
      const rows = (await deliveriesOf(nu.orgId)).filter(
        (d) => d.incidentId === lost?.id
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.nextAttemptAt.getTime()).toBe(until.getTime());
      }
      expect(await sentEmails(nu, "alert")).toHaveLength(0);
    });

    it("with nobody to email, backups wait for the pause to end", async () => {
      const xi = await makeOrg("xi", { walletOnly: true });
      const discord = await makeChannel(xi, "discord", "backup", "live");
      const wf = await makeWorkflow(xi, "Unreachable during pause");
      await db.insert(workflowFailureAlertOverrides).values({
        workflowId: wf,
        organizationId: xi.orgId,
        threshold: 2,
        pauseWorkflow: true,
      });
      await pause(xi, at(60));
      await addRun(xi, wf, "error", { at: at(-2) });
      await addRun(xi, wf, "error", { at: at(-1) });
      await runCycle();
      const incidentId = (await openIncident(wf))?.id;
      expect(incidentId).toBeTruthy();
      const forIncident = async () =>
        (await deliveriesOf(xi.orgId)).filter(
          (d) => d.incidentId === incidentId
        );
      const nobody = (await forIncident()).find(
        (d) => d.recipient === "(nobody reachable)"
      );
      expect(nobody?.backupSentAt).toBeNull();
      expect((await forIncident()).some((d) => d.isBackup)).toBe(false);

      await orgPause.resumeOrgAlerts({
        organizationId: xi.orgId,
        by: null,
        now: new Date(),
      });
      await runCycle();
      const backup = (await forIncident()).find(
        (d) => d.isBackup && d.channelId === discord.id
      );
      expect(backup?.state, backup?.lastError ?? "").toBe("delivered");
    });
  });

  // Each case builds its own body against one org.
  describe("settings save rules", { timeout: SUITE_TIMEOUT }, () => {
    let zeta: Org;
    let orphan: Channel;
    let base: Record<string, unknown>;

    beforeAll(async () => {
      zeta = await makeOrg("zeta");
      orphan = await makeChannel(zeta, "telegram", "always", "live");
      await db
        .delete(integrations)
        .where(eq(integrations.id, orphan.integrationId));
      base = {
        threshold: 4,
        recipientUserIds: [zeta.userId],
        channels: [
          {
            id: orphan.id,
            integrationId: orphan.integrationId,
            destination: orphan.destination,
            role: "always",
          },
        ],
      };
    });

    it("a method whose connection was deleted does not block other changes", async () => {
      await settings.saveOrgSettings(
        zeta.orgId,
        await settings.parseOrgSettings(base, zeta.orgId),
        zeta.userId
      );
      const [row] = await db
        .select()
        .from(orgFailureAlertSettings)
        .where(eq(orgFailureAlertSettings.organizationId, zeta.orgId));
      expect(row?.threshold).toBe(4);
      expect(await channelById(orphan.id)).toBeDefined();
    });

    it("refuses a new target that cannot receive notifications", async () => {
      const integrationId = await makeConnection(zeta, "telegram", "dead");
      const error = await settingsError(() =>
        settings.parseOrgSettings(
          {
            ...base,
            channels: [
              ...(base.channels as unknown[]),
              { integrationId, destination: "-100777", role: "always" },
            ],
          },
          zeta.orgId
        )
      );
      expect(error.status).toBe(400);
      expect(error.message).toBeTruthy();
    });

    it("accepts a new target whose silent check passes", async () => {
      const integrationId = await makeConnection(zeta, "discord", "live");
      const parsed = await settings.parseOrgSettings(
        {
          ...base,
          channels: [
            ...(base.channels as unknown[]),
            { integrationId, destination: "", role: "backup" },
          ],
        },
        zeta.orgId
      );
      expect(parsed.channels?.map((c) => c.kind)).toContain("discord");
    });

    it("refuses an empty recipient list", async () => {
      const error = await settingsError(() =>
        settings.parseOrgSettings({ ...base, recipientUserIds: [] }, zeta.orgId)
      );
      expect(error.status).toBe(400);
    });

    it("refuses an org save made from a stale copy with 409", async () => {
      const [row] = await db
        .select({ version: orgFailureAlertSettings.version })
        .from(orgFailureAlertSettings)
        .where(eq(orgFailureAlertSettings.organizationId, zeta.orgId));
      const loaded = row?.version ?? 0;
      await settings.saveOrgSettings(
        zeta.orgId,
        await settings.parseOrgSettings(
          { ...base, version: loaded },
          zeta.orgId
        ),
        zeta.userId
      );
      const error = await settingsError(async () =>
        settings.saveOrgSettings(
          zeta.orgId,
          await settings.parseOrgSettings(
            { ...base, threshold: 6, version: loaded },
            zeta.orgId
          ),
          zeta.userId
        )
      );
      expect(error.status).toBe(409);
      const [after] = await db
        .select()
        .from(orgFailureAlertSettings)
        .where(eq(orgFailureAlertSettings.organizationId, zeta.orgId));
      expect(after?.threshold).toBe(4);
    });

    it("refuses a workflow override saved from a stale copy with 409", async () => {
      const wf = await makeWorkflow(zeta, "Override keeper");
      await workflowSettings.saveWorkflowOverride({
        workflowId: wf,
        organizationId: zeta.orgId,
        userId: zeta.userId,
        body: { threshold: 3, version: 0 },
      });
      const error = await settingsError(() =>
        workflowSettings.saveWorkflowOverride({
          workflowId: wf,
          organizationId: zeta.orgId,
          userId: zeta.userId,
          body: { threshold: 8, version: 0 },
        })
      );
      expect(error.status).toBe(409);
      const [row] = await db
        .select()
        .from(workflowFailureAlertOverrides)
        .where(eq(workflowFailureAlertOverrides.workflowId, wf));
      expect(row?.threshold).toBe(3);
    });

    it("says a workflow save changed its rules only when the evaluator reads the change", async () => {
      const wf = await makeWorkflow(zeta, "Requeue keeper");
      let version = 0;
      const save = async (body: Record<string, unknown>) => {
        const result = await workflowSettings.saveWorkflowOverride({
          workflowId: wf,
          organizationId: zeta.orgId,
          userId: zeta.userId,
          body: { ...body, version },
        });
        version += 1;
        return result.rulesChanged;
      };
      expect(await save({ threshold: 3 })).toBe(true);
      expect(
        await save({ threshold: 3, recipientUserIds: [zeta.userId] })
      ).toBe(false);
      expect(
        await save({ threshold: 4, recipientUserIds: [zeta.userId] })
      ).toBe(true);
      expect(
        await save({
          threshold: 4,
          recipientUserIds: [zeta.userId],
          pauseWorkflow: true,
        })
      ).toBe(true);
    });

    it("refuses a save from a tab older than a reset with 409", async () => {
      const wf = await makeWorkflow(zeta, "Reset keeper");
      const save = (body: Record<string, unknown>) =>
        workflowSettings.saveWorkflowOverride({
          workflowId: wf,
          organizationId: zeta.orgId,
          userId: zeta.userId,
          body,
        });
      await save({ threshold: 3, version: 0 });
      await save({ version: 1 });
      const error = await settingsError(() =>
        save({ threshold: 8, version: 1 })
      );
      expect(error.status).toBe(409);
      const [row] = await db
        .select()
        .from(workflowFailureAlertOverrides)
        .where(eq(workflowFailureAlertOverrides.workflowId, wf));
      expect(row?.threshold).toBeNull();
      expect(row?.version).toBe(2);
      const view = await settings.loadOrgSettingsView(zeta.orgId, zeta.userId);
      expect(view.customWorkflows.some((w) => w.id === wf)).toBe(false);
    });

    it("ends a mute until it works once it works, as a new version", async () => {
      const wf = await makeWorkflow(zeta, "Mute until works");
      await db.insert(workflowFailureAlertOverrides).values({
        workflowId: wf,
        organizationId: zeta.orgId,
        muteUntilSuccess: true,
        mutedUntil: at(6 * 24 * 60),
        mutedBy: zeta.userId,
        // Muted an hour ago, so the success below clearly comes after it.
        mutedAt: at(-60),
        updatedAt: at(-60),
        version: 3,
      });
      await addRun(zeta, wf, "success");
      await runCycle();
      const [row] = await db
        .select()
        .from(workflowFailureAlertOverrides)
        .where(eq(workflowFailureAlertOverrides.workflowId, wf));
      expect(row?.muteUntilSuccess).toBe(false);
      expect(row?.mutedUntil).toBeNull();
      expect(row?.version).toBe(4);
    });

    it("a save without channels keeps them; only an explicit [] clears them", async () => {
      const org = await makeOrg("keepchannels");
      const kept = await makeChannel(org, "discord", "always", "live");
      const body = { threshold: 3, recipientUserIds: [org.userId] };
      await settings.saveOrgSettings(
        org.orgId,
        await settings.parseOrgSettings(body, org.orgId),
        org.userId
      );
      expect(await channelById(kept.id)).toBeDefined();
      await settings.saveOrgSettings(
        org.orgId,
        await settings.parseOrgSettings({ ...body, channels: [] }, org.orgId),
        org.userId
      );
      expect(await channelById(kept.id)).toBeUndefined();
    });

    it("a workflow save with its own channels but no list keeps that list", async () => {
      const org = await makeOrg("keepwfchannels");
      const wf = await makeWorkflow(org, "Own channels");
      const integrationId = await makeConnection(org, "discord", "live");
      const save = (body: Record<string, unknown>) =>
        workflowSettings.saveWorkflowOverride({
          workflowId: wf,
          organizationId: org.orgId,
          userId: org.userId,
          body,
        });
      await save({
        customChannels: true,
        channels: [{ integrationId, destination: "", role: "always" }],
      });
      await save({ customChannels: true, threshold: 2 });
      const rows = await db
        .select()
        .from(failureAlertChannels)
        .where(eq(failureAlertChannels.workflowId, wf));
      expect(rows).toHaveLength(1);
    });

    it("refuses more than 20 channels before checking any of them", async () => {
      const integrationId = await makeConnection(zeta, "telegram", "live");
      const before = providers.calls.length;
      const error = await settingsError(() =>
        settings.parseOrgSettings(
          {
            ...base,
            channels: Array.from({ length: 21 }, (_, i) => ({
              integrationId,
              destination: `-100${String(i).padStart(4, "0")}`,
              role: "always",
            })),
          },
          zeta.orgId
        )
      );
      expect(error.status).toBe(400);
      expect(providers.calls.length).toBe(before);
    });

    it("leaves deactivated accounts out of members and default recipients", async () => {
      // The owner is the default recipient; deactivating that account must drop it.
      const org = await makeOrg("deactivated");
      const adminId = nextId("user_admin_");
      await db.insert(users).values({
        id: adminId,
        name: "active admin",
        email: `admin-${RUN}@failure-alerts.test`,
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.insert(member).values({
        id: nextId("member_"),
        organizationId: org.orgId,
        userId: adminId,
        role: "admin",
        createdAt: new Date(),
      });
      await db
        .update(users)
        .set({ deactivatedAt: new Date() })
        .where(eq(users.id, org.userId));
      const view = await settings.loadOrgSettingsView(org.orgId, adminId);
      expect(view.members.map((m) => m.userId)).toEqual([adminId]);
      expect(view.recipientUserIds).not.toContain(org.userId);
    });
  });

  describe("Undo pause", { timeout: SUITE_TIMEOUT }, () => {
    it("a paused method put back by Undo comes back paused, without a new check", async () => {
      const org = await makeOrg("undo");
      const integrationId = await makeConnection(org, "discord", "dead");
      const reason = "Discord said the webhook is gone.";
      await settings.saveOrgSettings(
        org.orgId,
        await settings.parseOrgSettings(
          {
            threshold: 5,
            recipientUserIds: [org.userId],
            channels: [
              {
                integrationId,
                destination: "",
                role: "always",
                pausedReason: reason,
              },
            ],
          },
          org.orgId
        ),
        org.userId
      );
      const [restored] = await db
        .select()
        .from(failureAlertChannels)
        .where(
          and(
            eq(failureAlertChannels.organizationId, org.orgId),
            eq(failureAlertChannels.integrationId, integrationId)
          )
        );
      expect(restored?.pausedAt).toBeTruthy();
      // The browser's text is not stored: it could say anything.
      expect(restored?.pausedReason).toBe("It was paused when it was removed");
    });

    it("shows a wallet member's step-up inbox only to that member", async () => {
      const org = await makeOrg("stepup");
      const walletId = nextId("user_stepup_wallet_");
      const walletLogin = `0x${"5".repeat(40)}@wallet.keeperhub.com`;
      const inbox = `stepup-private-${RUN}@failure-alerts.test`;
      await db.insert(users).values({
        id: walletId,
        name: "wallet member",
        email: walletLogin,
        emailVerified: false,
        stepUpEmail: inbox,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.insert(member).values({
        id: nextId("member_"),
        organizationId: org.orgId,
        userId: walletId,
        role: "member",
        createdAt: new Date(),
      });
      const asOwner = await settings.loadOrgSettingsView(org.orgId, org.userId);
      const seen = asOwner.members.find((m) => m.userId === walletId);
      expect(seen?.email).toBe(walletLogin);
      expect(seen?.reachable).toBe(true);
      expect(JSON.stringify(asOwner)).not.toContain(inbox);
      const asSelf = await settings.loadOrgSettingsView(org.orgId, walletId);
      expect(asSelf.members.find((m) => m.userId === walletId)?.email).toBe(
        inbox
      );
    });

    it("never lets the Sent alerts To filter or a Test reveal a step-up inbox", async () => {
      const org = await makeOrg("stepupfilter");
      const walletId = nextId("user_stepupf_wallet_");
      const walletLogin = `0x${"6".repeat(40)}@wallet.keeperhub.com`;
      const inbox = `stepupf-private-${RUN}@failure-alerts.test`;
      await db.insert(users).values({
        id: walletId,
        name: "wallet member",
        email: walletLogin,
        emailVerified: false,
        stepUpEmail: inbox,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.insert(member).values({
        id: nextId("member_"),
        organizationId: org.orgId,
        userId: walletId,
        role: "member",
        createdAt: new Date(),
      });
      const deliveryId = nextId("delivery_");
      await db.insert(failureAlertDeliveries).values({
        id: deliveryId,
        organizationId: org.orgId,
        kind: "alert",
        channel: "email",
        recipient: inbox,
        dedupKey: `${deliveryId}-stepup`,
        state: "failed",
        // Provider text that echoes the address, in another case.
        lastError: `Mailbox ${inbox.toUpperCase()} is full`,
      });
      const [logged] = (
        await settings.loadHistory(org.orgId, { page: 1, limit: 50 })
      ).entries.filter((e) => e.id === deliveryId);
      expect(logged?.lastError).toBe(`Mailbox ${walletLogin} is full`);
      const to = async (term: string) =>
        (await settings.loadHistory(org.orgId, { page: 1, to: term })).entries;
      expect(await to("stepupf-private")).toHaveLength(0);
      expect(await to(inbox)).toHaveLength(0);
      const byLogin = await to(walletLogin.slice(0, 12));
      expect(byLogin.map((e) => e.id)).toEqual([deliveryId]);
      expect(byLogin[0]?.recipient).toBe(walletLogin);

      const result = await testSend.sendTest({
        organizationId: org.orgId,
        userId: org.userId,
        request: {
          channel: "email",
          to: "recipients",
          recipientUserIds: [walletId],
        },
      });
      expect(result.recipients).toEqual([walletLogin]);
      expect(JSON.stringify(result)).not.toContain(inbox);
    });

    async function addPerson(
      org: Org,
      role: "admin" | "member",
      label: string
    ): Promise<string> {
      const id = nextId(`user_${label}_`);
      await db.insert(users).values({
        id,
        name: label,
        email: `${label}-${RUN}@failure-alerts.test`,
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.insert(member).values({
        id: nextId("member_"),
        organizationId: org.orgId,
        userId: id,
        role,
        createdAt: new Date(),
      });
      return id;
    }

    it("starts a new org at 3 failed runs, emailing the owner", async () => {
      const org = await makeOrg("defaults");
      const view = await settings.loadOrgSettingsView(org.orgId, org.userId);
      expect(view.threshold).toBe(3);
      expect(view.recipientUserIds).toEqual([org.userId]);
      expect(view.recipientsAreDefault).toBe(true);
      // A settings row created later gets the same default.
      await orgPause.pauseOrgAlerts({
        organizationId: org.orgId,
        until: new Date(Date.now() + 3_600_000).toISOString(),
        reason: null,
        by: "defaults owner",
        byUserId: org.userId,
        now: new Date(),
      });
      const [row] = await db
        .select({ threshold: orgFailureAlertSettings.threshold })
        .from(orgFailureAlertSettings)
        .where(eq(orgFailureAlertSettings.organizationId, org.orgId));
      expect(row?.threshold).toBe(3);
    });

    it("keeps an owner or admin on the email list, for the org and a workflow", async () => {
      const org = await makeOrg("managers");
      const adminId = await addPerson(org, "admin", "mgradmin");
      const memberId = await addPerson(org, "member", "mgrmember");
      const parse = (ids: string[]) =>
        settings.parseOrgSettings(
          { threshold: 3, recipientUserIds: ids, version: 0 },
          org.orgId
        );
      const onlyMember = await settingsError(() => parse([memberId]));
      expect(onlyMember.status).toBe(400);
      expect(onlyMember.message).toContain("owner or admin");
      // The owner can be taken off as long as an admin stays.
      expect((await parse([adminId, memberId])).recipientUserIds).toEqual([
        adminId,
        memberId,
      ]);
      const wf = await makeWorkflow(org, "Manager keeper");
      const ownList = await settingsError(() =>
        workflowSettings.saveWorkflowOverride({
          workflowId: wf,
          organizationId: org.orgId,
          userId: org.userId,
          body: { recipientUserIds: [memberId], version: 0 },
        })
      );
      expect(ownList.message).toContain("owner or admin");
    });

    it("gives alerts back to the owners when the chosen people leave", async () => {
      const org = await makeOrg("leavers");
      const adminId = await addPerson(org, "admin", "leaveadmin");
      const memberId = await addPerson(org, "member", "leavemember");
      const save = async (ids: string[]) => {
        const [row] = await db
          .select({ version: orgFailureAlertSettings.version })
          .from(orgFailureAlertSettings)
          .where(eq(orgFailureAlertSettings.organizationId, org.orgId));
        await settings.saveOrgSettings(
          org.orgId,
          await settings.parseOrgSettings(
            { threshold: 3, recipientUserIds: ids, version: row?.version ?? 0 },
            org.orgId
          ),
          org.userId
        );
      };
      const leave = (userId: string) =>
        db
          .delete(member)
          .where(
            and(eq(member.organizationId, org.orgId), eq(member.userId, userId))
          );
      // The only recipient leaves: the owner gets them again.
      await save([adminId]);
      await leave(adminId);
      let view = await settings.loadOrgSettingsView(org.orgId, org.userId);
      expect(view.recipientUserIds).toEqual([org.userId]);
      expect(view.recipientsAreDefault).toBe(true);
      expect(
        policy.resolveRecipientEmails(
          [adminId],
          await orgRecipients.loadOrgMembers(org.orgId)
        )
      ).toEqual([org.email]);

      // The admin leaves a mixed list: the member stays and the owner joins.
      const adminTwo = await addPerson(org, "admin", "leaveadmintwo");
      await save([adminTwo, memberId]);
      await leave(adminTwo);
      view = await settings.loadOrgSettingsView(org.orgId, org.userId);
      expect([...view.recipientUserIds].sort()).toEqual(
        [memberId, org.userId].sort()
      );
      expect(
        policy
          .resolveRecipientEmails(
            [adminTwo, memberId],
            await orgRecipients.loadOrgMembers(org.orgId)
          )
          .sort()
      ).toEqual([`leavemember-${RUN}@failure-alerts.test`, org.email].sort());
    });

    it("gives a workflow's own list back to the owners when everyone on it leaves", async () => {
      const org = await makeOrg("wfleavers");
      const orgAdmin = await addPerson(org, "admin", "wforgadmin");
      const ownAdmin = await addPerson(org, "admin", "wfownadmin");
      const [row] = await db
        .select({ version: orgFailureAlertSettings.version })
        .from(orgFailureAlertSettings)
        .where(eq(orgFailureAlertSettings.organizationId, org.orgId));
      await settings.saveOrgSettings(
        org.orgId,
        await settings.parseOrgSettings(
          {
            threshold: 3,
            recipientUserIds: [orgAdmin],
            version: row?.version ?? 0,
          },
          org.orgId
        ),
        org.userId
      );
      const wf = await makeWorkflow(org, "Own list keeper");
      await workflowSettings.saveWorkflowOverride({
        workflowId: wf,
        organizationId: org.orgId,
        userId: org.userId,
        body: { recipientUserIds: [ownAdmin], version: 0 },
      });
      await db
        .delete(member)
        .where(
          and(eq(member.organizationId, org.orgId), eq(member.userId, ownAdmin))
        );
      // The panel and delivery agree: the owners, not the org's admin.
      const loaded = await workflowSettings.loadWorkflowForAlerts(wf);
      if (!loaded) {
        throw new Error("workflow not found");
      }
      const view = await workflowSettings.loadWorkflowAlertView(
        loaded,
        org.userId
      );
      expect(view.override.recipientUserIds).toEqual([org.userId]);
      const effective = await policy.loadEffectivePolicy(org.orgId, wf);
      expect(
        policy.resolveRecipientEmails(
          effective.recipientUserIds,
          await orgRecipients.loadOrgMembers(org.orgId)
        )
      ).toEqual([org.email]);
    });

    it("refuses a list whose only owner or admin cannot get email", async () => {
      const org = await makeOrg("unreachablemgr");
      const memberId = await addPerson(org, "member", "reachmember");
      const walletAdmin = nextId("user_walletadmin_");
      await db.insert(users).values({
        id: walletAdmin,
        name: "wallet admin",
        // A fresh wallet each run: users.email is unique.
        email: `0x${Array.from({ length: 40 }, () => Math.floor(Math.random() * 16).toString(16)).join("")}@wallet.keeperhub.com`,
        emailVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.insert(member).values({
        id: nextId("member_"),
        organizationId: org.orgId,
        userId: walletAdmin,
        role: "admin",
        createdAt: new Date(),
      });
      const error = await settingsError(async () =>
        settings.parseOrgSettings(
          { threshold: 3, recipientUserIds: [walletAdmin, memberId] },
          org.orgId
        )
      );
      expect(error.message).toBe(settings.MANAGER_REQUIRED);
    });

    it("shows the account of whoever paused, and forgets it on resume", async () => {
      const org = await makeOrg("pauser");
      await orgPause.pauseOrgAlerts({
        organizationId: org.orgId,
        until: new Date(Date.now() + 3_600_000).toISOString(),
        reason: "Maintenance",
        by: "pauser owner",
        byUserId: org.userId,
        now: new Date(),
      });
      let view = await settings.loadOrgSettingsView(org.orgId, org.userId);
      expect(view.pause).toMatchObject({
        by: "pauser owner",
        byAccount: org.email,
      });
      await orgPause.resumeOrgAlerts({
        organizationId: org.orgId,
        by: "pauser owner",
        byUserId: org.userId,
        now: new Date(),
      });
      view = await settings.loadOrgSettingsView(org.orgId, org.userId);
      expect(view.pause).toBeNull();
      const [row] = await db
        .select({ by: orgFailureAlertSettings.pausedByUserId })
        .from(orgFailureAlertSettings)
        .where(eq(orgFailureAlertSettings.organizationId, org.orgId));
      expect(row?.by).toBeNull();
    });

    it("re-queues the org's workflows only when a rule changes", async () => {
      const org = await makeOrg("requeue");
      const body = {
        threshold: 5,
        timeLimitMinutes: 360,
        recipientUserIds: [org.userId],
      };
      const save = async (patch: Record<string, unknown>) => {
        const [row] = await db
          .select({ version: orgFailureAlertSettings.version })
          .from(orgFailureAlertSettings)
          .where(eq(orgFailureAlertSettings.organizationId, org.orgId));
        return await settings.saveOrgSettings(
          org.orgId,
          await settings.parseOrgSettings(
            { ...body, ...patch, version: row?.version ?? 0 },
            org.orgId
          ),
          org.userId
        );
      };
      expect((await save({})).rulesChanged).toBe(true);
      expect((await save({ remindDaily: false })).rulesChanged).toBe(false);
      expect((await save({ threshold: 4 })).rulesChanged).toBe(true);
      expect(
        (await save({ threshold: 4, timeLimitMinutes: 60 })).rulesChanged
      ).toBe(true);
    });

    it("lists only the user's orgs that have alerts on, for the settings menu", async () => {
      const { alertsOrgIdsForUser } = await import(
        "@/lib/notifications/failure-alerts/user-orgs"
      );
      const on = await makeOrg("menuon");
      const off = await makeOrg("menuoff");
      await db.insert(member).values({
        id: nextId("member_"),
        organizationId: off.orgId,
        userId: on.userId,
        role: "admin",
        createdAt: new Date(),
      });
      leaveRollout(off);
      expect(await alertsOrgIdsForUser(on.userId)).toEqual([on.orgId]);
    });

    it("refuses a Slack channel with spaces or over 80 characters", async () => {
      const org = await makeOrg("slackname");
      const integrationId = await makeConnection(org, "slack", "live");
      for (const destination of ["#ops alerts", `#${"a".repeat(81)}`]) {
        const error = await settingsError(() =>
          settings.parseOrgSettings(
            {
              threshold: 5,
              recipientUserIds: [org.userId],
              channels: [{ integrationId, destination, role: "always" }],
            },
            org.orgId
          )
        );
        expect(error.status).toBe(400);
        expect(error.message).toContain("not a Slack channel");
      }
    });
  });

  // One story in beforeAll: launch, alert, failed page with backup, reminder, recovery.
  describe("history", { timeout: SUITE_TIMEOUT }, () => {
    let org: Org;
    let wf: string;

    beforeAll(async () => {
      org = await makeOrg("history");
      wf = await makeWorkflow(org, "History keeper");
      await addRun(org, wf, "success", { at: at(-120) });
      await makeChannel(org, "pagerduty", "always", "dead");
      await runCycle();
      await addFailures(org, wf, 5);
      await runCycle();
      await runCycle();
      await db
        .update(workflowFailureIncidents)
        .set({ lastNotifiedAt: at(-25 * 60) })
        .where(eq(workflowFailureIncidents.workflowId, wf));
      await runCycle();
      await addRun(org, wf, "success");
      await runCycle();
    }, SUITE_TIMEOUT);

    it("lists alerts, reminders, recoveries, backups and notices with workflow names", async () => {
      const { entries: history } = await settings.loadHistory(org.orgId, {
        limit: 50,
      });
      const kinds = new Set(history.map((h) => h.kind));
      for (const kind of [
        "alert",
        "reminder",
        "recovery",
        "channel_paused",
        "launch_notice",
      ]) {
        expect(kinds, [...kinds].join(" ")).toContain(kind);
      }
      expect(history.some((h) => h.isBackup)).toBe(true);
      expect(
        history.some((h) =>
          h.workflows.some((w) => w.name === wfName("History keeper"))
        )
      ).toBe(true);
    });

    it("filters by workflow", async () => {
      const { entries: all } = await settings.loadHistory(org.orgId, {
        limit: 50,
      });
      const { entries: filtered } = await settings.loadHistory(org.orgId, {
        workflowId: wf,
      });
      expect(filtered.length).toBeGreaterThan(0);
      expect(filtered.length).toBeLessThan(all.length);
      expect(filtered.every((h) => h.workflows.some((w) => w.id === wf))).toBe(
        true
      );
    });

    it("pages with totals and filters by every column", async () => {
      const all = await settings.loadHistory(org.orgId, { page: 1, limit: 2 });
      expect(all.total).toBeGreaterThan(2);
      expect(all.pages).toBe(Math.ceil(all.total / 2));
      expect(all.byOptions[0]).toBe("KeeperHub");
      const second = await settings.loadHistory(org.orgId, {
        page: 2,
        limit: 2,
      });
      const firstIds = new Set(all.entries.map((e) => e.id));
      expect(second.entries.some((e) => firstIds.has(e.id))).toBe(false);

      const every = async (
        filter: Parameters<typeof settings.loadHistory>[1]
      ) =>
        (
          await settings.loadHistory(org.orgId, {
            page: 1,
            limit: 500,
            ...filter,
          })
        ).entries;
      const emails = await every({ channel: "email" });
      expect(emails.length).toBeGreaterThan(0);
      expect(emails.every((e) => e.channel === "email")).toBe(true);
      const alerts = await every({ kind: "alert" });
      expect(alerts.every((e) => e.kind === "alert")).toBe(true);
      const delivered = await every({ result: "delivered" });
      expect(delivered.every((e) => e.state === "delivered")).toBe(true);
      const automatic = await every({ by: "KeeperHub" });
      expect(automatic.every((e) => e.by === "KeeperHub")).toBe(true);
      const toOwner = await every({ to: org.email.slice(0, 8) });
      expect(toOwner.length).toBeGreaterThan(0);
      expect(
        toOwner.every((e) => e.recipient.includes(org.email.slice(0, 8)))
      ).toBe(true);
      expect((await every({ to: "nobody-like-this%" })).length).toBe(0);
      expect((await every({ since: "24h" })).length).toBe(
        (await every({})).length
      );
    });

    it("lists alerts only under scope alerts, and counts the undelivered", async () => {
      const scoped = await settings.loadHistory(org.orgId, {
        page: 1,
        limit: 500,
        scope: "alerts",
      });
      const alertKinds: string[] = [...settings.HISTORY_ALERT_KINDS];
      expect(scoped.entries.length).toBeGreaterThan(0);
      expect(scoped.entries.every((e) => alertKinds.includes(e.kind))).toBe(
        true
      );
      const everything = await settings.loadHistory(org.orgId, {
        page: 1,
        limit: 500,
      });
      expect(everything.total).toBeGreaterThan(scoped.total);
      // The dead PagerDuty service never took a message.
      const undelivered = everything.entries.filter((e) =>
        ["failed", "capped"].includes(e.state)
      ).length;
      expect(undelivered).toBeGreaterThan(0);
      expect(everything.notDelivered).toBe(undelivered);
    });

    it("marks only the failed run that set off the alert", async () => {
      const { attachAlertsSent } = await import("@/lib/analytics/alert-sent");
      const [incident] = await db
        .select({ opening: workflowFailureIncidents.openingExecutionId })
        .from(workflowFailureIncidents)
        .where(eq(workflowFailureIncidents.workflowId, wf));
      const executions = await db
        .select({
          id: workflowExecutions.id,
          status: workflowExecutions.status,
          startedAt: workflowExecutions.startedAt,
          completedAt: workflowExecutions.completedAt,
        })
        .from(workflowExecutions)
        .where(eq(workflowExecutions.workflowId, wf));
      const runs = executions.map(
        (e) =>
          ({
            id: e.id,
            source: "workflow",
            status: e.status === "error" ? "error" : "success",
            workflowId: wf,
            startedAt: e.startedAt.toISOString(),
            completedAt: e.completedAt?.toISOString() ?? null,
          }) as Parameters<typeof attachAlertsSent>[1][number]
      );
      const newestFailure = executions
        .filter((e) => e.status === "error")
        .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
      expect(incident.opening).toBe(newestFailure.id);
      const marked = (await attachAlertsSent(org.orgId, runs)).filter(
        (r) => r.alert
      );
      expect(marked.map((r) => r.id)).toEqual([incident.opening]);
      expect(marked[0].alert?.channels).toContain("pagerduty");
      // Another org sees nothing of this one's alerts.
      const other = await makeOrg("historyother");
      expect(
        (await attachAlertsSent(other.orgId, runs)).some((r) => r.alert)
      ).toBe(false);
    });

    it("puts the chip on the scheduled failure that opened the alert, not a manual run after it", async () => {
      const { attachAlertsSent } = await import("@/lib/analytics/alert-sent");
      const chip = await makeOrg("chipmanual");
      const chipWf = await makeWorkflow(chip, "Chip keeper");
      await addRun(chip, chipWf, "success", { at: at(-120) });
      await runCycle();
      await addFailures(chip, chipWf, 5, -10);
      await addRun(chip, chipWf, "error", {
        at: at(-1),
        source: "manual",
        credential: "session",
      });
      await runCycle();
      const incident = await openIncident(chipWf);
      expect(incident?.openingExecutionId).toBeTruthy();
      const executions = await db
        .select({
          id: workflowExecutions.id,
          startedAt: workflowExecutions.startedAt,
          triggerSource: workflowExecutions.triggerSource,
        })
        .from(workflowExecutions)
        .where(
          and(
            eq(workflowExecutions.workflowId, chipWf),
            eq(workflowExecutions.status, "error")
          )
        );
      const manual = executions.find((e) => e.triggerSource === "manual");
      const newestScheduled = executions
        .filter((e) => e.triggerSource === "schedule")
        .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
      expect(incident?.openingExecutionId).toBe(newestScheduled?.id);
      const runs = executions.map(
        (e) =>
          ({
            id: e.id,
            source: "workflow",
            status: "error",
            workflowId: chipWf,
            startedAt: e.startedAt.toISOString(),
            completedAt: e.startedAt.toISOString(),
          }) as Parameters<typeof attachAlertsSent>[1][number]
      );
      const marked = (await attachAlertsSent(chip.orgId, runs)).filter(
        (r) => r.alert
      );
      expect(marked.map((r) => r.id)).toEqual([newestScheduled?.id]);
      expect(marked.some((r) => r.id === manual?.id)).toBe(false);
    });

    it("records a test with who sent it, and filters by that person", async () => {
      const tester = await makeOrg("testrec");
      const result = await testSend.sendTest({
        organizationId: tester.orgId,
        userId: tester.userId,
        request: { channel: "email", to: "me" },
      });
      expect(result.delivered, result.message).toBe(true);
      const page = await settings.loadHistory(tester.orgId, { page: 1 });
      const test = page.entries.find((e) => e.kind === "test");
      expect(test?.by).toBe("testrec owner");
      // The account they signed in with sits beside the name.
      expect(test?.byAccount).toBe(tester.email);
      expect(test?.recipient).toBe(tester.email);
      expect(test?.state).toBe("delivered");
      expect(page.byOptions).toContain("testrec owner");
      const byTester = await settings.loadHistory(tester.orgId, {
        page: 1,
        by: "testrec owner",
      });
      expect(byTester.entries.map((e) => e.kind)).toEqual(["test"]);
    });

    it("exports CSV with a header and one row per entry", async () => {
      const { entries: history } = await settings.loadHistory(org.orgId, {
        limit: 50,
      });
      const csv = settings.historyToCsv(history);
      expect(csv.trim().split("\n")).toHaveLength(history.length + 1);
    });

    it("pages through rows that share one created time without skipping any", async () => {
      const paged = await makeOrg("historypage");
      const sameTime = at(-5);
      const ids = Array.from({ length: 8 }, () => nextId("delivery_"));
      await db.insert(failureAlertDeliveries).values(
        ids.map((id, i) => ({
          id,
          organizationId: paged.orgId,
          kind: "alert" as const,
          sequence: i,
          channel: "email" as const,
          recipient: `page-${i}-${RUN}@failure-alerts.test`,
          dedupKey: `${id}-page`,
          state: "delivered" as const,
          createdAt: sameTime,
        }))
      );
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page = await settings.loadHistory(paged.orgId, {
          limit: 3,
          cursor: parseHistoryCursor(cursor),
        });
        seen.push(...page.entries.map((e) => e.id));
        cursor = page.nextCursor;
      } while (cursor);
      expect(seen).toHaveLength(ids.length);
      expect(new Set(seen)).toEqual(new Set(ids));
    });
  });

  describe("watchdog", { timeout: SUITE_TIMEOUT }, () => {
    it("sees an outbox that stalled for more than 10 minutes", async () => {
      const org = await makeOrg("watchdog");
      const id = nextId("delivery_");
      await db.insert(failureAlertDeliveries).values({
        id,
        organizationId: org.orgId,
        kind: "alert",
        sequence: 98,
        channel: "email",
        recipient: `stale-${RUN}@failure-alerts.test`,
        dedupKey: `${id}-watchdog`,
        state: "pending",
        nextAttemptAt: at(-30),
      });
      try {
        const lag = await watchdog.checkFailureAlertsRunning();
        expect(lag.outboxLagMs).toBeGreaterThan(10 * MINUTE);
      } finally {
        await db
          .delete(failureAlertDeliveries)
          .where(eq(failureAlertDeliveries.id, id));
      }
    });

    it("a cycle reports no failed stages", async () => {
      const report = await runCycle();
      expect(report.errors).toEqual([]);
    });
  });

  describe("reopened incidents, funds, halts and late deliveries", {
    timeout: SUITE_TIMEOUT,
  }, () => {
    type Evaluator =
      typeof import("@/lib/notifications/failure-alerts/evaluator");
    let ev: Evaluator;

    const fundsFailure = async (org: Org, wf: string, minutes: number) => {
      const startedAt = at(minutes);
      await db.insert(workflowExecutions).values({
        id: nextId("run_"),
        workflowId: wf,
        userId: org.userId,
        organizationId: org.orgId,
        status: "error",
        triggerSource: "schedule",
        startedAt,
        completedAt: new Date(startedAt.getTime() + 1000),
        error: "Insufficient ETH balance to cover gas",
      });
    };

    const countingOrg = async (tag: string, patch = {}): Promise<Org> => {
      const org = await makeOrg(tag);
      await db.insert(orgFailureAlertSettings).values({
        organizationId: org.orgId,
        countingSince: at(-24 * 60),
        ...patch,
      });
      return org;
    };

    beforeAll(async () => {
      ev = await import("@/lib/notifications/failure-alerts/evaluator");
    });

    afterAll(() => {
      emailStatus = 202;
    });

    it("a reopened incident sends the alert its success withdrew before delivery", async () => {
      const org = await countingOrg("reopenqueued");
      const wf = await makeWorkflow(org, "Reopen queued");
      await addFailures(org, wf, 5, -20);
      // Evaluate only: the alert is queued but not yet sent.
      await ev.evaluateQueuedWorkflows(new Date(), ev.emptyStats());
      const first = await openIncident(wf);
      await addRun(org, wf, "success", { at: at(-10) });
      await ev.evaluateQueuedWorkflows(new Date(), ev.emptyStats());
      expect(await openIncident(wf)).toBeUndefined();
      await addRun(org, wf, "error", { at: at(-5) });
      await runCycle();
      expect((await openIncident(wf))?.id).toBe(first?.id);
      expect(await sentEmails(org, "alert")).toHaveLength(1);
    });

    it("a reopened incident sends an alert that was still retrying at the success", async () => {
      const org = await countingOrg("reopenretry");
      const wf = await makeWorkflow(org, "Reopen retrying");
      await addFailures(org, wf, 5, -20);
      emailStatus = 503;
      await runCycle();
      emailStatus = 202;
      const alert = (await deliveriesOf(org.orgId)).find(
        (d) => d.kind === "alert" && d.channel === "email"
      );
      expect(alert?.state).toBe("retrying");
      await addRun(org, wf, "success", { at: at(-10) });
      await runCycle();
      await addRun(org, wf, "error", { at: at(-5) });
      await runCycle();
      expect(await openIncident(wf)).toBeDefined();
      expect(await sentEmails(org, "alert")).toHaveLength(1);
    });

    it("a reopened incident's alert held by an org pause waits for the pause to end", async () => {
      const org = await countingOrg("reopenheld");
      const wf = await makeWorkflow(org, "Reopen held");
      await db.insert(workflowFailureAlertOverrides).values({
        workflowId: wf,
        organizationId: org.orgId,
        pauseWorkflow: true,
      });
      const until = at(120);
      await orgPause.pauseOrgAlerts({
        organizationId: org.orgId,
        until: until.toISOString(),
        reason: null,
        by: "An owner",
        now: new Date(),
      });
      await addFailures(org, wf, 5, -20);
      await runCycle();
      expect(await isEnabled(wf)).toBe(false);
      // Turned back on by hand, works once, then fails inside the recovery hold.
      await setEnabled(wf, true);
      await addRun(org, wf, "success", { at: at(-10) });
      await runCycle();
      expect(await openIncident(wf)).toBeUndefined();
      await addRun(org, wf, "error", { at: at(-5) });
      await runCycle();
      expect(await openIncident(wf)).toBeDefined();
      const held = (await deliveriesOf(org.orgId)).find(
        (d) => d.kind === "alert" && d.channel === "email"
      );
      expect(held?.state).toBe("pending");
      expect(held?.nextAttemptAt.getTime()).toBe(until.getTime());
      expect(await sentEmails(org, "alert")).toHaveLength(0);

      await orgPause.resumeOrgAlerts({
        organizationId: org.orgId,
        by: "An owner",
        now: new Date(),
      });
      await runCycle();
      expect(await sentEmails(org, "alert")).toHaveLength(1);
    });

    it("out of funds after a time-rule incident still turns the workflow off", async () => {
      const org = await countingOrg("oofafter", {
        threshold: 5,
        timeLimitMinutes: 60,
      });
      const wf = await makeWorkflow(org, "Dry after time rule");
      await db.insert(workflowFailureAlertOverrides).values({
        workflowId: wf,
        organizationId: org.orgId,
        pauseWorkflow: true,
      });
      await addRun(org, wf, "error", { at: at(-120) });
      await addRun(org, wf, "error", { at: at(-90) });
      await runCycle();
      expect((await openIncident(wf))?.openedBy).toBe("time");
      expect(await isEnabled(wf)).toBe(true);
      await fundsFailure(org, wf, -3);
      await fundsFailure(org, wf, -2);
      await runCycle();
      expect(await isEnabled(wf)).toBe(false);
      expect(await sentEmails(org, "reminder")).toHaveLength(1);
      const turnedOff = mailsAbout(org, "Dry after time rule").at(-1);
      expect(turnedOff?.text).toMatch(/funds/i);
    });

    it("two out-of-funds failures with no incident turn it off", async () => {
      const org = await countingOrg("oofnew", {
        threshold: 5,
        timeLimitMinutes: 60,
      });
      const wf = await makeWorkflow(org, "Dry wallet");
      await db.insert(workflowFailureAlertOverrides).values({
        workflowId: wf,
        organizationId: org.orgId,
        pauseWorkflow: true,
      });
      await fundsFailure(org, wf, -3);
      await fundsFailure(org, wf, -2);
      await runCycle();
      expect((await openIncident(wf))?.openedBy).toBe("funding");
      expect(await isEnabled(wf)).toBe(false);
    });

    it("keeps retrying a recovery for an hour after the hold, and a PagerDuty resolve for longer", async () => {
      const org = await countingOrg("latefix");
      const pd = await makeChannel(org, "pagerduty", "always", "live");
      const wf = await makeWorkflow(org, "Late recovery");
      await addFailures(org, wf, 5, -200);
      await runCycle();
      await addRun(org, wf, "success", { at: at(-190) });
      await runCycle();
      const incidentId = (await deliveriesOf(org.orgId)).find(
        (d) => d.kind === "recovery"
      )?.incidentId;
      // Recovery email due 55 minutes ago; PagerDuty resolve due 170 minutes ago (5xx since).
      await db
        .update(failureAlertDeliveries)
        .set({
          state: "retrying",
          attempts: 4,
          createdAt: at(-100),
          nextAttemptAt: at(-1),
          backupAt: at(-55 + 15),
        })
        .where(
          and(
            eq(failureAlertDeliveries.organizationId, org.orgId),
            eq(failureAlertDeliveries.kind, "recovery"),
            eq(failureAlertDeliveries.channel, "email")
          )
        );
      await db
        .update(failureAlertDeliveries)
        .set({
          state: "retrying",
          attempts: 6,
          createdAt: at(-200),
          nextAttemptAt: at(-1),
          backupAt: at(-170 + 2),
        })
        .where(
          and(
            eq(failureAlertDeliveries.organizationId, org.orgId),
            eq(failureAlertDeliveries.kind, "recovery"),
            eq(failureAlertDeliveries.channelId, pd.id)
          )
        );
      await runCycle();
      const rows = (await deliveriesOf(org.orgId)).filter(
        (d) => d.kind === "recovery" && d.incidentId === incidentId
      );
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.state, row.lastError ?? "").toBe("delivered");
      }
    });

    it("sends a halted org nothing it queued before the halt, nor after it is lifted", async () => {
      const org = await countingOrg("haltedqueue");
      const wf = await makeWorkflow(org, "Halted with queue");
      await addFailures(org, wf, 5, -20);
      await ev.evaluateQueuedWorkflows(new Date(), ev.emptyStats());
      await db
        .update(organization)
        .set({ haltedAt: new Date() })
        .where(eq(organization.id, org.orgId));
      await runCycle();
      const alert = (await deliveriesOf(org.orgId)).find(
        (d) => d.kind === "alert" && d.channel === "email"
      );
      expect(alert?.state).toBe("skipped");
      expect(alert?.lastError).toBe(SKIP_REASON.halted);
      const reset = await resetOrgCircuitBreaker({
        organizationId: org.orgId,
        requestedByUserId: org.userId,
      });
      expect(reset).toEqual({ reset: true, wasHalted: true });
      await runCycle();
      expect(await sentEmails(org, "alert")).toHaveLength(0);
      expect((await openIncident(wf))?.resolvedAt).toBeNull();
    });

    it("lifting a halt restarts the reminder clock", async () => {
      const org = await countingOrg("haltclock");
      const wf = await makeWorkflow(org, "Halt clock");
      await addFailures(org, wf, 5, -20);
      await runCycle();
      const incident = await openIncident(wf);
      await db
        .update(organization)
        .set({ haltedAt: new Date() })
        .where(eq(organization.id, org.orgId));
      await db
        .update(workflowFailureIncidents)
        .set({ lastNotifiedAt: at(-25 * 60) })
        .where(eq(workflowFailureIncidents.id, incident?.id ?? ""));
      await resetOrgCircuitBreaker({
        organizationId: org.orgId,
        requestedByUserId: org.userId,
      });
      const after = await incidentById(incident?.id);
      expect(after?.lastNotifiedAt.getTime()).toBeGreaterThan(
        Date.now() - MINUTE
      );
      await runCycle();
      expect(await sentEmails(org, "reminder")).toHaveLength(0);
    });

    it("a not-running incident ends with any run that started, even one our platform failed", async () => {
      const org = await countingOrg("missedsys");
      const wf = await makeWorkflow(org, "Missed then platform error");
      await addSchedule(wf);
      await runCycle();
      const incident = await openIncident(wf);
      expect(incident?.openedBy).toBe("missed");
      await addRun(org, wf, "error", { at: at(-1), errorType: "system" });
      await runCycle();
      expect((await incidentById(incident?.id))?.resolvedReason).toBe("ran");
      // Our error, not theirs: the recovery says it started again, not that it failed.
      const recovery = (await deliveriesOf(org.orgId)).find(
        (d) => d.kind === "recovery"
      );
      expect(recovery?.context).not.toHaveProperty("ranButFailed");
    });

    it("a queued or placeholder row does not end a not-running incident; a run that starts does", async () => {
      const org = await countingOrg("missedqueued");
      const wf = await makeWorkflow(org, "Missed then queued");
      await addSchedule(wf);
      await runCycle();
      const incident = await openIncident(wf);
      expect(incident?.openedBy).toBe("missed");
      await addRun(org, wf, "pending", { at: at(-2) });
      await addRun(org, wf, "phantom", { at: at(-1) });
      await runCycle();
      expect((await incidentById(incident?.id))?.resolvedAt).toBeNull();
      await addRun(org, wf, "success");
      await runCycle();
      expect((await incidentById(incident?.id))?.resolvedReason).toBe("ran");
    });

    it("a stuck queued row does not hide a schedule that stopped starting runs", async () => {
      const org = await countingOrg("stuckqueued");
      const wf = await makeWorkflow(org, "Stuck in the queue");
      await addSchedule(wf);
      for (const minutes of [-60, -30, -11, -6, -1]) {
        await addRun(org, wf, "pending", { at: at(minutes) });
      }
      await runCycle();
      expect((await openIncident(wf))?.openedBy).toBe("missed");
    });

    it("a run refused before it started does not end a not-running incident", async () => {
      const org = await countingOrg("missedrefused");
      const wf = await makeWorkflow(org, "Missed then refused");
      await addSchedule(wf);
      await runCycle();
      const incident = await openIncident(wf);
      expect(incident?.openedBy).toBe("missed");
      await addRun(org, wf, "skipped", { at: at(-1) });
      await runCycle();
      expect((await incidentById(incident?.id))?.resolvedAt).toBeNull();
    });

    it("a schedule whose every run was refused still opens a not-running incident", async () => {
      const org = await countingOrg("allrefused");
      const wf = await makeWorkflow(org, "All refused");
      await addSchedule(wf);
      for (const minutes of [-60, -30, -11, -6, -1]) {
        await addRun(org, wf, "skipped", { at: at(minutes) });
      }
      await runCycle();
      expect((await openIncident(wf))?.openedBy).toBe("missed");
    });

    it("a reopened incident revives its withdrawn alerts but not their backups", async () => {
      const org = await countingOrg("reopenbackup");
      const wf = await makeWorkflow(org, "Reopen backup");
      await addFailures(org, wf, 5, -20);
      await ev.evaluateQueuedWorkflows(new Date(), ev.emptyStats());
      const first = await openIncident(wf);
      const backupId = nextId("dl_");
      await db.insert(failureAlertDeliveries).values({
        id: backupId,
        dedupKey: `incident:${first?.id}|alert|0|email|backup@x.dev|backup`,
        organizationId: org.orgId,
        incidentId: first?.id,
        kind: "alert",
        channel: "email",
        recipient: "backup@x.dev",
        isBackup: true,
      });
      await addRun(org, wf, "success", { at: at(-10) });
      await ev.evaluateQueuedWorkflows(new Date(), ev.emptyStats());
      expect(
        (await deliveriesOf(org.orgId)).find((d) => d.id === backupId)?.state
      ).toBe("skipped");
      await addRun(org, wf, "error", { at: at(-5) });
      await ev.evaluateQueuedWorkflows(new Date(), ev.emptyStats());
      expect((await openIncident(wf))?.id).toBe(first?.id);
      const rows = await deliveriesOf(org.orgId);
      const backup = rows.find((d) => d.id === backupId);
      expect(backup?.state).toBe("skipped");
      // Renamed, so a backup for the revived alert can be queued again.
      expect(backup?.dedupKey).toContain("|withdrawn:");
      const primary = rows.find((d) => d.kind === "alert" && !d.isBackup);
      expect(primary?.state).toBe("pending");
      expect(primary?.backupSentAt).toBeNull();
    });

    it("a reopened incident owes a failed alert a fresh backup when its backup was withdrawn", async () => {
      const org = await countingOrg("reopenfailed");
      const backupChannel = await makeChannel(org, "discord", "backup", "live");
      const wf = await makeWorkflow(org, "Reopen failed");
      await addFailures(org, wf, 5, -20);
      await ev.evaluateQueuedWorkflows(new Date(), ev.emptyStats());
      const first = await openIncident(wf);
      const primary = (await deliveriesOf(org.orgId)).find(
        (d) => d.kind === "alert" && !d.isBackup && d.channel === "email"
      );
      // The email failed for good and its backup was queued.
      await db
        .update(failureAlertDeliveries)
        .set({ state: "failed", attempts: 1, backupSentAt: at(-5) })
        .where(eq(failureAlertDeliveries.id, primary?.id ?? ""));
      const backupKey = `i:${first?.id}|alert|0|discord|${backupChannel.id}|discord|backup`;
      await db.insert(failureAlertDeliveries).values({
        id: nextId("dl_"),
        dedupKey: backupKey,
        organizationId: org.orgId,
        incidentId: first?.id,
        kind: "alert",
        channel: "discord",
        channelId: backupChannel.id,
        recipient: "discord",
        isBackup: true,
      });
      await addRun(org, wf, "success", { at: at(-10) });
      await ev.evaluateQueuedWorkflows(new Date(), ev.emptyStats());
      await addRun(org, wf, "error", { at: at(-5) });
      await ev.evaluateQueuedWorkflows(new Date(), ev.emptyStats());
      expect((await openIncident(wf))?.id).toBe(first?.id);
      const rearmed = (await deliveriesOf(org.orgId)).find(
        (d) => d.id === primary?.id
      );
      expect(rearmed?.backupSentAt).toBeNull();
      expect(rearmed?.backupAt?.getTime()).toBeGreaterThan(Date.now() - MINUTE);
      const { fireBackups, emptyDrainStats } = await import(
        "@/lib/notifications/failure-alerts/outbox"
      );
      await fireBackups(new Date(), emptyDrainStats());
      const fresh = (await deliveriesOf(org.orgId)).find(
        (d) => d.dedupKey === backupKey
      );
      expect(fresh?.state).toBe("pending");
    });

    it("a backup re-queued for a reopened incident waits for an org pause to end", async () => {
      const org = await countingOrg("reopenpaused");
      const backupChannel = await makeChannel(org, "discord", "backup", "live");
      const wf = await makeWorkflow(org, "Reopen paused");
      await addFailures(org, wf, 5, -20);
      await ev.evaluateQueuedWorkflows(new Date(), ev.emptyStats());
      const until = at(120);
      await orgPause.pauseOrgAlerts({
        organizationId: org.orgId,
        until: until.toISOString(),
        reason: null,
        by: "An owner",
        now: new Date(),
      });
      const primary = (await deliveriesOf(org.orgId)).find(
        (d) => d.kind === "alert" && !d.isBackup && d.channel === "email"
      );
      await db
        .update(failureAlertDeliveries)
        .set({ state: "failed", attempts: 1 })
        .where(eq(failureAlertDeliveries.id, primary?.id ?? ""));
      await addRun(org, wf, "success", { at: at(-10) });
      await ev.evaluateQueuedWorkflows(new Date(), ev.emptyStats());
      await addRun(org, wf, "error", { at: at(-5) });
      await ev.evaluateQueuedWorkflows(new Date(), ev.emptyStats());
      expect(await openIncident(wf)).toBeDefined();
      const { fireBackups, emptyDrainStats } = await import(
        "@/lib/notifications/failure-alerts/outbox"
      );
      await fireBackups(new Date(), emptyDrainStats());
      const backups = (await deliveriesOf(org.orgId)).filter(
        (d) => d.isBackup && d.state !== "skipped"
      );
      expect(backups.map((d) => d.channelId)).toContain(backupChannel.id);
      for (const backup of backups) {
        expect(backup.nextAttemptAt.getTime()).toBe(until.getTime());
      }
    });

    const refusedRun = async (
      org: Org,
      wf: string,
      minutes: number,
      fields: Partial<typeof workflowExecutions.$inferInsert> = {}
    ) => {
      const startedAt = at(minutes);
      await db.insert(workflowExecutions).values({
        id: nextId("run_"),
        workflowId: wf,
        userId: org.userId,
        organizationId: org.orgId,
        status: "skipped",
        billable: false,
        error: EXECUTION_LIMIT_REFUSAL,
        errorCategory: "billing",
        errorType: "user",
        triggerSource: "schedule",
        startedAt,
        completedAt: startedAt,
        ...fields,
      });
    };

    it("an org at its run limit hears its runs are refused, not a scheduling problem", async () => {
      const org = await countingOrg("runlimit");
      const wf = await makeWorkflow(org, "Run limit keeper");
      await addSchedule(wf);
      await refusedRun(org, wf, -1);
      await runCycle();
      const incident = await openIncident(wf);
      expect(incident?.openedBy).toBe("missed");
      expect(incident?.lastError).toBe(EXECUTION_LIMIT_REFUSAL);
      expect(incident?.lastFailedExecutionId).toBeTruthy();
      const [mail] = mailsAbout(org, "Run limit keeper");
      expect(mail?.text).toContain("refused before they start");
      const shown = "your plan's monthly execution limit has been reached";
      expect(mail?.text).toContain(`before they start: ${shown}.`);
      expect(mail?.text).not.toContain("Execution skipped");
      expect(mail?.text).toContain("/plans");
      expect(mail?.text).not.toMatch(/scheduling problem|our team|by hand/i);
      const loaded = await workflowSettings.loadWorkflowForAlerts(wf);
      if (!loaded) {
        throw new Error("workflow not found");
      }
      const view = await workflowSettings.loadWorkflowAlertView(
        loaded,
        org.userId
      );
      expect(view.status.incident?.refused).toBe(true);
      expect(view.status.incident?.refusedReason).toBe(`${shown}.`);
    });

    it("a refusal over an hour old does not label a later miss as refused", async () => {
      const org = await countingOrg("stalerefusal");
      const wf = await makeWorkflow(org, "Stale refusal");
      await addSchedule(wf);
      await refusedRun(org, wf, -90);
      await runCycle();
      const incident = await openIncident(wf);
      expect(incident?.openedBy).toBe("missed");
      expect(incident?.lastFailedExecutionId).toBeNull();
      expect(incident?.lastError).toBeNull();
    });

    it("an open not-running incident takes the newest refusal, and a plain one becomes refused", async () => {
      const org = await countingOrg("newrefusal");
      const wf = await makeWorkflow(org, "Newer refusal");
      await addSchedule(wf);
      await runCycle();
      const plain = await openIncident(wf);
      expect(plain?.lastFailedExecutionId).toBeNull();
      await refusedRun(org, wf, -2);
      await runCycle();
      const refused = await openIncident(wf);
      expect(refused?.id).toBe(plain?.id);
      expect(refused?.lastError).toBe(EXECUTION_LIMIT_REFUSAL);
      const unpaid = "Insufficient credit balance to pay for this execution.";
      await refusedRun(org, wf, -1, { error: unpaid });
      await runCycle();
      const latest = await openIncident(wf);
      expect(latest?.lastError).toBe(unpaid);
      expect(latest?.lastFailedExecutionId).not.toBe(
        refused?.lastFailedExecutionId
      );
    });

    it("refused schedules across orgs do not look like a scheduler outage, so a real miss still alerts", async () => {
      const refusedWorkflows: string[] = [];
      for (const tag of ["limA", "limB", "limC", "limD"]) {
        const org = await makeOrg(tag);
        leaveRollout(org);
        for (let i = 0; i < 7 && refusedWorkflows.length < 25; i++) {
          const id = await makeWorkflow(org, `Refused ${tag} ${i}`);
          await addSchedule(id);
          await refusedRun(org, id, -1);
          refusedWorkflows.push(id);
        }
      }
      const org = await countingOrg("realmiss");
      const wf = await makeWorkflow(org, "Real miss");
      await addSchedule(wf);
      // A fresh miss: a platform-wide outage would hold it for 30 minutes.
      await addRun(org, wf, "success", { at: at(-20) });
      try {
        await runCycle();
        expect(refusedWorkflows).toHaveLength(25);
        const incident = await openIncident(wf);
        expect(incident?.openedBy).toBe("missed");
        expect(incident?.lastFailedExecutionId).toBeNull();
      } finally {
        for (const id of refusedWorkflows) {
          await setEnabled(id, false);
        }
      }
    });

    it("five unpaid webhook refusals open a refused incident and do not turn the workflow off", async () => {
      const org = await countingOrg("unpaid");
      const wf = await makeWorkflow(org, "Unpaid webhook", "Webhook");
      await db.insert(workflowFailureAlertOverrides).values({
        workflowId: wf,
        organizationId: org.orgId,
        threshold: 2,
        pauseWorkflow: true,
      });
      for (const minutes of [-5, -4, -3, -2, -1]) {
        await refusedRun(org, wf, minutes, {
          status: "error",
          error: "Insufficient credit balance to pay for this execution.",
          triggerSource: "webhook",
        });
      }
      await runCycle();
      const incident = await openIncident(wf);
      expect(incident?.openedBy).toBe("refused");
      expect(incident?.failureCount).toBe(0);
      expect(incident?.workflowPausedAt).toBeNull();
      expect(await isEnabled(wf)).toBe(true);
    });

    const unpaid = (
      org: Org,
      wf: string,
      minutes: number
    ): ReturnType<typeof refusedRun> =>
      refusedRun(org, wf, minutes, {
        error: "Insufficient credit balance to pay for this execution.",
        triggerSource: "webhook",
      });

    it("two refused webhook runs in a row open a refused incident with the newest reason", async () => {
      const org = await countingOrg("refusedtwo");
      const wf = await makeWorkflow(org, "Refused twice", "Webhook");
      await unpaid(org, wf, -3);
      await unpaid(org, wf, -2);
      await runCycle();
      const incident = await openIncident(wf);
      expect(incident?.openedBy).toBe("refused");
      expect(incident?.lastError).toBe(
        "Insufficient credit balance to pay for this execution."
      );
      const runs = await db
        .select({
          id: workflowExecutions.id,
          startedAt: workflowExecutions.startedAt,
        })
        .from(workflowExecutions)
        .where(eq(workflowExecutions.workflowId, wf))
        .orderBy(workflowExecutions.startedAt);
      expect(incident?.firstFailedAt).toEqual(runs[0]?.startedAt);
      expect(incident?.lastFailedExecutionId).toBe(runs.at(-1)?.id);
      const [mail] = mailsAbout(org, "Refused twice");
      expect(mail?.text).toContain(
        "Its runs are being refused before they start: insufficient credit balance"
      );
      expect(mail?.text).toContain("/plans");
      expect(mail?.text).not.toMatch(/scheduled|wallet out of funds/i);
      const loaded = await workflowSettings.loadWorkflowForAlerts(wf);
      if (!loaded) {
        throw new Error("workflow not found");
      }
      const view = await workflowSettings.loadWorkflowAlertView(
        loaded,
        org.userId
      );
      expect(view.status.incident?.refused).toBe(true);
    });

    it("one refused run opens nothing, and an accepted run in between breaks the pair", async () => {
      const org = await countingOrg("refusedone");
      const wf = await makeWorkflow(org, "Refused once", "Webhook");
      await unpaid(org, wf, -4);
      await runCycle();
      expect(await openIncident(wf)).toBeUndefined();
      await addRun(org, wf, "success", { at: at(-3), source: "webhook" });
      await unpaid(org, wf, -2);
      await runCycle();
      expect(await openIncident(wf)).toBeUndefined();
    });

    it("an accepted run closes it; the recovery waits out the hold and says runs are accepted again", async () => {
      const org = await countingOrg("refusedok");
      const wf = await makeWorkflow(org, "Refused then ok", "Webhook");
      await unpaid(org, wf, -10);
      await unpaid(org, wf, -9);
      await runCycle();
      const incident = await openIncident(wf);
      expect(incident?.openedBy).toBe("refused");
      await addRun(org, wf, "success", { at: at(-1), source: "webhook" });
      await runCycle();
      expect(await openIncident(wf)).toBeUndefined();
      expect((await incidentById(incident?.id))?.resolvedReason).toBe("ran");
      const held = (await deliveriesOf(org.orgId)).filter(
        (d) => d.kind === "recovery" && d.channel === "email"
      );
      expect(held).toHaveLength(1);
      expect(held[0]?.nextAttemptAt.getTime()).toBeGreaterThan(
        at(25).getTime()
      );
      expect(await sentEmails(org, "recovery")).toHaveLength(0);
      await endRecoveryHold(org.orgId);
      await runCycle();
      expect(await sentEmails(org, "recovery")).toHaveLength(1);
      const recovery = mailsAbout(org, "Refused then ok").at(-1);
      expect(recovery?.text).toContain("Its runs are being accepted again");
    });

    it("a phantom, pending or platform-failed row does not close it; an accepted run does", async () => {
      const org = await countingOrg("refusedphantom");
      const wf = await makeWorkflow(org, "Refused phantom", "Webhook");
      await unpaid(org, wf, -10);
      await unpaid(org, wf, -9);
      await runCycle();
      const incident = await openIncident(wf);
      expect(incident?.openedBy).toBe("refused");
      await addRun(org, wf, "phantom", { at: at(-3), source: "webhook" });
      await addRun(org, wf, "pending", { at: at(-2.5), source: "webhook" });
      await addRun(org, wf, "system_error", { at: at(-2), source: "webhook" });
      await addRun(org, wf, "error", {
        at: at(-1.5),
        source: "webhook",
        errorType: "system",
      });
      await runCycle();
      expect((await openIncident(wf))?.id).toBe(incident?.id);
      await addRun(org, wf, "success", { at: at(-1), source: "webhook" });
      await runCycle();
      expect(await openIncident(wf)).toBeUndefined();
      expect((await incidentById(incident?.id))?.resolvedReason).toBe("ran");
    });

    it("refused again inside the hold continues the same incident and withdraws its recovery", async () => {
      const org = await countingOrg("refusedflap");
      const wf = await makeWorkflow(org, "Refused flap", "Webhook");
      await unpaid(org, wf, -10);
      await unpaid(org, wf, -9);
      await runCycle();
      const first = await openIncident(wf);
      await addRun(org, wf, "success", { at: at(-5), source: "webhook" });
      await runCycle();
      expect(await openIncident(wf)).toBeUndefined();
      await unpaid(org, wf, -0.5);
      await unpaid(org, wf, -0.2);
      await runCycle();
      const again = await openIncident(wf);
      expect(again?.id).toBe(first?.id);
      expect(again?.openedBy).toBe("refused");
      const recoveries = (await deliveriesOf(org.orgId)).filter(
        (d) => d.kind === "recovery"
      );
      expect(recoveries.every((d) => d.state === "skipped")).toBe(true);
      expect(await sentEmails(org, "alert")).toHaveLength(1);
    });

    it("refusals during an org pause open nothing until the pause ends", async () => {
      const org = await countingOrg("refusedpause", { pausedUntil: at(60) });
      const wf = await makeWorkflow(org, "Refused paused", "Webhook");
      await unpaid(org, wf, -3);
      await unpaid(org, wf, -2);
      await runCycle();
      expect(await openIncident(wf)).toBeUndefined();
    });

    /** at() moves with the clock: times a few seconds apart are the same minute mark. */
    const expectNear = (actual: Date | undefined, expected: Date): void => {
      expect(
        Math.abs((actual?.getTime() ?? 0) - expected.getTime())
      ).toBeLessThan(5000);
    };

    /** One hourly refused row as recordRefusedRun writes it (lib/workflow/refused-runs.ts). */
    const refusalBucket = async (
      org: Org,
      wf: string,
      fields: {
        firstAt: number;
        lastAt: number;
        refusals: number;
        error?: string;
      }
    ): Promise<string> => {
      const id = nextId("run_");
      await db.insert(workflowExecutions).values({
        id,
        workflowId: wf,
        userId: org.userId,
        organizationId: org.orgId,
        status: "skipped",
        billable: false,
        error: fields.error ?? EXECUTION_LIMIT_REFUSAL,
        errorCategory: "billing",
        errorType: "user",
        triggerSource: "webhook",
        output: { refusals: fields.refusals },
        dispatchKey: `refused:${wf}:execution_limit:${id}`,
        startedAt: at(fields.firstAt),
        completedAt: at(fields.lastAt),
      });
      return id;
    };

    /** Another refusal in the same hour: what recordRefusedRun's conflict update does. */
    const refuseAgain = async (runId: string, minutes: number) => {
      await db
        .update(workflowExecutions)
        .set({
          completedAt: at(minutes),
          output: sql`jsonb_build_object('refusals', coalesce((${workflowExecutions.output}->>'refusals')::int, 1) + 1)`,
        })
        .where(eq(workflowExecutions.id, runId));
      await db
        .insert(workflowFailureAlertQueue)
        .values({
          workflowId: (await workflowOfRun(runId)) ?? "",
          dueAt: new Date(),
        })
        .onConflictDoUpdate({
          target: workflowFailureAlertQueue.workflowId,
          set: { dueAt: new Date() },
        });
    };

    const workflowOfRun = async (
      runId: string
    ): Promise<string | undefined> => {
      const [row] = await db
        .select({ workflowId: workflowExecutions.workflowId })
        .from(workflowExecutions)
        .where(eq(workflowExecutions.id, runId));
      return row?.workflowId;
    };

    it("one hourly row holding two refusals opens a refused incident; one holding one does not", async () => {
      const org = await countingOrg("bucketpair");
      const wf = await makeWorkflow(org, "Bucket pair", "Webhook");
      const run = await refusalBucket(org, wf, {
        firstAt: -20,
        lastAt: -20,
        refusals: 1,
      });
      await runCycle();
      expect(await openIncident(wf)).toBeUndefined();
      await refuseAgain(run, -5);
      await runCycle();
      const incident = await openIncident(wf);
      expect(incident?.openedBy).toBe("refused");
      expectNear(incident?.firstFailedAt, at(-20));
      // Refused at = the row's newest refusal.
      expectNear(incident?.lastFailedAt, at(-5));
    });

    it("an accepted run older than the newest refusal in the hour does not close it", async () => {
      const org = await countingOrg("bucketlate");
      const wf = await makeWorkflow(org, "Bucket late", "Webhook");
      const run = await refusalBucket(org, wf, {
        firstAt: -40,
        lastAt: -30,
        refusals: 2,
      });
      await runCycle();
      const incident = await openIncident(wf);
      expect(incident?.openedBy).toBe("refused");
      await addRun(org, wf, "success", { at: at(-10), source: "webhook" });
      // Refused again after that run, in the same hourly row.
      await refuseAgain(run, -2);
      await runCycle();
      expect((await openIncident(wf))?.id).toBe(incident?.id);
      expectNear((await openIncident(wf))?.lastFailedAt, at(-2));
      await addRun(org, wf, "success", { at: at(-1), source: "webhook" });
      await runCycle();
      expect(await openIncident(wf)).toBeUndefined();
      expect((await incidentById(incident?.id))?.resolvedReason).toBe("ran");
    });

    it("one refusal after the close, inside the hold, reopens it and withdraws the recovery", async () => {
      const org = await countingOrg("bucketflap");
      const wf = await makeWorkflow(org, "Bucket flap", "Webhook");
      const run = await refusalBucket(org, wf, {
        firstAt: -40,
        lastAt: -30,
        refusals: 2,
      });
      await runCycle();
      const first = await openIncident(wf);
      await addRun(org, wf, "success", { at: at(-10), source: "webhook" });
      await runCycle();
      expect(await openIncident(wf)).toBeUndefined();
      await refuseAgain(run, -1);
      await runCycle();
      expect((await openIncident(wf))?.id).toBe(first?.id);
      const recoveries = (await deliveriesOf(org.orgId)).filter(
        (d) => d.kind === "recovery"
      );
      expect(recoveries.every((d) => d.state === "skipped")).toBe(true);
    });

    it("an hourly row split by an accepted run counts only the refusal after it", async () => {
      const org = await countingOrg("bucketsplit");
      const wf = await makeWorkflow(org, "Bucket split", "Webhook");
      const run = await refusalBucket(org, wf, {
        firstAt: -40,
        lastAt: -40,
        refusals: 1,
      });
      await addRun(org, wf, "success", { at: at(-25), source: "webhook" });
      await refuseAgain(run, -5);
      await runCycle();
      expect(await openIncident(wf)).toBeUndefined();
      await endRecoveryHold(org.orgId);
      await runCycle();
      expect(await openIncident(wf)).toBeUndefined();
    });

    it("40 webhook workflows at the run limit each get one alert and one page, then their own recovery", async () => {
      const org = await countingOrg("runlimit40");
      const channel = await makeChannel(org, "pagerduty", "always", "live");
      const ids: string[] = [];
      for (let i = 0; i < 40; i++) {
        const wf = await makeWorkflow(org, `Limited ${i}`, "Webhook");
        await refusalBucket(org, wf, { firstAt: -20, lastAt: -5, refusals: 3 });
        ids.push(wf);
      }
      await runCycle();
      const open = await db
        .select()
        .from(workflowFailureIncidents)
        .where(
          and(
            eq(workflowFailureIncidents.organizationId, org.orgId),
            isNull(workflowFailureIncidents.resolvedAt)
          )
        );
      expect(open).toHaveLength(40);
      const alertsOf = async () =>
        (await deliveriesOf(org.orgId)).filter((d) => d.kind === "alert");
      const alerts = await alertsOf();
      // Never in a grouped message: every alert row belongs to one incident.
      expect(alerts.every((d) => d.incidentId !== null)).toBe(true);
      for (const incident of open) {
        const own = alerts.filter((d) => d.incidentId === incident.id);
        expect(own.filter((d) => d.channel === "email")).toHaveLength(1);
        const pages = own.filter((d) => d.channelId === channel.id);
        expect(pages).toHaveLength(1);
        expect(pages[0]?.state, pages[0]?.lastError ?? "").toBe("delivered");
      }
      expect(alerts).toHaveLength(80);
      const mails = mailsTo(org).filter((m) =>
        m.subject.includes("is not running")
      );
      expect(mails).toHaveLength(40);
      expect(mails[0]?.text).toContain(
        "Raise the plan's run limit under Plans"
      );
      expect(
        mailsTo(org).some((m) =>
          m.subject.includes("workflows are not running")
        )
      ).toBe(false);
      // All queued: nothing is re-queued as lost.
      await db
        .update(workflowFailureIncidents)
        .set({ openedAt: at(-10) })
        .where(eq(workflowFailureIncidents.organizationId, org.orgId));
      await runCycle();
      expect(await alertsOf()).toHaveLength(80);

      // Accepted again: each recovers and resolves its own page.
      for (const wf of ids) {
        await addRun(org, wf, "success", { at: at(-1), source: "webhook" });
      }
      await runCycle();
      await endRecoveryHold(org.orgId);
      await runCycle();
      const recoveries = (await deliveriesOf(org.orgId)).filter(
        (d) => d.kind === "recovery" && d.state !== "skipped"
      );
      for (const incident of open) {
        const own = recoveries.filter((d) => d.incidentId === incident.id);
        expect(own.filter((d) => d.channel === "email")).toHaveLength(1);
        const resolves = own.filter((d) => d.channelId === channel.id);
        expect(resolves).toHaveLength(1);
        expect(resolves[0]?.state, resolves[0]?.lastError ?? "").toBe(
          "delivered"
        );
      }
      expect(recoveries).toHaveLength(80);
      expect((await incidentById(open[0]?.id))?.resolvedReason).toBe("ran");
    });

    it("stops reminding a refused incident once nothing was refused for a day, without a recovery", async () => {
      const org = await countingOrg("refusedquiet");
      const wf = await makeWorkflow(org, "Refused quiet", "Webhook");
      await refusalBucket(org, wf, { firstAt: -40, lastAt: -30, refusals: 2 });
      await runCycle();
      const incident = await openIncident(wf);
      expect(incident?.openedBy).toBe("refused");
      const { queueReminders, emptyStats } = await import(
        "@/lib/notifications/failure-alerts/evaluator"
      );
      await db
        .update(workflowFailureIncidents)
        .set({ lastNotifiedAt: at(-25 * 60), lastFailedAt: at(-23 * 60) })
        .where(eq(workflowFailureIncidents.id, incident?.id ?? ""));
      const stats = emptyStats();
      await queueReminders(new Date(), stats);
      expect(stats.remindersQueued).toBe(1);
      await db
        .update(workflowFailureIncidents)
        .set({ lastNotifiedAt: at(-25 * 60), lastFailedAt: at(-25 * 60) })
        .where(eq(workflowFailureIncidents.id, incident?.id ?? ""));
      const later = emptyStats();
      await queueReminders(new Date(), later);
      expect(later.remindersQueued).toBe(0);
      expect((await openIncident(wf))?.id).toBe(incident?.id);
      expect(
        (await deliveriesOf(org.orgId)).filter((d) => d.kind === "recovery")
      ).toHaveLength(0);
    });

    it("a refused schedule gets one not-running incident, never a refused one too", async () => {
      const org = await countingOrg("refusedsched");
      const wf = await makeWorkflow(org, "Refused schedule");
      await addSchedule(wf);
      await refusedRun(org, wf, -3);
      await refusedRun(org, wf, -2);
      await runCycle();
      await runCycle();
      const all = await db
        .select({ openedBy: workflowFailureIncidents.openedBy })
        .from(workflowFailureIncidents)
        .where(eq(workflowFailureIncidents.workflowId, wf));
      expect(all.map((row) => row.openedBy)).toEqual(["missed"]);
    });
  });
  describe("mute safeguards", { timeout: SUITE_TIMEOUT }, () => {
    async function person(
      org: Org,
      role: "admin" | "member",
      label: string
    ): Promise<{ id: string; email: string }> {
      const id = nextId(`user_${label}_`);
      const email = `${label}-${RUN}@failure-alerts.test`;
      await db.insert(users).values({
        id,
        name: label,
        email,
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.insert(member).values({
        id: nextId("member_"),
        organizationId: org.orgId,
        userId: id,
        role,
        createdAt: new Date(),
      });
      return { id, email };
    }
    async function version(wf: string): Promise<number> {
      const [row] = await db
        .select({ version: workflowFailureAlertOverrides.version })
        .from(workflowFailureAlertOverrides)
        .where(eq(workflowFailureAlertOverrides.workflowId, wf));
      return row?.version ?? 0;
    }
    async function save(
      org: Org,
      wf: string,
      body: Record<string, unknown>,
      userId = org.userId
    ) {
      return await workflowSettings.saveWorkflowOverride({
        workflowId: wf,
        organizationId: org.orgId,
        userId,
        body: { ...body, version: await version(wf) },
      });
    }
    async function notices(orgId: string, kind: string) {
      return (await deliveriesOf(orgId)).filter((d) => d.kind === kind);
    }
    const inHours = (hours: number): string =>
      new Date(Date.now() + hours * 3_600_000).toISOString();

    it("caps a mute at 7 days and asks why", async () => {
      const org = await makeOrg("mutecap");
      const wf = await makeWorkflow(org, "Mute cap");
      const tooLong = await settingsError(() =>
        save(org, wf, { mutedUntil: inHours(8 * 24), muteReason: "Upgrade" })
      );
      expect(tooLong.message).toBe("A mute can last at most 7 days.");
      const noReason = await settingsError(() =>
        save(org, wf, { mutedUntil: inHours(24) })
      );
      expect(noReason.message).toBe(workflowSettings.MUTE_REASON_REQUIRED);
      const shortReason = await settingsError(() =>
        save(org, wf, { mutedUntil: inHours(24), muteReason: "ab" })
      );
      expect(shortReason.status).toBe(400);
      // "Until it works" ends after 7 days at most.
      await save(org, wf, { muteUntilSuccess: true, muteReason: "Upgrade" });
      const [row] = await db
        .select()
        .from(workflowFailureAlertOverrides)
        .where(eq(workflowFailureAlertOverrides.workflowId, wf));
      expect(row?.mutedUntil?.getTime()).toBeLessThanOrEqual(
        Date.now() + 7 * 24 * 3_600_000 + 1000
      );
    });

    it("announces a mute to the people it silences and every owner, keeps who and why on other edits, and re-announces a change", async () => {
      const org = await makeOrg("muteannounce");
      const admin = await person(org, "admin", "muteadmin");
      // The org's alerts go to the admin only; the owner hears as an owner.
      await settings.saveOrgSettings(
        org.orgId,
        await settings.parseOrgSettings(
          { threshold: 3, recipientUserIds: [admin.id], version: 0 },
          org.orgId
        ),
        org.userId
      );
      const wf = await makeWorkflow(org, "Announced mute");
      const until = inHours(24);
      const first = await save(
        org,
        wf,
        { mutedUntil: until, muteReason: "RPC migration" },
        admin.id
      );
      expect(first.muteChange).toBe("muted");
      const muted = await notices(org.orgId, "workflow_muted");
      expect(muted.map((d) => d.recipient).sort()).toEqual(
        [admin.email, org.email].sort()
      );
      expect(muted[0]?.context).toMatchObject({
        reason: "RPC migration",
        byUserId: admin.id,
        byAccount: admin.email,
        workflowId: wf,
      });

      // A threshold edit by the owner sends the mute back unchanged: nothing new is told.
      const edit = await save(org, wf, { threshold: 4, mutedUntil: until });
      expect(edit.muteChange).toBeNull();
      const [kept] = await db
        .select()
        .from(workflowFailureAlertOverrides)
        .where(eq(workflowFailureAlertOverrides.workflowId, wf));
      expect(kept?.mutedBy).toBe(admin.id);
      expect(kept?.muteReason).toBe("RPC migration");
      expect(await notices(org.orgId, "workflow_muted")).toHaveLength(2);

      // Extending is a change: told again.
      const extended = await save(org, wf, {
        threshold: 4,
        mutedUntil: inHours(48),
        muteReason: "Still migrating",
      });
      expect(extended.muteChange).toBe("changed");
      const after = await notices(org.orgId, "workflow_muted");
      expect(after).toHaveLength(4);
      expect(after.some((d) => d.context?.changed === true)).toBe(true);

      const view = await settings.loadOrgSettingsView(org.orgId, org.userId);
      expect(view.mutedWorkflows).toEqual([
        expect.objectContaining({
          id: wf,
          by: "muteannounce owner",
          byAccount: org.email,
          reason: "Still migrating",
          failing: false,
          failedRuns: 0,
        }),
      ]);

      // Unmute: told, and the workflow leaves the muted list.
      const unmuted = await save(org, wf, { threshold: 4 });
      expect(unmuted.muteChange).toBe("unmuted");
      expect(await notices(org.orgId, "workflow_unmuted")).toHaveLength(2);
      const cleared = await settings.loadOrgSettingsView(org.orgId, org.userId);
      expect(cleared.mutedWorkflows).toEqual([]);
    });

    it("ends an expired mute exactly once, counts what it hid, and alerts at once when still failing", async () => {
      const org = await makeOrg("muteexpire");
      const wf = await makeWorkflow(org, "Expiring mute");
      await save(org, wf, {
        mutedUntil: inHours(1),
        muteReason: "Maintenance",
      });
      await db
        .update(workflowFailureAlertOverrides)
        .set({ mutedAt: at(-8) })
        .where(eq(workflowFailureAlertOverrides.workflowId, wf));
      // Inside the org's counting window, so they would have alerted.
      await addFailures(org, wf, 4, -6);
      await runCycle();
      expect(await openIncident(wf)).toBeUndefined();
      const muted = await settings.loadOrgSettingsView(org.orgId, org.userId);
      expect(muted.mutedWorkflows[0]).toMatchObject({
        failing: true,
        failedRuns: 4,
      });

      await db
        .update(workflowFailureAlertOverrides)
        .set({ mutedUntil: at(-1) })
        .where(eq(workflowFailureAlertOverrides.workflowId, wf));
      await runCycle();
      await runCycle();
      const ended = await notices(org.orgId, "mute_ended");
      expect(ended).toHaveLength(1);
      expect(ended[0]?.context).toMatchObject({
        ended: "expired",
        failedRuns: 4,
        failingNow: true,
        mutedBy: "muteexpire owner",
        reason: "Maintenance",
      });
      expect(typeof ended[0]?.context?.until).toBe("string");
      expect(await openIncident(wf)).toBeDefined();
      expect((await notices(org.orgId, "alert")).length).toBeGreaterThan(0);
    });

    it("ends an until-it-works mute once when it works", async () => {
      const org = await makeOrg("muteworks");
      const wf = await makeWorkflow(org, "Works again");
      await save(org, wf, { muteUntilSuccess: true, muteReason: "Flaky RPC" });
      // Started a little earlier, so the success below clearly comes after it.
      await db
        .update(workflowFailureAlertOverrides)
        .set({ mutedAt: at(-5) })
        .where(eq(workflowFailureAlertOverrides.workflowId, wf));
      await addRun(org, wf, "success");
      await runCycle();
      await addRun(org, wf, "success");
      await runCycle();
      const ended = await notices(org.orgId, "mute_ended");
      expect(ended).toHaveLength(1);
      expect(ended[0]?.context).toMatchObject({
        ended: "worked",
        failingNow: false,
      });
      const view = await settings.loadOrgSettingsView(org.orgId, org.userId);
      expect(view.mutedWorkflows).toEqual([]);
    });

    it("tells people taken off a list, and owners; adding people removes nobody", async () => {
      const org = await makeOrg("removed");
      const admin = await person(org, "admin", "removedadmin");
      const helper = await person(org, "member", "removedhelper");
      const wf = await makeWorkflow(org, "Own list");
      // From the org's list (the owner) to a longer one: nobody was removed.
      await save(org, wf, {
        recipientUserIds: [org.userId, admin.id, helper.id],
      });
      expect(await notices(org.orgId, "recipients_removed")).toHaveLength(0);
      await save(org, wf, { recipientUserIds: [org.userId, admin.id] });
      const removed = await notices(org.orgId, "recipients_removed");
      expect(removed.map((d) => d.recipient).sort()).toEqual(
        [helper.email, org.email].sort()
      );
      expect(removed[0]?.context).toMatchObject({
        removed: ["removedhelper"],
        workflowId: wf,
      });

      // The org's own list: same rule.
      await settings.saveOrgSettings(
        org.orgId,
        await settings.parseOrgSettings(
          {
            threshold: 3,
            recipientUserIds: [org.userId, admin.id],
            version: 0,
          },
          org.orgId
        ),
        org.userId
      );
      const [row] = await db
        .select({ version: orgFailureAlertSettings.version })
        .from(orgFailureAlertSettings)
        .where(eq(orgFailureAlertSettings.organizationId, org.orgId));
      await settings.saveOrgSettings(
        org.orgId,
        await settings.parseOrgSettings(
          {
            threshold: 3,
            recipientUserIds: [org.userId],
            version: row?.version ?? 0,
          },
          org.orgId
        ),
        org.userId
      );
      const orgRemoved = (
        await notices(org.orgId, "recipients_removed")
      ).filter((d) => d.context?.workflowId === undefined);
      expect(orgRemoved.map((d) => d.recipient).sort()).toEqual(
        [admin.email, org.email].sort()
      );
    });

    it("tells the owners when an admin narrows the default list to themselves, org-wide or on a workflow", async () => {
      const org = await makeOrg("narrowed");
      const admin = await person(org, "admin", "narrowadmin");
      await settings.saveOrgSettings(
        org.orgId,
        await settings.parseOrgSettings(
          { threshold: 3, recipientUserIds: [admin.id], version: 0 },
          org.orgId
        ),
        admin.id
      );
      const orgRemoved = await notices(org.orgId, "recipients_removed");
      expect(orgRemoved.map((d) => d.recipient)).toContain(org.email);
      expect(orgRemoved[0]?.context).toMatchObject({
        removed: ["narrowed owner"],
      });

      // A workflow following the org's list (owner + admin) gets its own list of one.
      const [row] = await db
        .select({ version: orgFailureAlertSettings.version })
        .from(orgFailureAlertSettings)
        .where(eq(orgFailureAlertSettings.organizationId, org.orgId));
      await settings.saveOrgSettings(
        org.orgId,
        await settings.parseOrgSettings(
          {
            threshold: 3,
            recipientUserIds: [org.userId, admin.id],
            version: row?.version ?? 0,
          },
          org.orgId
        ),
        org.userId
      );
      const wf = await makeWorkflow(org, "Narrowed workflow");
      await save(org, wf, { recipientUserIds: [admin.id] }, admin.id);
      const wfRemoved = (await notices(org.orgId, "recipients_removed")).filter(
        (d) => d.context?.workflowId === wf
      );
      expect(wfRemoved.map((d) => d.recipient)).toContain(org.email);
    });

    it("keeps an expired mute for the cycle to end and announce, whatever is saved meanwhile", async () => {
      const org = await makeOrg("muteexpiredsave");
      const wf = await makeWorkflow(org, "Expired then saved");
      await save(org, wf, { mutedUntil: inHours(1), muteReason: "Upgrade" });
      await db
        .update(workflowFailureAlertOverrides)
        .set({ mutedUntil: at(-1) })
        .where(eq(workflowFailureAlertOverrides.workflowId, wf));
      const loaded = await workflowSettings.loadWorkflowForAlerts(wf);
      if (!loaded) {
        throw new Error("workflow not found");
      }
      const view = await workflowSettings.loadWorkflowAlertView(
        loaded,
        org.userId
      );
      // Shown as not muted, so saving the view back cannot re-mute.
      expect(view.override.mutedUntil).toBeNull();
      expect(view.override.muteUntilSuccess).toBe(false);
      const edit = await save(org, wf, { threshold: 4 });
      expect(edit.muteChange).toBeNull();
      await runCycle();
      expect(await notices(org.orgId, "mute_ended")).toHaveLength(1);
    });

    it("sends a reminder at once when a mute ends on an incident still open from before it", async () => {
      const org = await makeOrg("mutereminder");
      const wf = await makeWorkflow(org, "Muted after its alert");
      await addRun(org, wf, "success", { at: at(-120) });
      await addFailures(org, wf, 3);
      await runCycle();
      expect(await openIncident(wf)).toBeDefined();
      await save(org, wf, { mutedUntil: inHours(1), muteReason: "Looking" });
      await addFailures(org, wf, 2, -2);
      await runCycle();
      const before = (await notices(org.orgId, "reminder")).length;
      await db
        .update(workflowFailureAlertOverrides)
        .set({ mutedUntil: at(-1) })
        .where(eq(workflowFailureAlertOverrides.workflowId, wf));
      await runCycle();
      await runCycle();
      expect((await notices(org.orgId, "reminder")).length).toBeGreaterThan(
        before
      );
    });

    it("ends an until-it-works mute only on a success after it began", async () => {
      const org = await makeOrg("muteearly");
      const wf = await makeWorkflow(org, "Old success");
      await addRun(org, wf, "success", { at: at(-30) });
      await save(org, wf, { muteUntilSuccess: true, muteReason: "Watching" });
      // Started a little earlier, so the success below clearly comes after it.
      await db
        .update(workflowFailureAlertOverrides)
        .set({ mutedAt: at(-5) })
        .where(eq(workflowFailureAlertOverrides.workflowId, wf));
      await runCycle();
      expect(await notices(org.orgId, "mute_ended")).toHaveLength(0);
      await addRun(org, wf, "success");
      await runCycle();
      expect(await notices(org.orgId, "mute_ended")).toHaveLength(1);
    });

    it("refuses a seventh mute change in an hour, and announces a reason-only change", async () => {
      const org = await makeOrg("mutelimit");
      const wf = await makeWorkflow(org, "Toggled");
      const until = inHours(3);
      await save(org, wf, { mutedUntil: until, muteReason: "First reason" });
      const reworded = await save(org, wf, {
        mutedUntil: until,
        muteReason: "Second reason",
      });
      expect(reworded.muteChange).toBe("changed");
      for (const i of [1, 2]) {
        await save(org, wf, {});
        await save(org, wf, { mutedUntil: until, muteReason: `Again ${i}` });
      }
      const tooMany = await settingsError(() => save(org, wf, {}));
      expect(tooMany.status).toBe(429);
    });

    it("tells reachable admins when no owner can get email", async () => {
      const org = await makeOrg("walletowner");
      const adminA = await person(org, "admin", "walletadmina");
      const adminB = await person(org, "admin", "walletadminb");
      await db
        .update(users)
        .set({
          email: `0x${Array.from({ length: 40 }, () => Math.floor(Math.random() * 16).toString(16)).join("")}@wallet.keeperhub.com`,
        })
        .where(eq(users.id, org.userId));
      await settings.saveOrgSettings(
        org.orgId,
        await settings.parseOrgSettings(
          { threshold: 3, recipientUserIds: [adminA.id], version: 0 },
          org.orgId
        ),
        adminA.id
      );
      const wf = await makeWorkflow(org, "Quiet admin");
      await save(
        org,
        wf,
        { mutedUntil: inHours(2), muteReason: "Mine" },
        adminA.id
      );
      const told = (await notices(org.orgId, "workflow_muted")).map(
        (d) => d.recipient
      );
      expect(told).toContain(adminB.email);
    });

    it("lists mute notices in Sent alerts and finds a workflow by id or its current name", async () => {
      const org = await makeOrg("wfilter");
      const wf = await makeWorkflow(org, "Old name");
      await addRun(org, wf, "success", { at: at(-120) });
      await addFailures(org, wf, 3);
      await runCycle();
      await save(org, wf, { mutedUntil: inHours(2), muteReason: "Checking" });
      await db
        .update(workflows)
        .set({ name: wfName("Brand new name") })
        .where(eq(workflows.id, wf));
      const kinds = async (filter: Record<string, string>) =>
        (
          await settings.loadHistory(org.orgId, {
            page: 1,
            limit: 100,
            ...filter,
          })
        ).entries.map((e) => e.kind);
      const byName = await kinds({ workflow: "brand new" });
      expect(byName).toContain("alert");
      expect(byName).toContain("workflow_muted");
      expect(await kinds({ workflow: wf })).toEqual(byName);
      expect(await kinds({ workflow: "Old name" })).toEqual([]);
      const muted = (
        await settings.loadHistory(org.orgId, {
          page: 1,
          kind: "workflow_muted",
        })
      ).entries[0];
      expect(muted?.by).toBe("wfilter owner");
      expect(muted?.byAccount).toBe(org.email);
      expect(muted?.note).toBe("Reason: Checking");
      // The end time goes to the page as a timestamp, shown in the viewer's time.
      expect(muted?.muteUntil?.at).toBeTruthy();
      expect(muted?.workflows[0]?.id).toBe(wf);
      // Shown by default with the alerts, and under People's actions.
      expect(await kinds({ scope: "alerts" })).toContain("workflow_muted");
      const people = await kinds({ scope: "people" });
      expect(people).toContain("workflow_muted");
      expect(people).not.toContain("alert");
    });
  });
});
