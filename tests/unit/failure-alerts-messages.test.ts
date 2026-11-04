import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));

const { pauseActorName, renderMessage, renderSample } = await import(
  "@/lib/notifications/failure-alerts/messages"
);
const { CHAT_LIMITS, fitChat } = await import("@/lib/notifications/chat-text");
const { methodName, methodText, orgPauseEffect } = await import(
  "@/lib/notifications/failure-alerts/view-types"
);

const now = new Date("2026-10-28T12:00:00Z");
const org = {
  orgName: "Acme",
  organizationId: "org-1",
  appUrl: "https://app.test",
};
const workflow = { id: "wf-1", name: "Keeper", triggerLabel: "Schedule" };
const WALLETS = "https://app.test/settings/org-1/wallets";

describe("cap warning", () => {
  const cap = (used: number, chatWorks?: boolean) =>
    renderMessage({ ...org, kind: "cap_warning", used, limit: 100, chatWorks });

  it("says nobody is told when the emails run out and no chat works", () => {
    const message = cap(100, false);
    expect(message.text).toContain(
      "From now until the 1st, nobody is told about new failures. Add Slack, Discord, Telegram or PagerDuty, or upgrade."
    );
  });

  it("says chat and PagerDuty still get alerts when one works", () => {
    const message = cap(100, true);
    expect(message.text).toContain(
      "new failure alerts go only to your chat and PagerDuty methods, not email"
    );
    expect(message.text).not.toContain("nobody is told");
  });

  it("covers both cases when it is not known", () => {
    expect(cap(100).text).toContain("without one of those, nobody is told");
  });

  it("explains the last 10 in plain words before the limit", () => {
    const message = cap(80, true);
    expect(message.text).toContain(
      "After 90, only alerts about new failures go by email; reminders and recovery messages do not."
    );
    expect(message.text).not.toContain("nobody is told");
    expect(cap(80, false).text).toContain(
      "Once all 100 are used, nobody is told until the 1st. Add Slack"
    );
  });
});

describe("wallet out of funds", () => {
  const incident = {
    failureCount: 2,
    firstFailedAt: new Date("2026-10-28T11:00:00Z"),
    lastError: "Insufficient ETH balance. Have: 0.0004, Need: 0.0006",
    openedBy: "funding" as const,
  };

  it("leads with an Add funds button to the wallets page", () => {
    const message = renderMessage(
      { ...org, kind: "alert", workflow, incident },
      now
    );
    const add = message.html.indexOf(`href="${WALLETS}"`);
    const open = message.html.indexOf('href="https://app.test/workflows/wf-1"');
    expect(add).toBeGreaterThan(-1);
    expect(open).toBeGreaterThan(add);
    expect(message.html).toContain("Add funds");
    expect(message.text).toContain(`Add funds: ${WALLETS}`);
    expect(message.text).not.toContain("This looks like the wallet");
  });

  it("keeps the trigger line apart from the advice", () => {
    const message = renderMessage(
      { ...org, kind: "alert", workflow, incident },
      now
    );
    expect(message.html).toMatch(/<p[^>]*>Schedule trigger, Acme\.<\/p>/);
  });

  it("names the cause when it pauses the workflow", () => {
    const message = renderMessage(
      { ...org, kind: "alert", workflow, incident, paused: "first" },
      now
    );
    expect(message.subject).toContain(
      "Wallet out of funds: Keeper was paused after 2 failed runs in a row"
    );
    expect(message.html).toContain(WALLETS);
  });

  it("has no Add funds button for other failures", () => {
    const message = renderMessage(
      {
        ...org,
        kind: "alert",
        workflow,
        incident: { ...incident, openedBy: "count" },
      },
      now
    );
    expect(message.html).not.toContain(WALLETS);
  });
});

describe("grouped alert", () => {
  const row = (i: number, lastError: string | null = "RPC 429") => ({
    id: `wf-${i}`,
    name: `Workflow ${i}`,
    triggerLabel: "Schedule",
    failureCount: 5,
    lastError,
  });

  it("prefixes out-of-funds rows and offers Add funds", () => {
    const message = renderMessage({
      ...org,
      kind: "grouped",
      workflows: [
        row(1, "Insufficient ETH balance. Have: 0.1, Need: 0.2"),
        row(2),
        { ...row(3), openedBy: "funding" },
      ],
    });
    expect(message.text).toContain("- Wallet out of funds: Workflow 1: ");
    expect(message.text).toContain("- Workflow 2: ");
    expect(message.text).toContain("- Wallet out of funds: Workflow 3: ");
    expect(message.html).toContain("<strong>Wallet out of funds:</strong>");
    expect(message.text).toContain(`Add funds: ${WALLETS}`);
  });

  it("lists 10 workflows, then how many more", () => {
    const workflows = Array.from({ length: 13 }, (_, i) => row(i + 1));
    const message = renderMessage({ ...org, kind: "grouped", workflows });
    expect(message.subject).toContain("13 workflows started failing");
    expect(message.text).toContain("Workflow 10:");
    expect(message.text).not.toContain("Workflow 11:");
    expect(message.text).toContain("And 3 more.");
    expect(message.html).toContain("And 3 more.");
    expect(message.html).not.toContain(WALLETS);
  });
});

