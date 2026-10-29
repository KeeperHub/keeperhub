import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));

const { renderMessage } = await import(
  "@/lib/notifications/failure-alerts/messages"
);
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
      by: "ana@x.io",
      pausingWorkflows,
    });

  it("says workflows set to turn off still turn off", () => {
    expect(paused(2).text).toContain(
      "ana@x.io paused them: Upgrade. Failures are not reported until then. Workflows keep running, but the 2 set to turn off at their limit still turn off; you are told about those when the pause ends."
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
