import { describe, expect, it } from "vitest";
import {
  type NotificationRow,
  notificationStatesFor,
  notificationStatus,
  notificationsExcludedBy,
  notificationTitle,
  toNotificationRun,
} from "@/lib/analytics/notification-runs";

const CREATED = new Date("2026-10-01T10:00:00.000Z");
const LATER = new Date("2026-10-01T10:00:04.000Z");

function row(overrides: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id: "delivery_1",
    kind: "alert",
    channel: "email",
    recipient: "ops@example.com",
    connectionName: null,
    state: "delivered",
    attempts: 1,
    isBackup: false,
    lastError: null,
    context: null,
    createdAt: CREATED,
    updatedAt: LATER,
    deliveredAt: LATER,
    workflowId: "wf_nightly",
    workflowName: "Nightly sync",
    ...overrides,
  };
}

const NO_GROUPS = new Map<string, { id: string; name: string }>();

describe("notificationStatus", () => {
  it("maps each delivery state onto a status the runs list already has", () => {
    expect(notificationStatus("delivered")).toBe("success");
    expect(notificationStatus("failed")).toBe("error");
    expect(notificationStatus("capped")).toBe("error");
    expect(notificationStatus("pending")).toBe("pending");
    expect(notificationStatus("sending")).toBe("running");
    expect(notificationStatus("retrying")).toBe("running");
    // Withdrawn before it went out: a cancellation, not the plan-refusal skip.
    expect(notificationStatus("skipped")).toBe("cancelled");
  });

  it("selects the delivery states behind a status filter", () => {
    expect(notificationStatesFor(["error"]).sort()).toEqual([
      "capped",
      "failed",
    ]);
    expect(notificationStatesFor(["running"]).sort()).toEqual([
      "retrying",
      "sending",
    ]);
    expect(notificationStatesFor(["cancelled"])).toEqual(["skipped"]);
    // Statuses a notification can never have select nothing.
    expect(
      notificationStatesFor(["system_error", "external_error", "skipped"])
    ).toEqual([]);
  });
});

describe("notificationsExcludedBy", () => {
  it("drops notifications under any network, gas or duration filter", () => {
    expect(notificationsExcludedBy({})).toBe(false);
    expect(notificationsExcludedBy({ statuses: ["error"], search: "x" })).toBe(
      false
    );
    expect(notificationsExcludedBy({ networks: ["8453"] })).toBe(true);
    expect(notificationsExcludedBy({ gas: ["free"] })).toBe(true);
    expect(notificationsExcludedBy({ durationMinMs: 0 })).toBe(true);
    expect(notificationsExcludedBy({ durationMaxMs: 5000 })).toBe(true);
  });
});

describe("notificationTitle", () => {
  it("names the kind and the workflow", () => {
    expect(notificationTitle("alert", [{ name: "Nightly sync" }], null)).toBe(
      "Alert: Nightly sync"
    );
    expect(
      notificationTitle("recovery", [{ name: "Nightly sync" }], null)
    ).toBe("Running again: Nightly sync");
  });

  it("counts the workflows of a grouped message", () => {
    expect(
      notificationTitle(
        "alert",
        [{ name: "a" }, { name: "b" }, { name: "c" }],
        null
      )
    ).toBe("Alert: 3 workflows");
  });

  it("names the channel of a pause notice and nothing for a launch notice", () => {
    expect(notificationTitle("channel_paused", [], "Slack #ops")).toBe(
      "Channel stopped working: Slack #ops"
    );
    expect(notificationTitle("launch_notice", [], null)).toBe(
      "Notifications turned on"
    );
  });
});

describe("toNotificationRun", () => {
  it("maps a delivered single-workflow alert onto a run row", () => {
    const run = toNotificationRun(row(), NO_GROUPS);

    expect(run).toMatchObject({
      id: "delivery_1",
      source: "notification",
      status: "success",
      startedAt: CREATED.toISOString(),
      completedAt: LATER.toISOString(),
      durationMs: 4000,
      workflowId: "wf_nightly",
      workflowName: "Nightly sync",
      network: null,
      networks: [],
      gasNetworks: [],
      transactionHashes: [],
      gasUsedWei: null,
    });
    expect(run.notification).toEqual({
      title: "Alert: Nightly sync",
      kind: "alert",
      state: "delivered",
      channel: "email",
      recipient: "ops@example.com",
      connectionName: null,
      isBackup: false,
      attempts: 1,
      lastError: null,
      note: null,
      workflows: [{ id: "wf_nightly", name: "Nightly sync" }],
    });
  });

  it("resolves a grouped alert through its incident ids and links to none", () => {
    const groups = new Map([
      ["inc_a", { id: "wf_a", name: "A" }],
      ["inc_b", { id: "wf_b", name: "B" }],
      ["inc_c", { id: "wf_c", name: "C" }],
    ]);
    const run = toNotificationRun(
      row({
        workflowId: null,
        workflowName: null,
        // inc_gone's incident was deleted; it is dropped, not shown blank.
        context: { incidentIds: ["inc_a", "inc_b", "inc_c", "inc_gone"] },
      }),
      groups
    );

    expect(run.notification?.title).toBe("Alert: 3 workflows");
    expect(run.notification?.workflows.map((w) => w.id)).toEqual([
      "wf_a",
      "wf_b",
      "wf_c",
    ]);
    expect(run.workflowId).toBeNull();
    expect(run.workflowName).toBeNull();
  });

  it("links a grouped message that resolves to one workflow", () => {
    const run = toNotificationRun(
      row({
        workflowId: null,
        workflowName: null,
        context: { incidentIds: ["inc_a"] },
      }),
      new Map([["inc_a", { id: "wf_a", name: "A" }]])
    );
    expect(run.workflowId).toBe("wf_a");
    expect(run.notification?.title).toBe("Alert: A");
  });

  it("dates a failed, capped or withdrawn message by when it stopped", () => {
    for (const state of ["failed", "capped", "skipped"]) {
      const run = toNotificationRun(
        row({ state, deliveredAt: null, lastError: "why" }),
        NO_GROUPS
      );
      expect(run.completedAt).toBe(LATER.toISOString());
      expect(run.durationMs).toBe(4000);
      expect(run.notification?.lastError).toBe("why");
    }
  });

  it("leaves a message still in delivery open", () => {
    for (const state of ["pending", "sending", "retrying"]) {
      const run = toNotificationRun(
        row({ state, deliveredAt: null }),
        NO_GROUPS
      );
      expect(run.completedAt).toBeNull();
      expect(run.durationMs).toBeNull();
    }
    expect(
      toNotificationRun(
        row({ state: "retrying", deliveredAt: null }),
        NO_GROUPS
      ).status
    ).toBe("running");
  });

  it("carries a backup's reason and a pause notice's channel as the note", () => {
    const backup = toNotificationRun(
      row({ isBackup: true, context: { backupReason: "Slack #ops failed" } }),
      NO_GROUPS
    );
    expect(backup.notification?.isBackup).toBe(true);
    expect(backup.notification?.note).toBe("Sent because Slack #ops failed");

    const paused = toNotificationRun(
      row({
        kind: "channel_paused",
        workflowId: null,
        workflowName: null,
        context: { channelLabel: "Slack #ops" },
      }),
      NO_GROUPS
    );
    expect(paused.notification?.title).toBe(
      "Channel stopped working: Slack #ops"
    );
    expect(paused.notification?.workflows).toEqual([]);
    expect(paused.workflowId).toBeNull();
  });
});
