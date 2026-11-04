"use client";

import {
  AppRouterContext,
  type AppRouterInstance,
} from "next/dist/shared/lib/app-router-context.shared-runtime";
import { type ReactNode, useContext, useMemo } from "react";

/**
 * Asked before an in-app navigation: null lets it through, else answers true to
 * leave. `href` is undefined for an action that leaves whatever the URL.
 */
type LeaveGuard = (href: string | undefined) => Promise<boolean> | null;

const guards = new Set<LeaveGuard>();

/** History state key of the copy of a page a guard pushes for Back to land on. */
export const GUARD_ENTRY_KEY = "__leaveGuard";

/** Registers a guard; returns its removal. */
export function addLeaveGuard(guard: LeaveGuard): () => void {
  guards.add(guard);
  return () => {
    guards.delete(guard);
  };
}

/** True when the shown history entry is a guard's copy of the page. */
export function onGuardEntry(): boolean {
  return Boolean(window.history.state?.[GUARD_ENTRY_KEY]);
}

/** Steps back off a guard's copy of the page, so leaving adds no dead entry. */
function dropGuardEntry(): Promise<void> {
  if (!onGuardEntry()) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    window.addEventListener("popstate", () => resolve(), { once: true });
    window.history.back();
  });
}

/**
 * Asks every guard, then runs `proceed`: at once when none asks, after Leave
 * otherwise. Stay resolves null and runs nothing.
 */
export function confirmLeave<T>(
  href: string | undefined,
  proceed: () => T | Promise<T>
): Promise<T | null> {
  const answers: Promise<boolean>[] = [];
  for (const guard of guards) {
    const answer = guard(href);
    if (answer) {
      answers.push(answer);
    }
  }
  if (answers.length === 0) {
    return Promise.resolve(proceed());
  }
  return Promise.all(answers).then(async (leave) => {
    if (!leave.every(Boolean)) {
      return null;
    }
    await dropGuardEntry();
    return proceed();
  });
}

type Navigate = AppRouterInstance["push"];

/** The router with push and replace asking the guards first. */
export function guardRouter(router: AppRouterInstance): AppRouterInstance {
  const wrap =
    (navigate: Navigate): Navigate =>
    (href, options) => {
      confirmLeave(href, () => navigate(href, options)).catch(() => undefined);
    };
  return {
    ...router,
    push: wrap(router.push),
    replace: wrap(router.replace),
  };
}

/** Wraps the app so every useRouter() navigation passes the leave guards. */
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
