import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { SettingsProvider } from "@/components/settings/hub/settings-context";
import { SettingsShell } from "@/components/settings/hub/settings-shell";
import { auth } from "@/lib/auth";
import { alertsOrgIdsForUser } from "@/lib/notifications/failure-alerts/user-orgs";

export default async function SettingsLayout({
  children,
}: {
  children: ReactNode;
}): Promise<React.ReactElement> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) {
    redirect("/?returnTo=%2Fsettings");
  }

  // Known here, so the Alerts menu item draws with the rest instead of after a request.
  const alertsOrgIds = await alertsOrgIdsForUser(session.user.id).catch(
    () => undefined
  );

  return (
    <SettingsProvider alertsOrgIds={alertsOrgIds}>
      <SettingsShell>{children}</SettingsShell>
    </SettingsProvider>
  );
}
