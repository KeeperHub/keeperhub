"use client";

import { Info, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  AppBannerSlot,
  useAppBannerOffset,
} from "@/components/app-banner-slot";
import { QuotaBanner } from "@/components/billing/quota-banner";
import { FailureAlertsPausedBanner } from "@/components/failure-alerts/paused-banner";
import { FailureAlertsUnreachableBanner } from "@/components/failure-alerts/unreachable-banner";
import { useSession } from "@/lib/auth-client";
import { isBillingEnabled } from "@/lib/billing/feature-flag";
import {
  hasNotificationType,
  invalidateNotificationStatus,
  useNotificationStatus,
} from "@/lib/hooks/use-notifications";
import { useActiveMember, useOrganization } from "@/lib/hooks/use-organization";
import {
  quotaBannerStorageKey,
  useQuotaStatus,
} from "@/lib/hooks/use-quota-status";
import { isAnonymousUser } from "@/lib/is-anonymous";

const STORAGE_KEY = "kh-billing-announce-v1";

/**
 * The fixed banners at the top of the app: one alerts strip ("nobody would be
 * told" outranks "paused") and, under it, one billing strip, so a pause never
 * hides the plans news or a quota warning.
 */
export function AppBanner(): React.ReactElement | null {
  const { organization } = useOrganization();
  const { isAdmin } = useActiveMember();
  const { data: session } = useSession();
  const signedIn = Boolean(session?.user) && !isAnonymousUser(session?.user);
  const { status } = useNotificationStatus(
    signedIn && isAdmin ? organization?.id : null
  );
  const organizationId = organization?.id;
  const unreachable =
    Boolean(organizationId) &&
    hasNotificationType(status, "failure_alerts_unreachable");
  const pausedUntil = organizationId ? status.alertsPausedUntil : null;

  // Ask again once the pause runs out, so the banner leaves on time.
  useEffect(() => {
    if (!(organizationId && pausedUntil)) {
      return;
    }
    const wait = Math.max(Date.parse(pausedUntil) - Date.now(), 0) + 1000;
    const timer = window.setTimeout(
      () => invalidateNotificationStatus(organizationId),
      wait
    );
    return () => window.clearTimeout(timer);
  }, [organizationId, pausedUntil]);

  let alert: React.ReactElement | null = null;
  if (unreachable && organizationId) {
    alert = <FailureAlertsUnreachableBanner organizationId={organizationId} />;
  } else if (pausedUntil && organizationId) {
    alert = (
      <FailureAlertsPausedBanner
        organizationId={organizationId}
        until={pausedUntil}
      />
    );
  }
  const alertRows = alert ? 1 : 0;
  const billing = isBillingEnabled();
  // With billing on, BillingBanner owns the offset for both strips.
  useAppBannerOffset(billing ? 0 : alertRows);

  return (
    <>
      {alert}
      {billing && <BillingBanner row={alertRows} />}
    </>
  );
}

/**
 * Owns the single fixed banner slot at the top of the app. A quota warning
 * outranks the plan announcement, so at most one banner renders and
 * `--app-banner-height` is set once for whichever won.
 */
function BillingBanner({
  row,
}: {
  /** Strips above it (the alerts banner). */
  row: number;
}): React.ReactElement | null {
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

  useAppBannerOffset(row + (visible ? 1 : 0));

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
    return (
      <QuotaBanner onDismiss={handleDismissQuota} row={row} status={status} />
    );
  }

  if (!announceVisible) {
    return null;
  }

  return (
    <AppBannerSlot
      className="border-keeperhub-green/30 bg-keeperhub-green/10 px-12"
      data-testid="app-banner"
      row={row}
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
    </AppBannerSlot>
  );
}
