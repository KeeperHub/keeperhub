"use client";

import {
  AppRouterContext,
  type AppRouterInstance,
} from "next/dist/shared/lib/app-router-context.shared-runtime";
import { type ReactNode, useContext, useMemo } from "react";

/**
 * Asked before an in-app navigation: null lets it through, a promise answers
 * true to leave or false to stay. `href` is undefined when an action leaves
 * the page's state whatever the URL (switching organization).
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

function pendingAnswers(href: string | undefined): Promise<boolean>[] {
  const answers: Promise<boolean>[] = [];
  for (const guard of guards) {
    const answer = guard(href);
    if (answer) {
      answers.push(answer);
    }
  }
  return answers;
}

/** True when the shown history entry is a guard's copy of the page. */
export function onGuardEntry(): boolean {
  return Boolean(window.history.state?.[GUARD_ENTRY_KEY]);
}

/** Asks every guard now: null when none asks, else whether to leave. */
export function askLeave(href?: string): Promise<boolean> | null {
  const answers = pendingAnswers(href);
  if (answers.length === 0) {
    return null;
  }
  return Promise.all(answers).then((leave) => leave.every(Boolean));
}

/**
 * Asks every guard before an action that acts first and navigates after
 * (switching organization, creating a workflow). False means stay.
 */
export function confirmLeave(href?: string): Promise<boolean> {
  return askLeave(href) ?? Promise.resolve(true);
}

type Navigate = AppRouterInstance["push"];

/** The router with push and replace asking the guards first. */
export function guardRouter(router: AppRouterInstance): AppRouterInstance {
  const wrap =
    (navigate: Navigate, isPush: boolean): Navigate =>
    (href, options) => {
      const go = (): void => {
        // A push from a guard's copy of the page takes that entry's place.
        if (isPush && onGuardEntry()) {
          router.replace(href, options);
        } else {
          navigate(href, options);
        }
      };
      const asked = askLeave(href);
      if (!asked) {
        go();
        return;
      }
      asked
        .then((leave) => {
          if (leave) {
            go();
          }
        })
        .catch(() => undefined);
    };
  return {
    ...router,
    push: wrap(router.push, true),
    replace: wrap(router.replace, false),
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
