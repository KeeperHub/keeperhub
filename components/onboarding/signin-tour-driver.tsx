"use client";

import "driver.js/dist/driver.css";
import { useEffect, useRef } from "react";
import { useSession } from "@/lib/auth-client";
import { isNewUserSession } from "@/lib/is-anonymous";
import { toursDisabled } from "@/lib/onboarding/tours-disabled";
import { waitForAnchor } from "@/lib/onboarding/wait-for-anchor";

const SEEN_KEY = "keeperhub-signin-tour-driver-seen";
const ANCHOR_SELECTOR = '[data-tour="signin-button"]';

function hasSeenTour(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === "true";
  } catch {
    // Storage blocked (Safari private mode); treat as not seen.
    return false;
  }
}

function markSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, "true");
  } catch {
    // Storage unavailable; the tour may simply reappear next visit.
  }
}

/**
 * One-card sign-in tour (driver.js, MIT). Shows once per browser for new
 * (anonymous/unverified) visitors, anchored on the Sign In button.
 */
export function SignInTourDriver(): null {
  const { data: session, isPending } = useSession();
  const startedRef = useRef(false);
  const tourRef = useRef<{ destroy: () => void } | null>(null);

  useEffect(() => {
    if (isPending || startedRef.current) {
      return;
    }
    if (toursDisabled() || !isNewUserSession(session) || hasSeenTour()) {
      return;
    }

    startedRef.current = true;
    const controller = new AbortController();

    const startTour = async (): Promise<void> => {
      const anchor = await waitForAnchor(ANCHOR_SELECTOR, controller.signal);
      if (!anchor || controller.signal.aborted) {
        return;
      }

      const { driver } = await import("driver.js");
      if (controller.signal.aborted) {
        return;
      }

      const tour = driver({
        showProgress: false,
        showButtons: ["next"],
        doneBtnText: "Got it",
        allowClose: true,
        onDestroyed: () => markSeen(),
        steps: [
          {
            element: anchor,
            popover: {
              title: "Sign in to get started",
              description:
                "Create an account to save your workflows and unlock the full hub.",
              side: "bottom",
              align: "end",
            },
          },
        ],
      });
      tourRef.current = tour;
      tour.drive();
    };

    startTour().catch(() => {
      // driver.js failed to load or start; skip the tour silently.
    });

    return () => {
      controller.abort();
      tourRef.current?.destroy();
      tourRef.current = null;
    };
  }, [session, isPending]);

  return null;
}
