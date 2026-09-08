"use client";

import { LogIn, type LucideIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

type FullPageAuthGateProps = {
  /** "AUTH_REQUIRED" shows the sign-in copy; anything else the org copy. */
  error: string;
  /** Icon shown for the organization-required state. */
  icon: LucideIcon;
  signInTitle: string;
  signInDescription: string;
  orgDescription: string;
};

/**
 * Full-page gate shown when a dashboard page needs authentication or an
 * organization. Feature pages supply their icon and copy.
 */
export function FullPageAuthGate({
  error,
  icon: Icon,
  signInTitle,
  signInDescription,
  orgDescription,
}: FullPageAuthGateProps): ReactNode {
  const isAuthRequired = error === "AUTH_REQUIRED";

  return (
    <div className="pointer-events-auto fixed inset-0 overflow-y-auto bg-sidebar">
      <div className="transition-[margin-left] duration-200 ease-out md:ml-[var(--nav-content-offset,var(--nav-sidebar-width,60px))]">
        <div className="flex min-h-[80vh] flex-col items-center justify-center gap-6 p-6 text-center">
          <div className="flex size-20 items-center justify-center rounded-2xl bg-muted">
            {isAuthRequired ? (
              <LogIn className="size-10 text-muted-foreground" />
            ) : (
              <Icon className="size-10 text-muted-foreground" />
            )}
          </div>
          <div className="space-y-2">
            <h2 className="text-xl font-semibold tracking-tight">
              {isAuthRequired ? signInTitle : "Organization required"}
            </h2>
            <p className="max-w-sm text-sm text-muted-foreground">
              {isAuthRequired ? signInDescription : orgDescription}
            </p>
          </div>
          {!isAuthRequired && (
            <Button asChild>
              <Link href="/">Get Started</Link>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
