"use client";

import { Info, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useSession } from "@/lib/auth-client";
import { isBillingEnabled } from "@/lib/billing/feature-flag";
import { isAnonymousUser } from "@/lib/is-anonymous";

const STORAGE_KEY = "kh-billing-announce-v1";

export function AppBanner(): React.ReactElement | null {
  if (!isBillingEnabled()) {
    return null;
  }
  return <BillingBanner />;
}

function BillingBanner(): React.ReactElement | null {
  const [mounted, setMounted] = useState(false);
  const [dismissed, setDismissed] = useState(true);
  const { data: session, isPending } = useSession();
  const isAnonymous = isAnonymousUser(session?.user);
  const visible = mounted && !dismissed && !isPending && !isAnonymous;

  useEffect(() => {
    setMounted(true);
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      setDismissed(stored === "1");
    } catch {
      setDismissed(false);
    }
  }, []);

  useEffect(() => {
    if (visible) {
      document.documentElement.style.setProperty("--app-banner-height", "36px");
    } else {
      document.documentElement.style.removeProperty("--app-banner-height");
    }
    return (): void => {
      document.documentElement.style.removeProperty("--app-banner-height");
    };
  }, [visible]);

  function handleDismiss(): void {
    try {
      window.localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      // localStorage unavailable; dismissal only lasts this session
    }
    setDismissed(true);
  }

  if (!visible) {
    return null;
  }

  return (
    <div
      className="pointer-events-auto fixed top-0 right-0 left-0 z-[55] flex h-9 items-center justify-center border-b border-keeperhub-green/30 bg-keeperhub-green/10 px-12 text-sm backdrop-blur-sm"
      data-testid="app-banner"
    >
      <p className="flex items-center gap-2 truncate text-foreground">
        <Info
          aria-hidden="true"
          className="size-4 shrink-0 text-keeperhub-green-dark"
        />
        <span className="truncate">
          New Pro and Business plans unlock higher execution limits and gas
          credits. Free stays free forever.{" "}
          <Link
            className="font-medium text-keeperhub-green-dark underline-offset-4 hover:underline"
            href="/billing#plans-section"
          >
            See plans
          </Link>
        </span>
      </p>
      <button
        aria-label="Dismiss announcement"
        className="absolute right-3 shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-keeperhub-green/10 hover:text-foreground"
        onClick={handleDismiss}
        type="button"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
