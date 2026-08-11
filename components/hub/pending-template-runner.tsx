"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { useSession } from "@/lib/auth-client";
import { AUTH_SUCCESS_EVENT } from "@/lib/auth-events";
import { isAnonymousUser } from "@/lib/is-anonymous";

const SESSION_KEY_PREFIX = "pending_template:";
const IDEMPOTENCY_TTL_MS = 30_000; // 30s (43-CONTEXT.md HUB-05)

type StoredFlag = { at: number };

type IntentResponse = { workflowId: string | null };

function readSessionFlag(workflowId: string): StoredFlag | null {
  if (typeof window === "undefined") {
    return null;
  }
  const raw = window.sessionStorage.getItem(SESSION_KEY_PREFIX + workflowId);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as StoredFlag;
    if (typeof parsed?.at === "number") {
      return parsed;
    }
  } catch {
    // Malformed entry — treat as absent.
  }
  return null;
}

function writeSessionFlag(workflowId: string): void {
  if (typeof window === "undefined") {
    return;
  }
  const value: StoredFlag = { at: Date.now() };
  try {
    window.sessionStorage.setItem(
      SESSION_KEY_PREFIX + workflowId,
      JSON.stringify(value)
    );
  } catch {
    // Quota / privacy mode — best-effort, OK to skip.
  }
}

function isFlagFresh(flag: StoredFlag): boolean {
  return Date.now() - flag.at < IDEMPOTENCY_TTL_MS;
}

/**
 * Mounts in app/layout.tsx (broadest scope). Reads the pending_template
 * intent cookie via GET /api/auth/template-intent (server clears it
 * atomically) and, if a workflowId is returned, triggers
 * api.workflow.duplicate exactly once. Runs in two situations:
 *
 *   1. Initial mount per page load — covers OAuth / magic-link
 *      round-trips that reload the page after auth.
 *   2. AUTH_SUCCESS_EVENT dispatched by the auth modal — covers
 *      in-place email+password sign-in / verify, where the modal
 *      closes without a navigation and the runner would otherwise
 *      never re-fetch the intent.
 *
 * Idempotency is guarded by (a) the server-side atomic cookie clear
 * (concurrent fires after the first one see workflowId=null), (b) a
 * 30s sessionStorage flag per workflowId, and (c) an in-flight ref to
 * suppress overlapping calls within the same tab.
 *
 * 43-CONTEXT.md HUB-05; UI-SPEC §4 Post-OAuth auto-trigger.
 */
export function PendingTemplateRunner(): null {
  const router = useRouter();
  const inFlight = useRef(false);
  const { data: session, isPending } = useSession();
  // A Better Auth ANONYMOUS session must not satisfy the gate: the funnel mints
  // anonymous sessions on many surfaces, and the intent cookie is only ever set
  // for a not-yet-signed-up visitor. Wait for a real signed-in user, not the
  // throwaway anonymous account.
  const isAuthenticated =
    Boolean(session?.user) && !isAnonymousUser(session?.user);

  useEffect(() => {
    // Only consume the pending_template cookie once a real (non-anonymous)
    // session exists. The GET clears the cookie atomically, so an anonymous
    // page load (reload / second tab while the auth dialog is open) would
    // otherwise destroy the intent and either duplicate the template under the
    // throwaway anonymous account or surface an error toast. The post-auth
    // resume path lands authenticated via the auth dialog's hard navigation
    // (window.location.assign), which reloads this runner with the real
    // session cookie set.
    if (isPending || !isAuthenticated) {
      return;
    }

    let cancelled = false;

    const run = async (): Promise<void> => {
      if (inFlight.current) {
        return;
      }
      inFlight.current = true;

      try {
        let workflowId: string | null = null;
        try {
          const res = await fetch("/api/auth/template-intent", {
            method: "GET",
            credentials: "same-origin",
          });
          if (!res.ok) {
            return;
          }
          const data = (await res.json()) as IntentResponse;
          workflowId = data.workflowId;
        } catch (err) {
          console.error("[PendingTemplate] read intent failed:", err);
          return;
        }

        if (!workflowId || cancelled) {
          return;
        }

        const existing = readSessionFlag(workflowId);
        if (existing && isFlagFresh(existing)) {
          return;
        }

        router.refresh();

        try {
          const duplicated = await api.workflow.duplicate(workflowId);
          writeSessionFlag(workflowId);
          toast.success("Template ready in your workflows");
          router.push(`/workflows/${duplicated.id}`);
        } catch (err) {
          console.error("[PendingTemplate] duplicate failed:", err);
          const message =
            err instanceof Error ? err.message : "Failed to use template";
          toast.error(message);
        }
      } finally {
        inFlight.current = false;
      }
    };

    run();

    const handler = (): void => {
      run();
    };
    window.addEventListener(AUTH_SUCCESS_EVENT, handler);

    return () => {
      cancelled = true;
      window.removeEventListener(AUTH_SUCCESS_EVENT, handler);
    };
  }, [router, isPending, isAuthenticated]);

  return null;
}
