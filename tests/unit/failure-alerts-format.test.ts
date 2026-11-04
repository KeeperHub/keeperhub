import { describe, expect, it } from "vitest";
import {
  deliveryStatus,
  describeRule,
  type RuleChannel,
} from "@/components/failure-alerts/format";
import { STALE_DROP_TEXT } from "@/lib/notifications/failure-alerts/view-types";

const slack: RuleChannel = {
  kind: "slack",
  destination: "#ops",
  connectionName: "Ops",
  role: "always",
  pausedAt: null,
};

const base = {
  threshold: 5,
  timeLimitMinutes: null,
  emails: ["ana@x.io"],
  channels: [] as RuleChannel[],
  scope: "workflow" as const,
};

describe("describeRule", () => {
  it("names the viewer as you", () => {
    expect(
      describeRule({ ...base, viewerEmail: "ana@x.io", scope: "org" })
    ).toBe(
      "If a workflow that runs on its own fails 5 times in a row, KeeperHub tells you by email. Scheduled runs that do not start are reported too. Runs you start by hand never count."
    );
  });

  it("lists up to three people, then counts them", () => {
    expect(describeRule({ ...base, emails: ["a", "b", "c"] })).toContain(
      "tells a, b and c by email."
    );
    expect(describeRule({ ...base, emails: ["a", "b", "c", "d"] })).toContain(
      "tells 4 people by email."
    );
  });

  it("mentions the time rule when it is on", () => {
    expect(describeRule({ ...base, timeLimitMinutes: 360 })).toContain(
      "fails 5 times in a row or keeps failing for 6 hours,"
    );
  });

  it("leaves out paused methods and names backups", () => {
    const text = describeRule({
      ...base,
      channels: [
        slack,
        { ...slack, destination: "#old", pausedAt: "2026-10-01T00:00:00Z" },
        { ...slack, kind: "pagerduty", destination: "PABC123", role: "backup" },
      ],
    });
    expect(text).toContain(
      "tells ana@x.io by email and Ops (Slack #ops), with Ops (PagerDuty PABC123) as a backup."
    );
    expect(text).not.toContain("#old");
  });

  it("says so when nothing can reach anyone", () => {
    expect(describeRule({ ...base, emails: [] })).toContain(
      "KeeperHub tells nobody: no method can reach anyone."
    );
  });

  it("says the workflow turns off only on the count or out of funds", () => {
    const text = describeRule({
      ...base,
      timeLimitMinutes: 360,
      pauseWorkflow: true,
    });
    expect(text).toMatch(
      /KeeperHub turns this workflow off only after 5 failed runs in a row or when its wallet runs out of funds\.$/
    );
    expect(text).not.toContain("Then KeeperHub");
  });

  it("shortens a long target in the middle", () => {
    const text = describeRule({
      ...base,
      emails: [],
      channels: [
        { ...slack, kind: "telegram", destination: "-1002233445566778899" },
      ],
    });
    expect(text).toContain("..");
    expect(text).not.toContain("-1002233445566778899");
  });
});

describe("deliveryStatus", () => {
  const now = new Date("2026-11-04T14:00:00.000Z");
  const row = {
    state: "pending",
    kind: "recovery",
    lastError: null,
    nextAttemptAt: "2026-11-04T14:25:00.000Z",
  };

  it("says when a held recovery goes out", () => {
    expect(deliveryStatus(row, now)).toEqual({
      label: "Sends at 14:25 UTC if it keeps working",
      tone: "waiting",
    });
  });

  it("names the time for any other row due later", () => {
    expect(deliveryStatus({ ...row, kind: "alert" }, now).label).toBe(
      "Scheduled for 14:25 UTC"
    );
  });

  it("calls a row due now queued", () => {
    expect(
      deliveryStatus({ ...row, nextAttemptAt: now.toISOString() }, now).label
    ).toBe("Queued");
  });

  it("shows a dropped row as not delivered, a withdrawn one muted", () => {
    expect(
      deliveryStatus(
        { ...row, state: "skipped", lastError: STALE_DROP_TEXT },
        now
      )
    ).toEqual({ label: "Not delivered", tone: "failed" });
    expect(
      deliveryStatus(
        {
          ...row,
          state: "skipped",
          lastError: "The workflow is running again.",
        },
        now
      )
    ).toEqual({ label: "Withdrawn", tone: "muted" });
  });
});
