import { describe, expect, it } from "vitest";
import {
  describeRule,
  type RuleChannel,
} from "@/components/failure-alerts/format";

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

  it("says the workflow turns itself off", () => {
    expect(describeRule({ ...base, pauseWorkflow: true })).toMatch(
      /Then KeeperHub turns this workflow off\.$/
    );
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
