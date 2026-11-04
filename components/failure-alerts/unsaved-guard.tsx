"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  addLeaveGuard,
  GUARD_ENTRY_KEY,
  onGuardEntry,
} from "@/components/navigation-guard";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/** An in-app link that would leave this page, or null. */
function leavingLink(event: MouseEvent): string | null {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return null;
  }
  const anchor = (event.target as Element | null)?.closest?.("a[href]");
  if (!(anchor instanceof HTMLAnchorElement)) {
    return null;
  }
  if (anchor.target === "_blank" || anchor.hasAttribute("download")) {
    return null;
  }
  const url = new URL(anchor.href, window.location.href);
  if (url.origin !== window.location.origin) {
    return null;
  }
  if (url.pathname === window.location.pathname) {
    return null;
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

/** True when href points at another page than the one shown (undefined: always). */
function leavesPage(href: string | undefined): boolean {
  if (href === undefined) {
    return true;
  }
  const url = new URL(href, window.location.href);
  return (
    url.origin !== window.location.origin ||
    url.pathname !== window.location.pathname
  );
}

/**
 * Asks before leaving with unsaved changes: the browser's own prompt for a
 * reload or close, and a dialog for links, router navigation and Back.
 */
export function UnsavedChangesGuard({
  dirty,
  backFallback = "/",
}: {
  dirty: boolean;
  /** Where Back then Leave goes when there is no earlier page in the tab. */
  backFallback?: string;
}): React.ReactElement {
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;
  const fallbackRef = useRef(backFallback);
  fallbackRef.current = backFallback;
  const [asking, setAsking] = useState(false);
  const answerRef = useRef<((leave: boolean) => void) | null>(null);
  // Set on Leave, so the navigation it starts is not asked about again.
  const leavingRef = useRef(false);

  useEffect(() => {
    if (!dirty) {
      return;
    }
    leavingRef.current = false;
    const ask = (): Promise<boolean> =>
      new Promise((resolve) => {
        answerRef.current?.(false);
        answerRef.current = (leave: boolean) => {
          if (leave) {
            leavingRef.current = true;
          }
          resolve(leave);
        };
        setAsking(true);
      });
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (!leavingRef.current) {
        event.preventDefault();
      }
    };
    const onClick = (event: MouseEvent): void => {
      const href = leavingLink(event);
      if (!href) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      // The guarded router asks, then goes.
      routerRef.current.push(href);
    };
    // Back lands on a copy of this page pushed below, then asks.
    const pushGuardEntry = (): void => {
      window.history.pushState(
        { ...window.history.state, [GUARD_ENTRY_KEY]: true },
        "",
        window.location.href
      );
    };
    const goBack = (): void => {
      // The copy just pushed cut forward entries: more than two means an earlier page.
      if (window.history.length > 2) {
        window.history.go(-2);
        return;
      }
      // Opened from an email, say: no earlier page in this tab.
      routerRef.current.replace(fallbackRef.current);
      leavingRef.current = false;
    };
    const onPopState = (): void => {
      // Back from a same-page entry onto the copy stays on the page.
      if (leavingRef.current || onGuardEntry()) {
        return;
      }
      pushGuardEntry();
      ask()
        .then((leave) => {
          if (leave) {
            goBack();
          }
        })
        .catch(() => undefined);
    };
    // After a reload on the copy, it is reused rather than stacked.
    if (!onGuardEntry()) {
      pushGuardEntry();
    }
    // The action after Leave did not leave: guard again, Back included.
    const rearm = (): void => {
      leavingRef.current = false;
      if (!onGuardEntry()) {
        pushGuardEntry();
      }
    };
    const removeGuard = addLeaveGuard(
      (href) => (leavingRef.current || !leavesPage(href) ? null : ask()),
      rearm
    );
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("popstate", onPopState);
    document.addEventListener("click", onClick, true);
    return () => {
      removeGuard();
      answerRef.current?.(false);
      answerRef.current = null;
      setAsking(false);
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("popstate", onPopState);
      document.removeEventListener("click", onClick, true);
      // Saved while still here: drop the extra history entry.
      if (!leavingRef.current && onGuardEntry()) {
        leavingRef.current = true;
        window.history.back();
      }
    };
  }, [dirty]);

  const close = (leave: boolean): void => {
    const answer = answerRef.current;
    answerRef.current = null;
    setAsking(false);
    answer?.(leave);
  };

  return (
    <AlertDialog
      onOpenChange={(open) => {
        if (!open) {
          close(false);
        }
      }}
      open={asking}
    >
      <AlertDialogContent data-testid="failure-alerts-unsaved-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Leave without saving?</AlertDialogTitle>
          <AlertDialogDescription>
            Some alert settings on this page are not saved. They are lost if you
            leave now.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Stay</AlertDialogCancel>
          <AlertDialogAction onClick={() => close(true)}>
            Leave
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
