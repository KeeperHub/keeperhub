import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AlertsStatus } from "@/components/failure-alerts/alerts-status";
import type { OrgSettingsView } from "@/lib/notifications/failure-alerts/view-types";

const WALLET =
  "0x1234567890abcdef1234567890abcdef12345678@wallet.keeperhub.local";

function view(members: OrgSettingsView["members"]): OrgSettingsView {
  return {
    enabled: true,
    isDefault: false,
    threshold: 3,
    timeLimitMinutes: null,
    remindDaily: false,
    notifyRecovery: true,
    recipientUserIds: members.map((m) => m.userId),
    recipientsAreDefault: false,
    members,
    channels: [],
    connections: [],
    emailUsage: null,
    customWorkflows: [],
    lastAlertDeliveredAt: null,
    version: 1,
    pause: null,
    failingNow: [],
    unreachable: true,
  } as unknown as OrgSettingsView;
}

function render(data: OrgSettingsView): string {
  return renderToStaticMarkup(
    <AlertsStatus canManage data={data} onResume={async () => null} />
  );
}

describe("alerts status when nobody can be reached", () => {
  it("names the chosen people without a reachable email and how to fix it", () => {
    const html = render(
      view([
        {
          userId: "u1",
          role: "owner",
          email: "ann@example.com",
          name: "Ann",
          reachable: false,
        },
        {
          userId: "u2",
          role: "admin",
          email: WALLET,
          name: null,
          reachable: false,
        },
      ])
    );
    expect(html).toContain("ann@example.com and 0x1234");
    expect(html).toContain("have no email KeeperHub can reach");
    expect(html).toContain("choose other people under Email");
    // The viewer's own account page fixes nothing for other members.
    expect(html).not.toContain("/settings/security");
  });
});
