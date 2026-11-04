"use client";

import {
  AppRouterContext,
  type AppRouterInstance,
} from "next/dist/shared/lib/app-router-context.shared-runtime";
import { useRouter } from "next/navigation";
import {
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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

/** True when href points at another page than the one shown. */
function leavesPage(href: string): boolean {
  const url = new URL(href, window.location.href);
  return (
    url.origin !== window.location.origin ||
    url.pathname !== window.location.pathname
  );
}

/** Set by a dirty guard: takes a router navigation over (true) or lets it run. */
let interceptLeave: ((href: string, go: () => void) => boolean) | null = null;

type Navigate = AppRouterInstance["push"];

/** The router with push and replace asking the active guard first. */
export function guardRouter(router: AppRouterInstance): AppRouterInstance {
  const wrap =
    (navigate: Navigate): Navigate =>
    (href, options) => {
      if (interceptLeave?.(href, () => navigate(href, options))) {
        return;
      }
      navigate(href, options);
    };
  return { ...router, push: wrap(router.push), replace: wrap(router.replace) };
}

/** Wraps the app so every useRouter() navigation passes the unsaved guard. */
export function LeaveGuardRouter({
  children,
}: {
  children: ReactNode;
}): React.ReactElement {
  const router = useContext(AppRouterContext);
  const guarded = useMemo(
    () => (router ? guardRouter(router) : null),
    [router]
  );
  if (!guarded) {
    return <>{children}</>;
  }
  return (
    <AppRouterContext.Provider value={guarded}>
      {children}
    </AppRouterContext.Provider>
  );
}

const SENTINEL = "__unsavedGuard";

/**
 * Asks before leaving with unsaved changes: the browser's own prompt for a
 * reload or close, and a dialog for links, router navigation and Back.
 */
export function UnsavedChangesGuard({
  dirty,
}: {
  dirty: boolean;
}): React.ReactElement {
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;
  const [pending, setPending] = useState<(() => void) | null>(null);
  // Set on Leave, so the navigation it starts is not asked about again.
  const leavingRef = useRef(false);

  useEffect(() => {
    if (!dirty) {
      return;
    }
    leavingRef.current = false;
    const ask = (go: () => void): void => {
      setPending(() => go);
    };
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    const onClick = (event: MouseEvent): void => {
      const href = leavingLink(event);
      if (!href) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      ask(() => routerRef.current.push(href));
    };
    // Back lands on a copy of this page pushed below, then asks.
    const pushSentinel = (): void => {
      window.history.pushState(
        { ...window.history.state, [SENTINEL]: true },
        "",
        window.location.href
      );
    };
    const onPopState = (): void => {
      if (leavingRef.current) {
        return;
      }
      pushSentinel();
      ask(() => window.history.go(-2));
    };
    pushSentinel();
    interceptLeave = (href, go) => {
      if (leavingRef.current || !leavesPage(href)) {
        return false;
      }
      ask(go);
      return true;
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("popstate", onPopState);
    document.addEventListener("click", onClick, true);
    return () => {
      interceptLeave = null;
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("popstate", onPopState);
      document.removeEventListener("click", onClick, true);
      // Saved while still here: drop the extra history entry.
      if (!leavingRef.current && window.history.state?.[SENTINEL]) {
        leavingRef.current = true;
        window.history.back();
      }
    };
  }, [dirty]);

  return (
    <AlertDialog
      onOpenChange={(open) => {
        if (!open) {
          setPending(null);
        }
      }}
      open={pending !== null}
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
          <AlertDialogAction
            onClick={() => {
              const go = pending;
              setPending(null);
              if (go) {
                leavingRef.current = true;
                go();
              }
            }}
          >
            Leave
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
