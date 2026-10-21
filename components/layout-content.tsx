"use client";

import { ReactFlowProvider } from "@xyflow/react";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { NavigationSidebar } from "@/components/navigation-sidebar";
import { useRecordExitPath } from "@/components/settings/hub/hooks/use-exit-path";
import { PersistentCanvas } from "@/components/workflow/persistent-canvas";
import { WorkflowToolbar } from "@/components/workflow/workflow-toolbar";
import {
  isLinkedSignInPath,
  isUnderRoute,
  isWelcomePath,
  MFA_GATE_PATHS,
} from "@/lib/pre-app-paths";

/**
 * Routes that render without the workflow shell behind them.
 *
 * The MFA gates (MFA_GATE_PATHS) must render without any auth-aware shell.
 * They land here either with NO session at all (OAuth-deferred path, the
 * pending_oauth_mfa cookie carries no auth power) or with a session
 * that is intentionally restricted (`requires_mfa = true`, or a wallet
 * member hard-gated by org MFA enforcement). Rendering the navigation
 * sidebar / workflow toolbar on these routes would leak auth-aware UI
 * (user avatar, wallet, org name, etc.) before the user has proven both
 * factors, and the full layout wraps children in `pointer-events-none`
 * plus fires gated api-client calls that 403 -- which on /enforce-mfa
 * blocked the enrollment buttons and threw the dev error overlay.
 *
 * The welcome pages, the pages a visitor signs in on from a link (invite,
 * device, OAuth consent) and shared execution views are full-screen pages of
 * their own.
 */
function isBareLayoutPath(pathname: string): boolean {
  return (
    MFA_GATE_PATHS.has(pathname) ||
    isWelcomePath(pathname) ||
    isLinkedSignInPath(pathname) ||
    isUnderRoute(pathname, "/executions")
  );
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
