import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { SettingsProvider } from "@/components/settings/hub/settings-context";
import { SettingsShell } from "@/components/settings/hub/settings-shell";
import { auth } from "@/lib/auth";

export default async function SettingsLayout({
  children,
}: {
  children: ReactNode;
}): Promise<React.ReactElement> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) {
    redirect("/?returnTo=%2Fsettings");
  }

  return (
    <SettingsProvider>
      <SettingsShell>{children}</SettingsShell>
    </SettingsProvider>
  );
}
