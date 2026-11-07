import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AlertsHealth } from "@/components/failure-alerts/alerts-status";
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

function render(data: OrgSettingsView, viewerUserId?: string): string {
  return renderToStaticMarkup(
    <AlertsHealth canManage data={data} viewerUserId={viewerUserId} />
  );
}

const member = (
  userId: string,
  email: string
): OrgSettingsView["members"][number] => ({
  userId,
  role: "member",
  email,
  name: null,
  reachable: false,
});

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
    expect(html).toContain("choose other people for email");
    expect(html).toContain("They can add one in");
    expect(html).toContain('href="/settings/security"');
  });

  it("tells the viewer they can fix their own account", () => {
    const html = render(view([member("me", "me@example.com")]), "me");
    expect(html).toContain("You have no email KeeperHub can reach");
    expect(html).toContain("You can add one in");
    expect(html).toContain('href="/settings/security"');
  });

  it("lists at most three names, then how many more", () => {
    const html = render(
      view(
        ["a", "b", "c", "d", "e"].map((id) => member(id, `${id}@example.com`))
      ),
      "e"
    );
    expect(html).toContain(
      "a@example.com, b@example.com, c@example.com and 2 more have no email"
    );
    expect(html).toContain("Each of you can add one in");
  });

  it("lists workflows whose own methods stopped working, and says All healthy when nothing is wrong", () => {
    const owner = {
      userId: "u1",
      role: "owner",
      email: "ann@example.com",
      name: null,
      reachable: true,
    };
    // Email plus a working chat method: nothing to warn about.
    const healthy = {
      ...view([owner]),
      unreachable: false,
      channels: [
        {
          id: "c1",
          kind: "slack",
          integrationId: "i1",
          connectionName: "Ops",
          destination: "#ops",
          role: "always",
          stoppedAt: null,
          stoppedReason: null,
          connectionMissing: false,
        },
      ],
    } as unknown as OrgSettingsView;
    expect(render(healthy)).toContain("All healthy");
    const html = render({
      ...healthy,
      customWorkflows: [
        {
          id: "wf-1",
          name: "Vault keeper",
          pausedUntil: null,
          pauseUntilSuccess: false,
          threshold: null,
          timeLimitMinutes: null,
          customRecipients: false,
          customChannels: true,
          disableWorkflow: false,
          brokenMethods: 1,
        },
      ],
    } as OrgSettingsView);
    expect(html).toContain("Workflows that need attention (1)");
    expect(html).toContain("Vault keeper");
    expect(html).toContain("1 of its own methods stopped working");
    expect(html).not.toContain("All healthy");
  });
});
