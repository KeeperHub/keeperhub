"use client";

import { Info, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { QuotaBanner } from "@/components/billing/quota-banner";
import { useSession } from "@/lib/auth-client";
import { isBillingEnabled } from "@/lib/billing/feature-flag";
import {
  quotaBannerStorageKey,
  useQuotaStatus,
} from "@/lib/hooks/use-quota-status";
import { isAnonymousUser } from "@/lib/is-anonymous";

const STORAGE_KEY = "kh-billing-announce-v1";

export function AppBanner(): React.ReactElement | null {
  if (!isBillingEnabled()) {
    return null;
  }
  return <BillingBanner />;
}

/**
 * Owns the single fixed banner slot at the top of the app. A quota warning
 * outranks the plan announcement, so at most one banner renders and
 * `--app-banner-height` is set once for whichever won.
 */
function BillingBanner(): React.ReactElement | null {
  const [mounted, setMounted] = useState(false);
  const [announceDismissed, setAnnounceDismissed] = useState(true);
  const [quotaDismissedKey, setQuotaDismissedKey] = useState<string | null>(
    null
  );
  const { data: session, isPending } = useSession();
  const isAnonymous = isAnonymousUser(session?.user);
  const signedIn = mounted && !isPending && !isAnonymous;

  const { status } = useQuotaStatus(signedIn);
  const quotaKey =
    status && status.threshold !== null ? quotaBannerStorageKey(status) : null;

  const quotaVisible = Boolean(
    signedIn && quotaKey && quotaDismissedKey !== quotaKey
  );
  const announceVisible = signedIn && !(announceDismissed || quotaVisible);
  const visible = quotaVisible || announceVisible;

  useEffect(() => {
    setMounted(true);
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      setAnnounceDismissed(stored === "1");
    } catch {
      setAnnounceDismissed(false);
    }
  }, []);

  // Re-read on every key change so crossing 100% (a new key) resurfaces the
  // banner even though the 80% one was dismissed.
  useEffect(() => {
    if (!quotaKey) {
      return;
    }
    try {
      if (window.localStorage.getItem(quotaKey) === "1") {
        setQuotaDismissedKey(quotaKey);
      }
    } catch {
      // localStorage unavailable; the banner stays visible this session
    }
  }, [quotaKey]);

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

  const handleDismissQuota = useCallback((): void => {
    if (!quotaKey) {
      return;
    }
    try {
      window.localStorage.setItem(quotaKey, "1");
    } catch {
      // localStorage unavailable; dismissal only lasts this session
    }
    setQuotaDismissedKey(quotaKey);
  }, [quotaKey]);

  function handleDismissAnnounce(): void {
    try {
      window.localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      // localStorage unavailable; dismissal only lasts this session
    }
    setAnnounceDismissed(true);
  }

  if (quotaVisible && status) {
    return <QuotaBanner onDismiss={handleDismissQuota} status={status} />;
  }

  if (!announceVisible) {
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
            href="/billing"
          >
            See plans
          </Link>
        </span>
      </p>
      <button
        aria-label="Dismiss announcement"
        className="absolute right-3 shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-keeperhub-green/10 hover:text-foreground"
        onClick={handleDismissAnnounce}
        type="button"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