describe("org pause", () => {
  const paused = (pausingWorkflows?: number) =>
    renderMessage({
      ...org,
      kind: "alerts_paused",
      until: new Date("2026-10-28T16:00:00Z"),
      reason: "Upgrade",
      by: "Ana",
      pausingWorkflows,
    });

  it("says workflows set to turn off still turn off", () => {
    expect(paused(2).text).toContain(
      "Ana paused them: Upgrade. Failures are not reported until then. Workflows keep running, but the 2 set to turn off at their limit still turn off; you are told about those when the pause ends."
    );
    expect(paused(1).text).toContain(
      "the 1 set to turn off at its limit still turns off; you are told about it"
    );
    expect(paused().text).toContain("but any set to turn off");
    expect(paused(0).text).toContain(
      "Workflows keep running; failures are not reported until then."
    );
  });

  it("is worded the same on the Alerts page", () => {
    expect(paused(2).text).toContain(orgPauseEffect(2));
  });
});

describe("method names", () => {
  it("puts the connection first and where it sends second", () => {
    expect(methodName("telegram", "-100123", "Keeper bot")).toEqual({
      title: "Keeper bot",
      target: "Telegram -100123",
    });
    expect(methodName("discord", "", "Origin alerts")).toEqual({
      title: "Origin alerts",
      target: "Discord",
    });
    expect(methodText("slack", "#ops", "Ops")).toBe("Ops (Slack #ops)");
    expect(methodText("pagerduty", "PABC123", null)).toBe("PagerDuty PABC123");
  });
});

const CHANNELS = ["discord", "slack", "telegram"] as const;
const HOSTILE =
  "<!channel> <https://evil.example|Open the failing workflow> @everyone [x](https://evil.example) `tick` & co";
const LONG_NAME = `${HOSTILE} ${"n".repeat(300)}`;
const LONG_ERROR = `${HOSTILE} ${"e".repeat(3000)}`;

function fitsEverywhere(message: {
  chatVariants: Parameters<typeof fitChat>[0];
}) {
  for (const channel of CHANNELS) {
    expect(fitChat(message.chatVariants, channel).length).toBeLessThanOrEqual(
      CHAT_LIMITS[channel]
    );
  }
}

describe("chat length", () => {
  const failing = (i: number) => ({
    id: `wf-${i}-${"x".repeat(60)}`,
    name: `${LONG_NAME} ${i}`,
    triggerLabel: "Schedule",
    failureCount: 5,
    lastError: LONG_ERROR,
  });

  it("fits a grouped alert about many long workflows, ending in And N more", () => {
    const message = renderMessage({
      ...org,
      orgName: LONG_NAME,
      kind: "grouped",
      workflows: Array.from({ length: 40 }, (_, i) => failing(i)),
      backupReason: LONG_NAME,
    });
    fitsEverywhere(message);
    const discord = fitChat(message.chatVariants, "discord");
    expect(discord).toMatch(/And \d+ more\./);
    expect(discord).toContain("See all failing workflows: ");
  });

  it("keeps error text when it fits, and drops it before dropping workflows", () => {
    const small = renderMessage({
      ...org,
      kind: "grouped",
      workflows: [1, 2].map((i) => ({
        ...failing(i),
        name: `W${i}`,
        lastError: "RPC 429",
      })),
    });
    expect(fitChat(small.chatVariants, "discord")).toContain("`RPC 429`");
    const ten = renderMessage({
      ...org,
      kind: "grouped",
      workflows: Array.from({ length: 10 }, (_, i) => ({
        ...failing(i),
        name: `W${i}`,
      })),
    });
    const discord = fitChat(ten.chatVariants, "discord");
    expect(discord).not.toContain("eeee");
    expect(discord).toContain("W9:");
    expect(discord).not.toContain("more.");
  });

  it("fits every other message kind with long outside text", () => {
    const workflow = {
      id: "wf-1",
      name: LONG_NAME.repeat(20),
      triggerLabel: "Schedule",
    };
    const incident = {
      failureCount: 5,
      firstFailedAt: new Date("2026-10-28T11:00:00Z"),
      lastError: LONG_ERROR,
      openedBy: "count" as const,
    };
    const longOrg = { ...org, orgName: LONG_NAME.repeat(20) };
    const messages = [
      renderMessage(
        {
          ...longOrg,
          kind: "alert",
          workflow,
          incident,
          backupReason: LONG_NAME,
        },
        now
      ),
      renderMessage(
        {
          ...longOrg,
          kind: "reminder",
          workflow,
          incident,
          reminderNumber: 7,
          maxReminders: 7,
        },
        now
      ),
      renderMessage(
        { ...longOrg, kind: "alert", workflow, incident, paused: "again" },
        now
      ),
      renderMessage({ ...longOrg, kind: "recovery", workflow, incident }, now),
      renderMessage({
        ...longOrg,
        kind: "channel_paused",
        channelLabel: LONG_NAME,
        reason: LONG_ERROR,
      }),
      renderMessage({
        ...longOrg,
        kind: "alerts_paused",
        until: new Date("2026-10-29T12:00:00Z"),
        reason: LONG_ERROR,
        by: LONG_NAME,
      }),
      renderMessage({ ...longOrg, kind: "alerts_resumed", by: LONG_NAME }),
      renderMessage({ ...longOrg, kind: "cap_warning", used: 100, limit: 100 }),
      renderMessage({
        ...longOrg,
        kind: "launch_notice",
        threshold: 3,
        failingNow: [{ ...workflow, failureCount: 4 }],
      }),
      renderMessage({ ...longOrg, kind: "test", channelLabel: LONG_NAME }),
      ...(["alert", "missed", "paused", "recovery"] as const).map((sample) =>
        renderSample(longOrg, sample, LONG_NAME, now)
      ),
    ];
    for (const message of messages) {
      fitsEverywhere(message);
    }
  });
});

