import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));

const { buildMessageRows } = await import(
  "@/lib/notifications/failure-alerts/evaluator"
);
const { channelLabel, nextRetryDelayMs } = await import(
  "@/lib/notifications/failure-alerts/outbox"
);
const { renderMessage } = await import(
  "@/lib/notifications/failure-alerts/messages"
);

const now = new Date("2026-10-28T12:00:00Z");

const channel = (
  kind: "slack" | "discord" | "telegram" | "pagerduty",
  patch: Record<string, unknown> = {}
) => ({
  id: `c-${kind}`,
  kind,
  integrationId: `i-${kind}`,
  destination: kind === "discord" ? "" : `dest-${kind}`,
  role: "always" as const,
  pausedAt: null,
  ...patch,
});

describe("buildMessageRows", () => {
  it("queues email per recipient and every live 'always' channel", () => {
    const rows = buildMessageRows({
      organizationId: "org",
      incidentId: "inc",
      kind: "alert",
      sequence: 0,
      emails: ["a@x.dev", "b@x.dev"],
      channels: [
        channel("slack"),
        channel("discord", { role: "backup" }),
        channel("telegram", { pausedAt: new Date() }),
        channel("pagerduty"),
      ],
      includePagerDuty: true,
      now,
    });
    expect(rows.map((r) => `${r.channel}:${r.recipient}`)).toEqual([
      "email:a@x.dev",
      "email:b@x.dev",
      "slack:dest-slack",
      "pagerduty:dest-pagerduty",
    ]);
  });

  it("gives PagerDuty two minutes and the rest fifteen before backups", () => {
    const rows = buildMessageRows({
      organizationId: "org",
      incidentId: "inc",
      kind: "alert",
      sequence: 0,
      emails: ["a@x.dev"],
      channels: [channel("pagerduty")],
      includePagerDuty: true,
      now,
    });
    const offset = (row: (typeof rows)[number]) =>
      ((row.backupAt as Date).getTime() - now.getTime()) / 60_000;
    expect(offset(rows[0])).toBe(15);
    expect(offset(rows[1])).toBe(2);
  });

  it("never sends reminders to PagerDuty", () => {
    const rows = buildMessageRows({
      organizationId: "org",
      incidentId: "inc",
      kind: "reminder",
      sequence: 1,
      emails: ["a@x.dev"],
      channels: [channel("pagerduty")],
      includePagerDuty: false,
      now,
    });
    expect(rows.map((r) => r.channel)).toEqual(["email"]);
  });

  it("records that nobody could be emailed so the backups fire", () => {
    const rows = buildMessageRows({
      organizationId: "org",
      incidentId: "inc",
      kind: "alert",
      sequence: 0,
      emails: [],
      channels: [],
      includePagerDuty: true,
      now,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      channel: "email",
      recipient: "(nobody reachable)",
      state: "failed",
    });
  });
});

describe("nextRetryDelayMs", () => {
  it("backs off 1, 2, 5, 15, 30 minutes then hourly", () => {
    const minutes = [1, 2, 3, 4, 5, 6, 9].map(
      (attempt) => nextRetryDelayMs(attempt, undefined) / 60_000
    );
    expect(minutes).toEqual([1, 2, 5, 15, 30, 60, 60]);
  });

  it("waits at least as long as the provider asked", () => {
    expect(nextRetryDelayMs(1, 10 * 60_000)).toBe(10 * 60_000);
  });
});

describe("channelLabel", () => {
  it("names the destination, or the connection for Discord", () => {
    expect(channelLabel("slack", "#ops")).toBe("Slack #ops");
    expect(channelLabel("discord", "", "Origin alerts")).toBe(
      "Discord Origin alerts"
    );
    expect(channelLabel("pagerduty", "PXYZ")).toBe("PagerDuty PXYZ");
  });
});

describe("renderMessage", () => {
  const workflow = {
    id: "wf-1",
    name: "OETH Vault TVL Watchdog",
    triggerLabel: "Schedule",
  };
  const incident = {
    failureCount: 5,
    firstFailedAt: new Date("2026-10-28T10:45:00Z"),
    lastError: "execution reverted\n(RPC 429)",
    openedBy: "count" as const,
  };

  it("says which workflow, how often, the error and where to look", () => {
    const message = renderMessage(
      {
        kind: "alert",
        orgName: "Acme",
        workflow,
        incident,
        appUrl: "https://app.test",
      },
      now
    );
    expect(message.subject).toBe(
      "[Acme] OETH Vault TVL Watchdog is failing: 5 failed runs in a row"
    );
    expect(message.chat).toContain("execution reverted (RPC 429)");
    expect(message.chat).toContain("https://app.test/workflows/wf-1?tab=runs");
  });

  it("marks a backup and says why", () => {
    const message = renderMessage(
      {
        kind: "alert",
        orgName: "Acme",
        workflow,
        incident,
        appUrl: "https://app.test",
        backupReason:
          "PagerDuty could not be reached (HTTP 503), nobody has been paged yet",
      },
      now
    );
    expect(message.subject.startsWith("[Backup] ")).toBe(true);
    expect(message.chat).toContain("nobody has been paged yet");
    expect(message.html).toContain("Backup alert:");
  });

  it("describes a time-limit alert by how long it has failed", () => {
    const message = renderMessage(
      {
        kind: "alert",
        orgName: "Acme",
        workflow,
        incident: { ...incident, failureCount: 2, openedBy: "time" },
        appUrl: "https://app.test",
      },
      now
    );
    expect(message.subject).toContain("has been failing for 1 hour");
  });

  it("escapes names in the HTML", () => {
    const message = renderMessage(
      {
        kind: "alert",
        orgName: "Acme",
        workflow: { ...workflow, name: "<script>x</script>" },
        incident,
        appUrl: "https://app.test",
      },
      now
    );
    expect(message.html).not.toContain("<script>x</script>");
  });

  it("labels a test so nobody acts on it", () => {
    const message = renderMessage({
      kind: "test",
      orgName: "Acme",
      channelLabel: "Slack #ops",
    });
    expect(message.chat).toContain("KeeperHub test, no action needed");
  });
});
