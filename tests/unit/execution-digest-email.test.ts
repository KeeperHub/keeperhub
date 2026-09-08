import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  ErrorCategory: {},
  logSystemError: vi.fn(),
  logUserError: vi.fn(),
}));

import { sendWorkflowExecutionDigestEmail } from "@/lib/email";

const mockFetch = vi.fn();

function baseData() {
  return {
    to: "owner@example.com",
    orgName: "Acme",
    organizationId: "org-123",
    cadence: "daily" as const,
    since: new Date("2026-06-08T14:00:00.000Z"),
    until: new Date("2026-06-09T14:00:00.000Z"),
    appUrl: "https://app.keeperhub.com",
    stats: {
      total: 5,
      success: 3,
      error: 2,
      skipped: 0,
      distinctWorkflows: 2,
      transactionCount: 4,
      gasUsedWei: "0",
    },
    topFailing: [
      {
        workflowId: "wf-fail",
        name: "Nightly sync",
        failures: 2,
        lastError: "boom",
      },
    ],
    mostExecuted: [{ workflowId: "wf-run", name: "Nightly sync", runs: 5 }],
    topSkipped: [],
  };
}

// Concatenate the text + html bodies sent to SendGrid for assertions.
function sentContent(): string {
  const body = JSON.parse(mockFetch.mock.calls[0]?.[1]?.body ?? "{}");
  return (body.content ?? []).map((c: { value: string }) => c.value).join("\n");
}

describe("sendWorkflowExecutionDigestEmail", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, text: () => Promise.resolve("") });
    vi.stubGlobal("fetch", mockFetch);
    process.env.SENDGRID_API_KEY = "SG.test-key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.SENDGRID_API_KEY = undefined;
  });

  it("omits the sponsored section when sponsorship is off (count undefined)", async () => {
    await sendWorkflowExecutionDigestEmail(baseData());
    const content = sentContent();
    expect(content).not.toContain("Sponsored");
  });

  it("renders the sponsored section when a sponsored count is provided", async () => {
    const data = baseData();
    await sendWorkflowExecutionDigestEmail({
      ...data,
      stats: { ...data.stats, sponsoredTransactionCount: 7 },
    });
    const content = sentContent();
    expect(content).toContain("Sponsored txs");
    expect(content).toContain("Sponsored transactions: 7");
  });

  it("links each workflow to its page on the platform", async () => {
    await sendWorkflowExecutionDigestEmail(baseData());
    const content = sentContent();
    expect(content).toContain("https://app.keeperhub.com/workflows/wf-fail");
    expect(content).toContain("https://app.keeperhub.com/workflows/wf-run");
  });

  it("shows the explicit UTC period window in DD/MM/YY format", async () => {
    await sendWorkflowExecutionDigestEmail(baseData());
    const content = sentContent();
    expect(content).toContain("08/06/26 14:00 UTC to 09/06/26 14:00 UTC");
  });

  it("uses a professional cadence label", async () => {
    await sendWorkflowExecutionDigestEmail(baseData());
    expect(sentContent()).toContain("Daily summary");
  });

  it("reports successes and failures as both count and percentage", async () => {
    await sendWorkflowExecutionDigestEmail(baseData());
    const content = sentContent();
    expect(content).toContain("Succeeded: 3 (60%)");
    expect(content).toContain("Failed: 2 (40%)");
  });

  it("rates success against completed runs, excluding pending/running/cancelled", async () => {
    const data = baseData();
    // 3 success + 2 error = 5 completed, but 10 total runs (5 in-flight or
    // cancelled). The rate must be over completed (3/5 = 60%), not total.
    await sendWorkflowExecutionDigestEmail({
      ...data,
      stats: { ...data.stats, total: 10, success: 3, error: 2 },
    });
    const content = sentContent();
    expect(content).toContain("Succeeded: 3 (60%)");
    expect(content).toContain("Failed: 2 (40%)");
  });

  it("omits the skipped section when nothing was refused", async () => {
    await sendWorkflowExecutionDigestEmail(baseData());
    const content = sentContent();
    expect(content).not.toContain("Skipped:");
  });

  // A refused run never started, so it must read as its own outcome rather
  // than inflating the failure count the recipient acts on.
  it("reports refused runs under their own heading, apart from failures", async () => {
    const data = baseData();
    await sendWorkflowExecutionDigestEmail({
      ...data,
      stats: { ...data.stats, skipped: 12 },
      topSkipped: [
        {
          workflowId: "wf-skip",
          name: "Price watcher",
          skipped: 12,
          lastReason: "Execution limit reached",
        },
      ],
    });
    const content = sentContent();
    expect(content).toContain("Skipped: 12");
    expect(content).toContain("Price watcher");
    expect(content).toContain("Execution limit reached");
    expect(content).toContain("https://app.keeperhub.com/workflows/wf-skip");
    // The failure count and rate stay untouched by the refusals.
    expect(content).toContain("Failed: 2 (40%)");
  });

  it("reports the number of distinct workflows run", async () => {
    await sendWorkflowExecutionDigestEmail(baseData());
    const content = sentContent();
    expect(content).toContain("Workflows run");
  });

  it("includes the social links in the footer", async () => {
    await sendWorkflowExecutionDigestEmail(baseData());
    const content = sentContent();
    expect(content).toContain("https://discord.gg/keeperhub");
    expect(content).toContain("https://x.com/KeeperHubApp");
    expect(content).not.toContain("mailto:");
  });

  it("names the organization clearly in the body", async () => {
    await sendWorkflowExecutionDigestEmail(baseData());
    const content = sentContent();
    expect(content).toContain("Organization: Acme");
    expect(content).toContain("Acme workflow digest");
  });

  it("includes a manage/unsubscribe link deep-linking to the org's settings", async () => {
    await sendWorkflowExecutionDigestEmail(baseData());
    const content = sentContent();
    expect(content).toContain(
      "https://app.keeperhub.com/workflows?digestSettings=org-123"
    );
    expect(content).toContain("Manage notifications");
    expect(content).toContain(
      "because you're an owner or admin of that organization"
    );
  });

  it("attaches the social icons inline (cid) so they render without hosting", async () => {
    await sendWorkflowExecutionDigestEmail(baseData());
    const body = JSON.parse(mockFetch.mock.calls[0]?.[1]?.body ?? "{}");
    const ids = (body.attachments ?? []).map(
      (a: { content_id: string }) => a.content_id
    );
    expect(ids).toContain("discord");
    expect(ids).toContain("telegram");
    expect(sentContent()).toContain('src="cid:discord"');
  });
});