describe("chat escaping", () => {
  const incident = {
    failureCount: 3,
    firstFailedAt: new Date("2026-10-28T11:00:00Z"),
    lastError: HOSTILE,
    openedBy: "count" as const,
  };
  const message = renderMessage(
    {
      ...org,
      kind: "alert",
      workflow: { ...workflow, name: HOSTILE },
      incident,
    },
    now
  );

  it("escapes Slack mrkdwn and puts the error in a code span", () => {
    const slack = fitChat(message.chatVariants, "slack");
    expect(slack).not.toContain("<!channel>");
    expect(slack).not.toContain("<https://");
    expect(slack).toContain(
      "Last error: `&lt;!channel&gt; &lt;https://evil.example|Open the failing workflow&gt; @everyone [x](https://evil.example) 'tick' &amp; co`"
    );
  });

  it("escapes Discord markdown in names and keeps the error inside one code span", () => {
    const discord = fitChat(message.chatVariants, "discord");
    expect(discord).toContain("\\@everyone \\[x\\]\\(https://evil.example\\)");
    expect(discord).toContain(
      "Last error: `<!channel> <https://evil.example|Open the failing workflow> @everyone [x](https://evil.example) 'tick' & co`"
    );
  });

  it("escapes Telegram HTML and wraps the error in <code>", () => {
    const telegram = fitChat(message.chatVariants, "telegram");
    expect(telegram).not.toContain("<!channel>");
    expect(telegram).toContain("Last error: <code>&lt;!channel&gt;");
    expect(telegram.match(/<code>/g)).toHaveLength(1);
  });

  it("shows the preview unescaped", () => {
    expect(message.chat).toContain(
      `Last error: ${HOSTILE.replace("`tick`", "'tick'")}`
    );
  });

  it("escapes the org name, the pause reason and who paused", () => {
    const paused = renderMessage({
      ...org,
      orgName: "<!here>",
      kind: "alerts_paused",
      until: new Date("2026-10-29T12:00:00Z"),
      reason: "<!channel> upgrade",
      by: "<@U123>",
    });
    const slack = fitChat(paused.chatVariants, "slack");
    expect(slack).not.toMatch(/<[!@]/);
    expect(slack).toContain(
      "&lt;@U123&gt; paused them: &lt;!channel&gt; upgrade"
    );
  });
});

describe("pause notice actor", () => {
  it("names the person, never an email, else their role", () => {
    expect(pauseActorName({ name: "Ana Pop", role: "admin" })).toBe("Ana Pop");
    expect(pauseActorName({ name: "ana@x.io", role: "owner" })).toBe(
      "An owner"
    );
    expect(pauseActorName({ name: null, role: "admin" })).toBe("An admin");
    expect(pauseActorName({ name: "  ", role: "owner" })).toBe("An owner");
    expect(pauseActorName(undefined)).toBeNull();
  });
});
