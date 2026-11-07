import { describe, expect, it, vi } from "vitest";
import { PAYG_BLOCK_MESSAGES } from "@/lib/billing/payg/errors";
import { SCHEDULE_INVALID_REFUSAL } from "@/lib/workflow/not-executable";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));

const { pauseActorName, renderMessage, renderSample } = await import(
  "@/lib/notifications/failure-alerts/messages"
);
const { redactErrorSecrets } = await import("@/lib/utils/redact");
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

  it("names the cause when it turns the workflow off", () => {
    const message = renderMessage(
      { ...org, kind: "alert", workflow, incident, disabled: "first" },
      now
    );
    expect(message.subject).toContain(
      "Wallet out of funds: Keeper was turned off after 2 failed runs in a row"
    );
    expect(message.text).toContain(
      "set to turn off when it fails too often or runs out of funds"
    );
    expect(message.text).not.toContain("failure limit");
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
    // Opened by funds, but the latest error is something else.
    expect(message.text).toContain(
      "- Workflow 3: 5 failed runs in a row, ran out of funds earlier: RPC 429"
    );
    expect(message.html.match(/Wallet out of funds:/g)).toHaveLength(1);
    expect(message.text).toContain(`Add funds: ${WALLETS}`);
  });

  it("offers Add funds only when a listed workflow is out of funds now", () => {
    const message = renderMessage({
      ...org,
      kind: "grouped",
      workflows: [row(1), { ...row(2), openedBy: "funding" }],
    });
    expect(message.text).toContain("ran out of funds earlier");
    expect(message.text).not.toContain("Add funds");
    expect(message.chat).not.toContain("Add funds");
    expect(message.html).not.toContain("Add funds");
  });

  it("lists turned-off workflows first, then out of funds, then most failures", () => {
    const message = renderMessage({
      ...org,
      kind: "grouped",
      workflows: [
        { ...row(1), failureCount: 9 },
        { ...row(2), failureCount: 3, workflowDisabled: true },
        { ...row(3, "Insufficient ETH balance. Have: 0.1, Need: 0.2") },
        { ...row(4), failureCount: 12 },
      ],
    });
    expect(message.subject).toContain(
      "4 workflows started failing (1 turned off)"
    );
    const order = (text: string) =>
      [2, 3, 4, 1].map((i) => text.indexOf(`Workflow ${i}`));
    for (const text of [message.text, message.chat, message.html]) {
      const at = order(text);
      expect(at.every((n) => n > -1)).toBe(true);
      expect([...at].sort((a, b) => a - b)).toEqual(at);
    }
    expect(message.text).toContain(
      "Workflow 2: 3 failed runs in a row, turned off"
    );
  });

  it("keeps a turned-off workflow listed among 40 on Discord", () => {
    const workflows = Array.from({ length: 40 }, (_, i) => ({
      ...row(i),
      name: `${"Long workflow name ".repeat(4)}${i}`,
      failureCount: 50 - i,
      lastError: "e".repeat(400),
      workflowDisabled: i === 39,
    }));
    const message = renderMessage({ ...org, kind: "grouped", workflows });
    const discord = fitChat(message.chatVariants, "discord");
    expect(discord.length).toBeLessThanOrEqual(CHAT_LIMITS.discord);
    expect(discord).toContain(" 39: 11 failed runs in a row, turned off");
    expect(discord).toContain("40 workflows started failing (1 turned off)");
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
  const paused = (disablingWorkflows?: number) =>
    renderMessage({
      ...org,
      kind: "alerts_paused",
      until: new Date("2026-10-28T16:00:00Z"),
      reason: "Upgrade",
      by: "Ana",
      disablingWorkflows,
    });

  it("says workflows set to turn off still turn off", () => {
    expect(paused(2).text).toContain(
      "Ana paused them: Upgrade. Workflows keep running, but if one fails, no alert goes out until then. The 2 set to turn off at their limit still turn off; you are told about those when the pause ends."
    );
    expect(paused(1).text).toContain(
      "The 1 set to turn off at its limit still turns off; you are told about it"
    );
    expect(paused().text).toContain(
      "no alert goes out until then. Any set to turn off"
    );
    expect(paused(0).text).toContain(
      "Workflows keep running, but if one fails, no alert goes out until then."
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
        { ...longOrg, kind: "alert", workflow, incident, disabled: "again" },
        now
      ),
      renderMessage({ ...longOrg, kind: "recovery", workflow, incident }, now),
      renderMessage({
        ...longOrg,
        kind: "channel_stopped",
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
      ...(["alert", "missed", "disabled", "recovery"] as const).map((sample) =>
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

  it("keeps @names in outside text from becoming Telegram mentions", () => {
    const telegram = fitChat(message.chatVariants, "telegram");
    expect(telegram).toContain("@\u2060everyone");
    // The workflow name is in the first line; the error's code span cannot mention.
    expect(telegram.split("\n")[0]).not.toContain("@everyone");
  });

  it("leaves email addresses whole on Telegram", () => {
    const telegram = fitChat(
      [[{ user: "a@b.com (@ops) @lead,@x" }]],
      "telegram"
    );
    expect(telegram).toBe("a@b.com (@\u2060ops) @\u2060lead,@\u2060x");
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

describe("error text", () => {
  const SECRET_ERROR =
    "fetch https://eth-mainnet.g.alchemy.com/v2/abcdefghijklmnop1234 failed; " +
    "POST https://rpc.example.com/x?key=s3cr3t-key; Authorization: Bearer eyJhbGciOi.payload.sig; " +
    "api_key=sk_live_123456 password: hunter2 " +
    "https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXXXXXXXXXX " +
    "https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/sendMessage";
  const incident = {
    failureCount: 3,
    firstFailedAt: new Date("2026-10-28T11:00:00Z"),
    lastError: SECRET_ERROR,
    openedBy: "count" as const,
  };
  const LEAKS = [
    "abcdefghijklmnop1234",
    "s3cr3t-key",
    "eyJhbGciOi",
    "sk_live_123456",
    "hunter2",
    "XXXXXXXXXXXXXXXXXXXXXXXX",
    "AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw",
  ];

  it("masks keys, tokens and secret URLs in every channel", () => {
    const alert = renderMessage(
      { ...org, kind: "alert", workflow, incident },
      now
    );
    const grouped = renderMessage({
      ...org,
      kind: "grouped",
      workflows: [1, 2].map((i) => ({
        ...workflow,
        id: `wf-${i}`,
        failureCount: 3,
        lastError: SECRET_ERROR,
      })),
    });
    const paused = renderMessage({
      ...org,
      kind: "channel_stopped",
      channelLabel: "Telegram -100",
      reason: SECRET_ERROR,
    });
    for (const message of [alert, grouped, paused]) {
      const outputs = [
        message.text,
        message.html,
        message.chat,
        message.summary,
        ...CHANNELS.map((c) => fitChat(message.chatVariants, c)),
      ];
      for (const out of outputs) {
        for (const leak of LEAKS) {
          expect(out).not.toContain(leak);
        }
      }
    }
    expect(alert.text).toContain("Bearer [REDACTED]");
    expect(alert.text).toContain("api_key=[REDACTED]");
  });

  it("leaves ordinary error text alone", () => {
    const text =
      "execution reverted: Unsupported token: 0xA0b8 at https://example.com/hook";
    expect(redactErrorSecrets(text)).toBe(text);
  });

  it("ends shortened error text with an ellipsis", () => {
    const long = renderMessage(
      {
        ...org,
        kind: "alert",
        workflow,
        incident: { ...incident, lastError: "e".repeat(500) },
      },
      now
    );
    expect(long.text).toContain(`Last error: ${"e".repeat(299)}…\n`);
    const grouped = renderMessage({
      ...org,
      kind: "grouped",
      workflows: [1, 2].map((i) => ({
        ...workflow,
        id: `wf-${i}`,
        failureCount: 3,
        lastError: "e".repeat(500),
      })),
    });
    expect(grouped.text).toContain(`: ${"e".repeat(119)}… (`);
    const short = renderMessage(
      {
        ...org,
        kind: "alert",
        workflow,
        incident: { ...incident, lastError: "RPC 429" },
      },
      now
    );
    expect(short.text).toContain("Last error: RPC 429\n");
  });
});

describe("wording", () => {
  const missed = {
    failureCount: 1,
    firstFailedAt: new Date("2026-10-28T11:13:00Z"),
    lastError: null,
    openedBy: "missed" as const,
  };

  it("says when a missed run was due once, and only what the code does", () => {
    const message = renderMessage(
      { ...org, kind: "alert", workflow, incident: missed },
      now
    );
    expect(message.subject).toBe(
      "[Acme] Check: Keeper did not run when it was due"
    );
    expect(message.text.match(/11:13 UTC/g)).toHaveLength(1);
    expect(message.text).toContain(
      "Due at 2026-10-28 11:13 UTC, 47 minutes ago."
    );
    expect(message.text).toContain("it is reported to our team");
    expect(message.text).not.toContain("looking into it");
  });

  it("names the org once in pause notices and cap warnings", () => {
    const messages = [
      renderMessage({
        ...org,
        kind: "alerts_paused",
        until: new Date("2026-10-28T16:00:00Z"),
        reason: null,
        by: "Ana",
      }),
      renderMessage({ ...org, kind: "alerts_resumed", by: null }),
      renderMessage({ ...org, kind: "cap_warning", used: 100, limit: 100 }),
      renderMessage({ ...org, kind: "cap_warning", used: 80, limit: 100 }),
    ];
    for (const message of messages) {
      expect(message.subject.match(/Acme/g)).toHaveLength(1);
      expect(message.chat.split("\n")[0]?.match(/Acme/g)).toHaveLength(1);
    }
    expect(messages[0]?.subject).toBe(
      "[Acme] Alerts are paused for the whole organization until 2026-10-28 16:00 UTC"
    );
    expect(messages[3]?.subject).toBe(
      "[Acme] 80 of the 100 alert emails for this month are used"
    );
  });

  it("says how a stopped method comes back, by kind", () => {
    const stopped = (channelKind?: string) =>
      renderMessage({
        ...org,
        kind: "channel_stopped",
        channelLabel: "Slack #ops",
        channelKind,
        reason: "channel_not_found.",
      }).text;
    expect(stopped("slack")).toContain(
      "Nothing is sent to it until a test on it succeeds."
    );
    expect(stopped("slack")).not.toContain("by itself");
    expect(stopped("discord")).toContain(
      "it is checked every day and turns back on by itself when it works, or when a test succeeds."
    );
    expect(stopped()).toContain("apart from Slack");
  });

  it("names the workflow and links to it when the method is that workflow's own", () => {
    const message = renderMessage({
      ...org,
      kind: "channel_stopped",
      channelLabel: "Telegram -1001",
      channelKind: "telegram",
      reason: "chat not found.",
      workflow: { id: "wf-9", name: "Vault <keeper>" },
    });
    expect(message.subject).toContain(
      "Telegram -1001 stopped working for the workflow Vault <keeper>"
    );
    expect(message.text).toContain("Fix it: https://app.test/workflows/wf-9");
    expect(message.html).toContain("Vault &lt;keeper&gt;");
    expect(message.html).toContain("Open the workflow");
  });

  it("links samples to the Alerts page, and the funds sample to Add funds", () => {
    const ALERTS = "https://app.test/settings/org-1/alerts";
    for (const sample of ["alert", "missed", "disabled", "recovery"] as const) {
      const message = renderSample(org, sample, "Test", now);
      expect(message.text).not.toContain("/workflows/");
      expect(message.chat).not.toContain("/workflows/");
      expect(message.text).toContain(ALERTS);
    }
    const disabled = renderSample(org, "disabled", "Test", now);
    expect(disabled.text).toContain(`Add funds: ${WALLETS}`);
    expect(disabled.html).toContain(`href="${WALLETS}"`);
  });

  it("makes the alert sample a plain count alert, not a funds one", () => {
    const alert = renderSample(org, "alert", "Test", now);
    expect(alert.subject).toContain("Example keeper");
    expect(alert.text).toContain("failed 3 times in a row");
    expect(alert.text).not.toContain("out of funds");
    expect(alert.text).not.toContain("Add funds");
    expect(renderSample(org, "recovery", "Test", now).text).not.toContain(
      "Add funds"
    );
  });

  it("gives samples one Alerts settings link, not two named for a workflow", () => {
    const ALERTS = "https://app.test/settings/org-1/alerts";
    for (const sample of ["alert", "missed", "disabled", "recovery"] as const) {
      const message = renderSample(org, sample, "Test", now);
      for (const text of [message.text, message.chat]) {
        expect(text).toContain(`Open Alerts settings: ${ALERTS}`);
        const links = text
          .split("\n")
          .filter((line) => line.includes(ALERTS))
          .filter((line) => !line.includes("Change who gets these"));
        expect(links).toEqual([`Open Alerts settings: ${ALERTS}`]);
        expect(text).not.toContain("Open the failing workflow");
        expect(text).not.toContain("Failed runs:");
      }
      expect(message.html).toContain(">Open Alerts settings</a>");
    }
  });

  it("uses 2 failed runs in the funds samples, like a real funds alert", () => {
    const disabled = renderSample(org, "disabled", undefined, now);
    expect(disabled.subject).toContain(
      "Wallet out of funds: Example keeper was turned off after 2 failed runs in a row"
    );
  });

  it("says a workflow is turned off, never paused", () => {
    const incident = {
      failureCount: 5,
      firstFailedAt: new Date("2026-10-28T11:00:00Z"),
      lastError: "reverted",
      openedBy: "count" as const,
    };
    const first = renderMessage(
      { ...org, kind: "alert", workflow, incident, disabled: "first" },
      now
    );
    const again = renderMessage(
      {
        ...org,
        kind: "alert",
        workflow,
        incident,
        disabled: "again",
        disabledFailures: 2,
      },
      now
    );
    const failing = renderMessage(
      { ...org, kind: "alert", workflow, incident },
      now
    );
    const last = renderMessage(
      {
        ...org,
        kind: "reminder",
        workflow,
        incident,
        reminderNumber: 7,
        maxReminders: 7,
      },
      now
    );
    expect(first.subject).toContain(
      "Keeper was turned off after 5 failed runs in a row"
    );
    expect(again.subject).toContain(
      "Keeper was turned off again: 2 more failed runs after it was turned back on"
    );
    expect(failing.text).toContain(
      "fixes it, pauses its alerts or disables it."
    );
    expect(last.text).toContain("until it works or someone turns it off.");
    for (const message of [first, again, failing, last]) {
      // Pausing alerts is a different action; only that may say "pause".
      const text = `${message.text}${message.chat}`.replaceAll(
        "pauses its alerts",
        ""
      );
      expect(text).not.toMatch(/\bpause/i);
    }
  });

  it("measures a recovery to when it closed, not when it was sent", () => {
    const incident = {
      failureCount: 3,
      firstFailedAt: new Date("2026-10-28T11:00:00Z"),
      lastError: "reverted",
      openedBy: "count" as const,
    };
    const resolvedAt = new Date("2026-10-28T11:20:00Z");
    // Sent 30 minutes after the close, at the end of the recovery hold.
    const sentAt = new Date("2026-10-28T11:50:00Z");
    const message = renderMessage(
      { ...org, kind: "recovery", workflow, incident, resolvedAt },
      sentAt
    );
    expect(message.text).toContain(
      "It succeeded after 3 failed runs (failing for 20 minutes). Working since 2026-10-28 11:20 UTC."
    );
    const missed = renderMessage(
      {
        ...org,
        kind: "recovery",
        workflow,
        incident: { ...incident, openedBy: "missed" },
        resolvedAt,
      },
      sentAt
    );
    expect(missed.text).toContain(
      "It started again 20 minutes after it was due."
    );
    // The run's own start wins over the close, which a cycle may date later.
    const ranAt = new Date("2026-10-28T11:12:00Z");
    const exact = renderMessage(
      {
        ...org,
        kind: "recovery",
        workflow,
        incident: { ...incident, openedBy: "missed" },
        resolvedAt,
        ranAt,
      },
      sentAt
    );
    expect(exact.text).toContain(
      "It started again 12 minutes after it was due."
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

describe("runs refused before they start", () => {
  const reason =
    "Execution skipped: your plan's monthly execution limit has been reached.";
  const incident = {
    failureCount: 0,
    firstFailedAt: new Date(now.getTime() - 40 * 60 * 1000),
    lastError: reason,
    openedBy: "missed" as const,
    refused: { reason },
  };
  const SENTENCE =
    "Keeper is not running: its scheduled runs are being refused before they start: your plan's monthly execution limit has been reached.";
  const NOT_OURS = /scheduling problem|reported to our team|by hand/i;

  it.each(["alert", "reminder"] as const)(
    "a %s says the runs are refused, links Plans and never blames the scheduler",
    (kind) => {
      const message = renderMessage(
        {
          ...org,
          kind,
          workflow,
          incident,
          reminderNumber: 2,
          maxReminders: 7,
        },
        now
      );
      for (const text of [message.text, message.chat, message.html]) {
        expect(text).toContain("being refused before they start: your plan");
        expect(text).not.toMatch(NOT_OURS);
      }
      expect(message.text).toContain("https://app.test/settings/org-1/plans");
      expect(message.summary).toBe(`[KeeperHub] Acme: ${SENTENCE}`);
    }
  );

  it("a workflow that cannot run points to the workflow, not Plans", () => {
    const message = renderMessage(
      {
        ...org,
        kind: "alert",
        workflow,
        incident: {
          ...incident,
          refused: {
            reason:
              "Execution skipped: workflow is not executable (deactivated).",
          },
        },
      },
      now
    );
    expect(message.text).toContain(
      "before they start: workflow is not executable (the workflow is deactivated)."
    );
    expect(message.text).toContain(
      "KeeperHub deactivated it; contact support to turn it back on."
    );
    // Deactivated by our team: it will not come back on its own.
    expect(message.text).not.toContain("runs on its own again");
    expect(message.text).not.toContain("/plans");
    expect(message.text).not.toMatch(NOT_OURS);
  });

  it("a schedule that cannot run has no Plans link", () => {
    const message = renderMessage(
      {
        ...org,
        kind: "alert",
        workflow,
        incident: {
          ...incident,
          refused: { reason: SCHEDULE_INVALID_REFUSAL },
        },
      },
      now
    );
    expect(message.text).toContain(
      "Open the workflow to see why it cannot run"
    );
    expect(message.text).not.toMatch(/Open Plans|\/plans/);
  });

  it("an unpaid pay-as-you-go refusal points to Billing, not Plans", () => {
    const payg =
      "Not enough USDC in your wallet to cover this execution. Top up USDC on Base to keep running.";
    const message = renderMessage(
      {
        ...org,
        kind: "alert",
        workflow,
        incident: { ...incident, lastError: payg, refused: { reason: payg } },
      },
      now
    );
    expect(message.text).toContain(
      "Top up the wallet or raise the pay-as-you-go limits under Billing; it runs again"
    );
    expect(message.text).toContain(
      "Open Billing: https://app.test/settings/org-1/billing"
    );
    expect(message.html).toContain("https://app.test/settings/org-1/billing");
    expect(message.text).not.toContain("/plans");
  });

  it("a pay-as-you-go payment that failed for now asks to check the wallet, not to top up", () => {
    const failed = PAYG_BLOCK_MESSAGES.payment_failed;
    const message = renderMessage(
      {
        ...org,
        kind: "alert",
        workflow,
        incident: {
          ...incident,
          lastError: failed,
          refused: { reason: failed },
        },
      },
      now
    );
    expect(message.text).toContain(
      "If it keeps happening, check the wallet under Billing or contact support; it runs again on its own once its runs are accepted, and you will be told."
    );
    expect(message.text).not.toContain("Top up the wallet");
    expect(message.text).toContain(
      "Open Billing: https://app.test/settings/org-1/billing"
    );
  });

  it("a halted org's refusal explains the circuit breaker, not the workflow", () => {
    const message = renderMessage(
      {
        ...org,
        kind: "alert",
        workflow,
        incident: {
          ...incident,
          refused: {
            reason: "Execution skipped: workflow is not executable (halted).",
          },
        },
      },
      now
    );
    expect(message.text).toContain(
      "The organization's circuit breaker is engaged, so no runs start; an admin or owner can reset it to resume"
    );
    expect(message.text).not.toContain("to see why it cannot run");
    expect(message.text).not.toContain("/plans");
  });

  it("a refused reminder says still not running, its number and since when", () => {
    const message = renderMessage(
      {
        ...org,
        kind: "reminder",
        workflow,
        incident: { ...incident, openedBy: "refused" as const },
        reminderNumber: 3,
        maxReminders: 7,
      },
      now
    );
    expect(message.subject).toBe(
      "[Acme] Action needed (reminder 3 of 7): Keeper is still not running"
    );
    expect(message.text).toContain("Refused since ");
    expect(message.chat).toContain("reminder 3 of 7");
  });

  it("names the executor's not-runnable codes in plain words", () => {
    const owner = renderMessage(
      {
        ...org,
        kind: "alert",
        workflow,
        incident: {
          ...incident,
          refused: {
            reason:
              "Execution skipped: workflow is not executable (anonymous_owner).",
          },
        },
      },
      now
    );
    expect(owner.summary).toContain("(the owner has no account)");
    expect(owner.summary).not.toContain("Execution skipped");
    expect(owner.text).toContain("you will be told when it runs on its own");
  });

  it("asks for what the refusal needs, and a refused reminder still needs action", () => {
    const message = renderMessage(
      { ...org, kind: "reminder", workflow, incident, reminderNumber: 2 },
      now
    );
    expect(message.text).toContain("Raise the plan's run limit under Plans;");
    const next = (refusal: string): string =>
      renderMessage(
        {
          ...org,
          kind: "alert",
          workflow,
          incident: { ...incident, refused: { reason: refusal } },
        },
        now
      ).text;
    expect(
      next("Workflow uses features that require a paid plan: PagerDuty")
    ).toContain(
      "before they start: workflow uses features that require a paid plan: PagerDuty.\nUpgrade the plan under Plans, or remove those features from the workflow;"
    );
    expect(next("Insufficient credit balance.")).toContain(
      "Settle billing under Plans;"
    );
    expect(message.subject).toContain("Action needed");
    expect(message.subject).not.toContain("Still failing");
  });

  it("a grouped alert of only workflows that cannot run says to open them, not Plans", () => {
    const message = renderMessage({
      ...org,
      kind: "grouped",
      workflows: [1, 2].map((i) => ({
        ...workflow,
        id: `wf-${i}`,
        name: `Keeper ${i}`,
        failureCount: 0,
        lastError: null,
        openedBy: "missed" as const,
        refused: {
          reason: "Execution skipped: workflow is not executable (disabled).",
        },
      })),
    });
    expect(message.text).toContain(
      "Open the workflow to see why it cannot run."
    );
    expect(message.text).not.toMatch(/plan or billing|\/plans/);
  });

  it("a grouped alert lists refused workflows as not running, with the reason and Plans", () => {
    const message = renderMessage({
      ...org,
      kind: "grouped",
      workflows: [1, 2, 3].map((i) => ({
        ...workflow,
        id: `wf-${i}`,
        name: `Keeper ${i}`,
        failureCount: 0,
        lastError: reason,
        openedBy: "missed" as const,
        refused: { reason },
      })),
    });
    expect(message.subject).toBe(
      "[Acme] Action needed: 3 workflows are not running"
    );
    for (const text of [message.text, message.chat]) {
      expect(text).toContain(
        "Keeper 1 is not running: its scheduled runs are being refused before they start: your plan's"
      );
      expect(text).not.toContain("failed runs in a row");
      expect(text).not.toMatch(NOT_OURS);
    }
    expect(message.text).toContain(
      "Open Plans: https://app.test/settings/org-1/plans"
    );
    expect(message.text).toContain(
      "point to the plan or billing: raise the plan's run limit under Plans."
    );
    expect(message.text).not.toContain("RPC provider");
  });

  it("a grouped alert with several kinds of refusal names every fix", () => {
    const message = renderMessage({
      ...org,
      kind: "grouped",
      workflows: [reason, "Insufficient credit balance."].map((refusal, i) => ({
        ...workflow,
        id: `wf-${i}`,
        name: `Keeper ${i}`,
        failureCount: 0,
        lastError: refusal,
        openedBy: "refused" as const,
        refused: { reason: refusal },
      })),
    });
    expect(message.text).toContain(
      "point to the plan or billing: upgrade the plan, raise its run limit or settle billing under Plans."
    );
  });
});

describe("refused runs on a workflow not on a schedule", () => {
  const reason = "Insufficient credit balance to pay for this execution.";
  const hook = { id: "wf-9", name: "Hook", triggerLabel: "Webhook" };
  const incident = {
    failureCount: 0,
    firstFailedAt: new Date(now.getTime() - 40 * 60 * 1000),
    lastError: reason,
    openedBy: "refused" as const,
    refused: { reason },
  };

  it.each(["alert", "reminder"] as const)(
    "a %s says its runs are refused, links Plans and never says scheduled or out of funds",
    (kind) => {
      const message = renderMessage(
        { ...org, kind, workflow: hook, incident, reminderNumber: 2 },
        now
      );
      for (const text of [message.text, message.chat, message.html]) {
        expect(text).toContain(
          "Its runs are being refused before they start: insufficient credit balance"
        );
        expect(text).not.toMatch(/scheduled|Due at|wallet out of funds/i);
      }
      expect(message.text).toContain("Refused since");
      expect(message.text).toContain("https://app.test/settings/org-1/plans");
      expect(message.summary).toBe(
        "[KeeperHub] Acme: Hook is not running: its runs are being refused before they start: insufficient credit balance to pay for this execution."
      );
      expect(message.subject).toContain("Action needed");
    }
  );

  it("the last refused reminder waits for its runs to be accepted, not for it to work", () => {
    const message = renderMessage(
      { ...org, kind: "reminder", workflow: hook, incident, reminderNumber: 7 },
      now
    );
    expect(message.text).toContain(
      "until its runs are accepted again or someone turns it off"
    );
  });

  it("falls back to the stored error when no refusal was looked up", () => {
    const message = renderMessage(
      {
        ...org,
        kind: "alert",
        workflow: hook,
        incident: { ...incident, refused: undefined },
      },
      now
    );
    expect(message.text).toContain(
      "Its runs are being refused before they start: insufficient credit balance"
    );
  });

  it("a grouped alert lists it as not running with the refused note, not as out of funds", () => {
    const message = renderMessage({
      ...org,
      kind: "grouped",
      workflows: [1, 2, 3].map((i) => ({
        ...hook,
        id: `wf-${i}`,
        name: `Hook ${i}`,
        failureCount: 0,
        lastError: reason,
        openedBy: "refused" as const,
        refused: { reason },
      })),
    });
    expect(message.subject).toBe(
      "[Acme] Action needed: 3 workflows are not running"
    );
    for (const text of [message.text, message.chat]) {
      expect(text).toContain(
        "Hook 1 is not running: its runs are being refused before they start: insufficient credit balance"
      );
      expect(text).not.toMatch(/scheduled|wallet out of funds|Add funds/i);
    }
    expect(message.text).toContain(
      "Open Plans: https://app.test/settings/org-1/plans"
    );
  });

  it("the recovery says its runs are being accepted again", () => {
    const resolvedAt = new Date(now.getTime() - 30 * 60 * 1000);
    const ranAt = new Date(now.getTime() - 31 * 60 * 1000);
    const ok = renderMessage(
      {
        ...org,
        kind: "recovery",
        workflow: hook,
        incident,
        resolvedAt,
        ranAt,
      },
      now
    );
    expect(ok.subject).toBe("[Acme] Resolved: Hook is running again");
    expect(ok.text).toContain(
      "Its runs are being accepted again after 9 minutes of refusals."
    );
    const failed = renderMessage(
      {
        ...org,
        kind: "recovery",
        workflow: hook,
        incident,
        resolvedAt,
        ranAt,
        ranButFailed: true,
      },
      now
    );
    expect(failed.text).toContain(
      "Its runs are being accepted again after 9 minutes of refusals, but the first one failed."
    );
  });
  it("a refused recovery is about its own workflow only", () => {
    const message = renderMessage(
      {
        ...org,
        kind: "recovery",
        workflow: hook,
        incident,
        resolvedAt: now,
        ranAt: now,
      },
      now
    );
    expect(message.chatVariants.length).toBeGreaterThan(0);
    expect(message.subject).toBe("[Acme] Resolved: Hook is running again");
  });

  it("keeps a name's capitals after the colon, lower-cases a plain first word", () => {
    const message = renderMessage(
      {
        ...org,
        kind: "alert",
        workflow: hook,
        incident: {
          ...incident,
          refused: { reason: "PagerDuty needs a paid plan" },
        },
      },
      now
    );
    expect(message.text).toContain(
      "before they start: PagerDuty needs a paid plan."
    );
  });
});

describe("typed names and reasons in notices", () => {
  const hostile = "Edge\nBcc: x@evil.test ‮gnp.exe";

  it("keeps the subject to one line and drops bidi characters everywhere", () => {
    for (const kind of [
      "workflow_alerts_paused",
      "workflow_alerts_resumed",
    ] as const) {
      const message = renderMessage({
        ...org,
        kind,
        workflow: { id: "wf-1", name: hostile },
        by: "Dana‮",
        byAccount: null,
        reason: "Line one\nline two ‮evil",
        until: new Date("2026-11-08T00:00:00Z"),
        untilItWorks: false,
        changed: false,
      } as Parameters<typeof renderMessage>[0]);
      expect(message.subject).not.toMatch(/[\r\n‮]/);
      expect(message.subject).toContain("Edge Bcc: x@evil.test gnp.exe");
      expect(message.text).not.toContain("‮");
      expect(message.html).not.toContain("‮");
    }
  });

  it("says the alert waits for the org's pause when a workflow pause ends during it", () => {
    const message = renderMessage(
      {
        ...org,
        kind: "workflow_alerts_pause_ended",
        workflow,
        by: null,
        reason: null,
        until: new Date("2026-11-08T00:00:00Z"),
        untilItWorks: false,
        ended: "expired",
        failedRuns: 2,
        failingNow: true,
        alertsPausedUntil: new Date("2026-11-09T00:00:00Z"),
      },
      new Date("2026-11-08T00:00:00Z")
    );
    expect(message.text).toContain(
      "the alert goes out when the organization's alerts resume"
    );
    expect(message.text).not.toContain("so an alert follows");
  });
});

describe("daily reminder digest", () => {
  const listed = (
    id: string,
    name: string,
    extra: Record<string, unknown> = {}
  ) => ({
    id,
    name,
    triggerLabel: "Schedule",
    failureCount: 4,
    lastError: "execution reverted",
    openedBy: "count" as const,
    ...extra,
  });

  it("reads as one sentence with a verb and says how to stop it", () => {
    const message = renderMessage({
      ...org,
      kind: "grouped",
      reminder: true,
      workflows: [
        listed("w1", "Keeper A"),
        listed("w2", "Keeper B", { workflowDisabled: true }),
      ],
    });
    expect(message.subject).toBe(
      "[Acme] Daily reminder: 2 workflows are still failing (1 turned off)"
    );
    expect(message.text).toContain(
      "In Acme, 2 workflows are still failing (1 turned off)."
    );
    expect(message.text).toContain(
      'turn off "Remind once a day" in Settings > Alerts'
    );
    expect(message.text).not.toContain("shared cause");
  });

  it("adds up when some are not running", () => {
    const message = renderMessage({
      ...org,
      kind: "grouped",
      reminder: true,
      workflows: [
        listed("w1", "Keeper A"),
        listed("w2", "Keeper B"),
        listed("w3", "Keeper C", { openedBy: "missed" }),
      ],
    });
    expect(message.subject).toContain(
      "3 workflows need attention: 2 still failing, 1 not running"
    );
  });
});
