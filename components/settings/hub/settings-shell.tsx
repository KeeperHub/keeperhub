"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { SettingsAccessGate } from "./settings-access-gate";
import { SettingsRail } from "./settings-rail";

export function SettingsShell({
  children,
}: {
  children: ReactNode;
}): React.ReactElement {
  // The plan cards are a four-column grid built for a full page; the reading
  // width every other section wants would crush them into each other.
  const wide = usePathname().endsWith("/plans");

  return (
    <div
      className="pointer-events-auto fixed inset-x-0 bottom-0 flex flex-col bg-background"
      data-testid="settings-shell"
      // Sits directly under the shared app toolbar, which is fixed at the top
      // of every route.
      style={{
        top: "calc(var(--header-height, 60px) + var(--app-banner-height, 0px))",
      }}
    >
      <div className="flex min-h-0 flex-1">
        <SettingsRail />
        <main className="min-w-0 flex-1 overflow-y-auto">
          <div
            className={cn(
              "mx-auto flex w-full flex-col gap-6 px-8 py-8",
              wide ? "max-w-7xl" : "max-w-5xl"
            )}
          >
            <SettingsAccessGate>{children}</SettingsAccessGate>
          </div>
        </main>
      </div>
    </div>
  );
}
