"use client";

import { useEffect, useRef } from "react";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { useSession } from "@/lib/auth-client";
import { BILLING_API } from "@/lib/billing/constants";
import { isBillingEnabled } from "@/lib/billing/feature-flag";
import { useActiveMember } from "@/lib/hooks/use-organization";
import type { TrialInfo } from "./pricing-table/types";
import { TrialUpsellModal } from "./trial-upsell-modal";

const STORAGE_KEY = "keeperhub:trial-upsell";
const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // wait a week between shows
const MAX_SHOWS = 3; // stop nudging after a few unanswered shows
const SHOW_PROBABILITY = 0.25; // only some eligible sessions, not every one
const SHOW_DELAY_MS = 6000; // let the user settle before interrupting
// Only nudge orgs with real engagement: at least 50% of their free execution
// cap used this month. Mirrors the billing-page usage banner threshold.
const MIN_USAGE_RATIO = 0.5;

// Once per tab session, regardless of client-side navigations.
let shownThisSession = false;

type UpsellState = {
  lastShownAt: number;
  shows: number;
  dismissedForever: boolean;
};

const DEFAULT_STATE: UpsellState = {
  lastShownAt: 0,
  shows: 0,
  dismissedForever: false,
};

function readState(): UpsellState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return DEFAULT_STATE;
    }
    return { ...DEFAULT_STATE, ...(JSON.parse(raw) as Partial<UpsellState>) };
  } catch {
    // Storage blocked (private mode) or corrupt value: treat as never shown.
    return DEFAULT_STATE;
  }
}

function writeState(state: UpsellState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage unavailable; frequency cap falls back to the per-session guard.
  }
}

type SubscriptionResponse = {
  subscription: { plan: string };
  trial?: TrialInfo;
  usage?: { executionsUsed: number; executionLimit: number };
};

/**
 * Decides whether to show the free-to-Pro trial upsell and opens it through the
 * global overlay. Renders nothing. Mounted once in GlobalModals so it reaches
 * users wherever they are (canvas included), not just the billing page.
 */
export function TrialUpsellController(): null {
  const { open, hasOverlays } = useOverlay();
  const { data: session, isPending } = useSession();
  const { isOwner } = useActiveMember();

  // Depend on a stable boolean, not the session object: its identity can change
  // mid-delay, and depending on it would tear down the effect and cancel the
  // scheduled show. Only org owners can start a trial, so only they see it.
  const canPrompt =
    !isPending &&
    Boolean(session?.user) &&
    !session?.user?.isAnonymous &&
    isOwner;

  // Read the latest "is another overlay open" at fire time without re-running
  // the decision effect on every stack change.
  const hasOverlaysRef = useRef(hasOverlays);
  hasOverlaysRef.current = hasOverlays;

  useEffect(() => {
    if (!canPrompt || shownThisSession || !isBillingEnabled()) {
      return;
    }

    const state = readState();
    if (
      state.dismissedForever ||
      state.shows >= MAX_SHOWS ||
      Date.now() - state.lastShownAt < COOLDOWN_MS ||
      Math.random() >= SHOW_PROBABILITY
    ) {
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function decide(): Promise<void> {
      const res = await fetch(BILLING_API.SUBSCRIPTION);
      if (!res.ok) {
        return;
      }
      const data = (await res.json()) as SubscriptionResponse;
      if (
        cancelled ||
        data.subscription.plan !== "free" ||
        !data.trial?.eligible
      ) {
        return;
      }
      // Only nudge engaged orgs: >= 50% of the free execution cap used.
      const limit = data.usage?.executionLimit ?? 0;
      const used = data.usage?.executionsUsed ?? 0;
      if (limit <= 0 || used / limit < MIN_USAGE_RATIO) {
        return;
      }
      const { days, tier } = data.trial;

      timer = setTimeout(() => {
        if (cancelled || shownThisSession || hasOverlaysRef.current) {
          return;
        }
        shownThisSession = true;
        const current = readState();
        writeState({
          ...current,
          lastShownAt: Date.now(),
          shows: current.shows + 1,
        });
        open(
          TrialUpsellModal,
          {
            days,
            tier,
            usage: data.usage,
            onNeverShowAgain: () =>
              writeState({ ...readState(), dismissedForever: true }),
          },
          { size: "2xl", title: "Start your free trial" }
        );
      }, SHOW_DELAY_MS);
    }

    decide().catch(() => undefined);

    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [canPrompt, open]);

  return null;
}
