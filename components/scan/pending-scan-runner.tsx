"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useSession } from "@/lib/auth-client";
import { AUTH_SUCCESS_EVENT } from "@/lib/auth-events";
import { isAnonymousUser } from "@/lib/is-anonymous";
import { persistSuggestion } from "@/lib/scan/persist-suggestion";
import type { SuggestionDescriptor } from "@/lib/scan/suggestions/types";

const SESSION_KEY_PREFIX = "pending_scan:";
const IDEMPOTENCY_TTL_MS = 30_000; // 30s — mirrors PendingTemplateRunner

type StoredFlag = { at: number };

interface ScanIntent extends SuggestionDescriptor {
  mode: string;
  address?: string;
}

type ScanIntentResponse = { intent: ScanIntent | null };

function readSessionFlag(key: string): StoredFlag | null {
  if (typeof window === "undefined") {
    return null;
  }
  const raw = window.sessionStorage.getItem(SESSION_KEY_PREFIX + key);
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

function writeSessionFlag(key: string): void {
  if (typeof window === "undefined") {
    return;
  }
  const value: StoredFlag = { at: Date.now() };
  try {
    window.sessionStorage.setItem(
      SESSION_KEY_PREFIX + key,
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
 * Runtime type guard for the JSON payload returned by GET /api/auth/scan-intent.
 *
 * Validates the required SuggestionDescriptor fields (id, category, chainId,
 * readOrWrite, confirmInputs) plus the runner-specific mode field. If the
 * cookie was crafted or corrupted, rejects it early rather than passing a
 * malformed object into buildWorkflow (IN-01).
 */
function isValidScanIntent(v: unknown): v is ScanIntent {
  if (v === null || typeof v !== "object") {
    return false;
  }
  const s = v as Record<string, unknown>;
  return (
    typeof s.id === "string" &&
    s.id.length > 0 &&
    typeof s.category === "string" &&
    typeof s.chainId === "number" &&
    (s.readOrWrite === "read" || s.readOrWrite === "write") &&
    s.confirmInputs !== null &&
    typeof s.confirmInputs === "object" &&
    (s.mode === "run" || s.mode === "schedule")
  );
}

/**
 * Mounts in app/layout.tsx (broadest scope). Reads the pending_scan HttpOnly
 * cookie via GET /api/auth/scan-intent (atomically cleared on read) and, if a
 * scan intent is present, persists the workflow and navigates to /workflows/{id}.
 *
 * Fires in two situations:
 *   1. Initial mount per page load — covers OAuth / magic-link round-trips that
 *      reload the page after auth.
 *   2. AUTH_SUCCESS_EVENT dispatched by the auth modal — covers in-place
 *      email+password sign-in where the modal closes without a navigation.
 *
 * Three-guard idempotency (T-54-21):
 *   (a) server atomic cookie clear — concurrent GETs after the first see null
 *   (b) 30s sessionStorage flag keyed by descriptor.id (NOT suggestionSlug)
 *   (c) inFlight ref suppresses overlapping calls within the same tab
 *
 * Mirrors components/hub/pending-template-runner.tsx structure exactly.
 * FUNNEL-03/04.
 */
export function PendingScanRunner(): null {
  const router = useRouter();
  const inFlight = useRef(false);
  const { data: session, isPending } = useSession();
  // A Better Auth ANONYMOUS session must not satisfy the gate: the funnel mints
  // anonymous sessions on many surfaces (homepage/hub "try building" flows), and
  // the intent cookie is only ever set for a not-yet-signed-up visitor. Mirror
  // the scan page's own check (app/scan/page.tsx) so consumption waits for a
  // real signed-in user, not the throwaway anonymous account.
  const isAuthenticated =
    Boolean(session?.user) && !isAnonymousUser(session?.user);

  useEffect(() => {
    // Guard (d): only consume the pending_scan cookie once a real (non-anonymous)
    // session exists. GET /api/auth/scan-intent clears the cookie atomically, so
    // an anonymous page load (reload / second tab while the auth dialog is open)
    // would otherwise destroy the intent and either persist the workflow under
    // the throwaway anonymous account or surface an "Unauthorized" toast. The
    // post-auth resume paths land authenticated via the auth dialog's hard
    // navigation (window.location.assign), which reloads this runner with the
    // real session cookie set.
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
        let intent: ScanIntent | null = null;
        try {
          const res = await fetch("/api/auth/scan-intent", {
            method: "GET",
            credentials: "same-origin",
          });
          if (!res.ok) {
            return;
          }
          const data = (await res.json()) as ScanIntentResponse;
          intent = data.intent;
        } catch {
          return;
        }

        // IN-01: validate the cookie-derived payload before use. Malformed or
        // crafted cookies are silently discarded — no toast spam.
        if (!isValidScanIntent(intent) || cancelled) {
          return;
        }

        // Guard (b): sessionStorage TTL keyed on descriptor.id (FUNNEL-03, T-54-21)
        const idempotencyKey = intent.id;
        const existing = readSessionFlag(idempotencyKey);
        if (existing && isFlagFresh(existing)) {
          return;
        }

        router.refresh();

        // T-54-23: anything other than "schedule" is treated as "run"
        const mode: "run" | "schedule" =
          intent.mode === "schedule" ? "schedule" : "run";

        try {
          const { id } = await persistSuggestion(intent, mode, {
            defaultEmail: session?.user?.email,
          });
          writeSessionFlag(idempotencyKey);
          toast.success("Workflow saved");
          router.push(`/workflows/${id}`);
        } catch (err) {
          const message =
            err instanceof Error ? err.message : "Failed to save workflow";
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
  }, [router, isPending, isAuthenticated, session?.user?.email]);

  return null;
}
