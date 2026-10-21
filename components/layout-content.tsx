"use client";

import { ReactFlowProvider } from "@xyflow/react";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { NavigationSidebar } from "@/components/navigation-sidebar";
import { useRecordExitPath } from "@/components/settings/hub/hooks/use-exit-path";
import { PersistentCanvas } from "@/components/workflow/persistent-canvas";
import { WorkflowToolbar } from "@/components/workflow/workflow-toolbar";
import { isWelcomePath } from "@/lib/welcome-path";

/**
 * Routes that must render without any auth-aware shell. The MFA gates
 * land here either with NO session at all (OAuth-deferred path, the
 * pending_oauth_mfa cookie carries no auth power) or with a session
 * that is intentionally restricted (`requires_mfa = true`, or a wallet
 * member hard-gated by org MFA enforcement). Rendering the navigation
 * sidebar / workflow toolbar on these routes would leak auth-aware UI
 * (user avatar, wallet, org name, etc.) before the user has proven both
 * factors, and the full layout wraps children in `pointer-events-none`
 * plus fires gated api-client calls that 403 -- which on /enforce-mfa
 * blocked the enrollment buttons and threw the dev error overlay.
 */
const BARE_LAYOUT_PATHS: ReadonlySet<string> = new Set([
  "/verify-mfa",
  "/enroll-mfa",
  "/enforce-mfa",
]);

// Prefixes whose whole subtree renders bare. Shared execution views are
// standalone pages, and the welcome pages (isWelcomePath) are full-screen; the
// workflow shell must not render behind either.
const BARE_LAYOUT_PREFIXES: readonly string[] = ["/executions"];

function isBareLayoutPath(pathname: string): boolean {
  if (BARE_LAYOUT_PATHS.has(pathname) || isWelcomePath(pathname)) {
    return true;
  }
  return BARE_LAYOUT_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function LayoutContent({
  children,
}: {
  children: ReactNode;
}): React.ReactElement {
  const pathname = usePathname();
  useRecordExitPath();
  if (isBareLayoutPath(pathname)) {
    return <div className="relative z-10">{children}</div>;
  }
  return (
    <ReactFlowProvider>
      <WorkflowToolbar persistent />
      <PersistentCanvas />
      <div className="pointer-events-none relative z-10">{children}</div>
      <NavigationSidebar />
    </ReactFlowProvider>
  );
}
