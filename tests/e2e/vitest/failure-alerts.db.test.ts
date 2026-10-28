import "dotenv/config";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq, isNull, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
let createIntegration: CreateIntegration;

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
  status: "success" | "error" | "skipped" | "system_error",
  options: { at?: Date; source?: string; credential?: string } = {}
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
  });
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

const PAUSED_WORDING = /paused/i;
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

    it("does not open an incident at 4 automated failures (manual, skipped and system errors do not count)", async () => {
      for (let i = 0; i < 4; i++) {
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

    it("opens an incident and emails the owner at the 5th automated failure, linking to the Runs tab", async () => {
      await addRun(acme, wf, "error", { at: at(-1) });
      await runCycle();
      const incident = await openIncident(wf);
      incidentId = incident?.id;
      expect(incident?.failureCount).toBe(5);
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
      expect((await openIncident(wf))?.failureCount).toBe(7);
    });

    it("sends a daily reminder while it keeps failing", async () => {
      await db
        .update(workflowFailureIncidents)
        .set({ lastNotifiedAt: at(-25 * 60) })
        .where(eq(workflowFailureIncidents.workflowId, wf));
      await runCycle();
      expect(await sentEmails(acme, "reminder")).toHaveLength(1);
    });

    it("resolves on an automated success and sends a recovery email", async () => {
      await addRun(acme, wf, "success");
      await runCycle();
      expect(await openIncident(wf)).toBeUndefined();
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
      expect(state).toEqual({ unreachable: true, failingWorkflows: 1 });
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

    it("closes with a running-again message once it runs", async () => {
      await addRun(theta, wf, "success", { at: at(0.5) });
      await runCycle();
      expect((await incidentById(incidentId))?.resolvedReason).toBe("ran");
      expect(await sentEmails(theta, "recovery")).toHaveLength(1);
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
        byEmail: iota.email,
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
        byEmail: iota.email,
        now: new Date(),
      });
      await runCycle();
      expect(await sentEmails(iota, "alerts_resumed")).toHaveLength(1);
      expect(await openIncident(wf)).toBeDefined();
      expect(await sentEmails(iota, "alert")).toHaveLength(1);
      expect(mailsAbout(iota, "Maintenance Keeper").length).toBeGreaterThan(0);
    });

    it("refuses a pause longer than 7 days", async () => {
      const error = await settingsError(() =>
        orgPause.pauseOrgAlerts({
          organizationId: iota.orgId,
          until: at(8 * 24 * 60).toISOString(),
          reason: null,
          byEmail: null,
          now: new Date(),
        })
      );
      expect(error.status).toBe(400);
      expect(error.message).toContain("7 days");
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
      expect(parsed.channels.map((c) => c.kind)).toContain("discord");
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
      expect(restored?.pausedReason).toBe(reason);
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
      const history = await settings.loadHistory(org.orgId, { limit: 50 });
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
      const all = await settings.loadHistory(org.orgId, { limit: 50 });
      const filtered = await settings.loadHistory(org.orgId, {
        workflowId: wf,
      });
      expect(filtered.length).toBeGreaterThan(0);
      expect(filtered.length).toBeLessThan(all.length);
      expect(filtered.every((h) => h.workflows.some((w) => w.id === wf))).toBe(
        true
      );
    });

    it("exports CSV with a header and one row per entry", async () => {
      const history = await settings.loadHistory(org.orgId, { limit: 50 });
      const csv = settings.historyToCsv(history);
      expect(csv.trim().split("\n")).toHaveLength(history.length + 1);
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
});
