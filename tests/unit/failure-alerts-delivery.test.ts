import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));

const { buildMessageRows } = await import(
  "@/lib/notifications/failure-alerts/queue-rows"
);
const { nextRetryDelayMs } = await import(
  "@/lib/notifications/failure-alerts/outbox"
);
const { channelLabel } = await import(
  "@/lib/notifications/failure-alerts/view-types"
);
const { dedupKeyFor } = await import(
  "@/lib/notifications/failure-alerts/queue-rows"
);
const { explainFailure } = await import(
  "@/lib/notifications/failure-alerts/senders"
);
const { runsOnItsOwn, workflowTriggerType } = await import(
  "@/lib/notifications/failure-alerts/workflow-trigger"
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
      scope: "i:inc",
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
      scope: "i:inc",
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
      scope: "i:inc",
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
      scope: "i:inc",
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
        organizationId: "org-1",
        workflow,
        incident,
        appUrl: "https://app.test",
      },
      now
    );
    expect(message.subject).toBe(
      "[Acme] Action needed: OETH Vault TVL Watchdog failed 5 times in a row"
    );
    expect(message.chat).toContain("execution reverted (RPC 429)");
    expect(message.chat).toContain("https://app.test/workflows/wf-1?tab=runs");
  });

  it("marks a backup and says why", () => {
    const message = renderMessage(
      {
        kind: "alert",
        orgName: "Acme",
        organizationId: "org-1",
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
        organizationId: "org-1",
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
        organizationId: "org-1",
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
      organizationId: "org",
      appUrl: "https://app.keeperhub.com",
      channelLabel: "Slack #ops",
    });
    expect(message.subject).toMatch(
      /^\[Test\] \[Acme\] Action needed: Example keeper failed 5 times in a row/
    );
    expect(message.chat).toContain(
      "Nothing is failing: this is how a real alert looks"
    );
    expect(message.chat).toContain("Last error:");
    expect(message.html).toContain("Last error:");
  });
});

describe("message wording after review", () => {
  const workflow = {
    id: "wf-1",
    name: "Rebalance vault",
    triggerLabel: "Schedule",
  };
  const base = {
    orgName: "Acme",
    organizationId: "org-1",
    appUrl: "https://app.test",
    workflow,
  };
  const incident = {
    failureCount: 6,
    firstFailedAt: new Date("2026-10-28T10:00:00Z"),
    lastError: "insufficient funds for gas * price + value",
    openedBy: "count" as const,
  };

  it("puts the org first in chat and says how to change who gets it", () => {
    const message = renderMessage({ ...base, kind: "alert", incident }, now);
    expect(message.chat.startsWith("[Acme] ")).toBe(true);
    expect(message.text).toContain(
      "Change who gets these: https://app.test/settings/org-1/alerts"
    );
    expect(message.text).toContain(
      "Open the failing workflow: https://app.test/workflows/wf-1"
    );
  });

  it("shows how unusual the failure is", () => {
    const message = renderMessage(
      {
        ...base,
        kind: "alert",
        incident: {
          ...incident,
          before: {
            successes: 214,
            lastSuccessAt: new Date("2026-10-28T11:00:00Z"),
          },
        },
      },
      now
    );
    expect(message.text).toContain(
      "Before this: 214 successful runs in 30 days, the last at 2026-10-28 11:00 UTC."
    );
    expect(message.chat).toContain("Before this: 214 successful runs");
  });

  it("words a reminder as still failing, once", () => {
    const message = renderMessage({ ...base, kind: "reminder", incident }, now);
    expect(message.subject).toBe(
      "[Acme] Still failing: Rebalance vault: 6 failed runs in a row"
    );
  });

  it("hints at gas and RPC causes", () => {
    const gas = renderMessage({ ...base, kind: "alert", incident }, now);
    expect(gas.text).toContain("running out of funds");
    const rpc = renderMessage(
      {
        ...base,
        kind: "alert",
        incident: {
          ...incident,
          lastError: "request failed: 429 Too Many Requests",
        },
      },
      now
    );
    expect(rpc.text).toContain("RPC provider problem");
  });
});

describe("explainFailure", () => {
  it("says what a provider refusal means and keeps the code", () => {
    expect(explainFailure("telegram", 401, "Telegram returned HTTP 401.")).toBe(
      "Telegram rejected the bot token. Reconnect the bot in Connections (HTTP 401)."
    );
    expect(explainFailure("discord", 404, "x")).toContain(
      "webhook was deleted"
    );
    expect(explainFailure("slack", 200, "not_in_channel")).toBe(
      "The KeeperHub app is not in that channel. Invite it (not_in_channel)."
    );
    expect(explainFailure("telegram", 500, "Telegram returned HTTP 500.")).toBe(
      "Telegram returned HTTP 500."
    );
  });
});

describe("dedupKeyFor", () => {
  const row = {
    scope: "i:inc",
    organizationId: "org",
    incidentId: "inc",
    kind: "alert" as const,
    sequence: 0,
    channel: "email" as const,
    recipient: "a@x.dev",
  };

  it("is the same for the same message and differs for a backup or a group", () => {
    expect(dedupKeyFor(row)).toBe(dedupKeyFor({ ...row }));
    expect(dedupKeyFor(row)).not.toBe(dedupKeyFor({ ...row, isBackup: true }));
    expect(dedupKeyFor({ ...row, scope: "g:a", incidentId: null })).not.toBe(
      dedupKeyFor({ ...row, scope: "g:b", incidentId: null })
    );
  });
});

describe("workflowTriggerType", () => {
  const nodes = (triggerType: string) => [
    { data: { type: "trigger", config: { triggerType } } },
  ];

  it("reads the trigger like the editor does", () => {
    expect(workflowTriggerType(nodes("Schedule"))).toBe("Schedule");
    expect(workflowTriggerType(nodes("Pyth Price"))).toBe("Pyth Price");
    expect(workflowTriggerType(nodes("Scheduled"))).toBeNull();
    expect(workflowTriggerType([])).toBeNull();
  });

  it("counts every trigger that runs on its own, not Manual", () => {
    expect(runsOnItsOwn("Transfer")).toBe(true);
    expect(runsOnItsOwn("Manual")).toBe(false);
    expect(runsOnItsOwn(null)).toBe(false);
  });
});
