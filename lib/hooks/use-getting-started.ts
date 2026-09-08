"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { authClient, useSession } from "@/lib/auth-client";
import { isAnonymousUser } from "@/lib/is-anonymous";
import {
  type BranchKey,
  type ChipContext,
  getBranches,
  resolveTestnetWorkspace,
  type SignalId,
  type Step,
  type WalletBalanceEntry,
} from "@/lib/onboarding/getting-started-config";
import {
  isChipAwareStepComplete,
  type StepCompleteStatus,
} from "@/lib/onboarding/getting-started-step-complete";
import { gettingStartedSuppressed } from "@/lib/onboarding/tours-disabled";
import { useWalletInfo } from "@/lib/wallet/use-wallet-info";

/**
 * Persisted UI state + completion for the getting-started launcher (KEEP-878).
 *
 * Completion is hybrid:
 *  - Outcome steps are detected from real state (`GET /api/onboarding/status`):
 *    a step turns green once the user has actually created an API key,
 *    connected an alert channel, or run a workflow. Opening the surface does
 *    not complete them.
 *  - Once a non-chip signal is first observed satisfied it is latched into
 *    persisted `done`, so the step stays complete even if the underlying
 *    workflow / key is later deleted.
 *  - Chip-bearing steps derive from a LIVE starter clone when any chip was
 *    ever cloned (deleting the clone un-completes). If no chip was ever
 *    cloned, `done` is honored so adding chips does not regress users who
 *    already finished the step.
 *  - Informational steps ("open your wallet") have no measurable outcome and
 *    complete the first time the user opens them.
 *
 * `workflows` remembers the workflow created for an "ai-prompt" step so taking
 * that step again reuses it instead of spawning another Untitled Workflow.
 * All of this persists per user in localStorage.
 */

export type LauncherState = "expanded" | "collapsed" | "dismissed";

/** Signals satisfied by opening the surface (no server-measurable outcome). */
const CLICK_DRIVEN: ReadonlySet<SignalId> = new Set<SignalId>([
  "walletReady",
  "walletFunded",
  // Connecting an agent happens in the user's own MCP client; opening the
  // in-app modal is all there is to do here, so complete the step on open.
  "agentConnected",
]);

type OnboardingStatus = {
  hasApiKey: boolean;
  hasIntegration: boolean;
  /** Launcher-created workflows that have at least one execution. */
  executedWorkflowIds: string[];
  /** Launcher-created workflows that still exist (not deleted) in the org. */
  existingWorkflowIds: string[];
  /**
   * The workflow ids this status was computed for (client-augmented). Lets the
   * UI distinguish "checked and confirmed deleted" from "not yet checked", so a
   * just-cloned id reads as live until the next fetch proves otherwise.
   */
  checkedWorkflowIds: string[];
};

type Persisted = {
  state: LauncherState;
  branch: BranchKey;
  done: string[];
  workflows: Record<string, string>;
};

function storageKey(userId: string | undefined): string {
  // v2: completion is now real-state + scoped-execution latched; drop any v1
  // state that latched steps from org-wide signals.
  return `kh:getting-started:v2:${userId ?? "anon"}`;
}

function readPersisted(userId: string | undefined): Persisted {
  const fallback: Persisted = {
    state: "collapsed",
    branch: "agent",
    done: [],
    workflows: {},
  };
  if (typeof window === "undefined") {
    return fallback;
  }
  // Checked before the stored state, not only in place of it. A saved
  // Playwright session carries the localStorage written when the launcher
  // expanded during sign-in, so honouring the cookie only on a missing entry
  // left the card open in every test that reused that session.
  if (gettingStartedSuppressed()) {
    return fallback;
  }
  try {
    const raw = localStorage.getItem(storageKey(userId));
    if (!raw) {
      // No stored entry for a known user means they have never seen the
      // launcher (e.g. a fresh signup): open it expanded so onboarding is
      // visible by default. Once they collapse or dismiss it, that choice is
      // persisted and honored. Guard on userId so the pre-hydration render
      // (userId undefined) stays collapsed and existing users do not flash open
      // before their stored collapsed state loads. Playwright suppresses the
      // auto-expand by cookie so the card never covers the canvas.
      return userId ? { ...fallback, state: "expanded" } : fallback;
    }
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    return {
      state: parsed.state ?? fallback.state,
      branch: parsed.branch ?? fallback.branch,
      done: Array.isArray(parsed.done) ? parsed.done : [],
      workflows:
        parsed.workflows && typeof parsed.workflows === "object"
          ? parsed.workflows
          : {},
    };
  } catch {
    return fallback;
  }
}

/** Whether any workflow this step created has been run. */
function stepWorkflowRan(
  step: Step,
  workflows: Record<string, string>,
  executedWorkflowIds: string[]
): boolean {
  const prefix = `${step.key}:`;
  for (const [key, workflowId] of Object.entries(workflows)) {
    if (key.startsWith(prefix) && executedWorkflowIds.includes(workflowId)) {
      return true;
    }
  }
  return false;
}

function resolveRealSignal(
  step: Step,
  status: StepCompleteStatus | null,
  workflows: Record<string, string>
): boolean {
  if (!status) {
    return false;
  }
  switch (step.signal) {
    case "agentConnected":
      return status.hasApiKey;
    case "alertsConnected":
      return status.hasIntegration;
    case "ranWorkflow":
      return stepWorkflowRan(step, workflows, status.executedWorkflowIds);
    default:
      return false;
  }
}

/** Real-signal steps newly satisfied by `status` that are not yet latched. */
function newlyCompletedSteps(
  status: OnboardingStatus,
  done: string[],
  workflows: Record<string, string>
): string[] {
  const fresh: string[] = [];
  for (const branch of getBranches()) {
    for (const step of branch.steps) {
      if (CLICK_DRIVEN.has(step.signal) || step.signal === "always") {
        continue;
      }
      if (
        resolveRealSignal(step, status, workflows) &&
        !done.includes(step.key)
      ) {
        fresh.push(step.key);
      }
    }
  }
  return fresh;
}

export type GettingStarted = {
  isStepComplete: (step: Step) => boolean;
  state: LauncherState;
  setState: (next: LauncherState) => void;
  branch: BranchKey;
  setBranch: (next: BranchKey) => void;
  markStepActioned: (step: Step) => void;
  getStepWorkflowId: (key: string) => string | undefined;
  setStepWorkflowId: (key: string, workflowId: string) => void;
  /** Whether the workflow stored under `key` still exists in the org. */
  hasLiveStepWorkflow: (key: string) => boolean;
  refetch: () => void;
  isAuthenticated: boolean;
  /**
   * Chip slug -> live hub workflow id, resolved from /api/onboarding/recommendations.
   * Pass this into getBranches({ resolvedIds }) so chips clone the seeded hub
   * workflow instead of falling back to the AI prompt.
   */
  recommendedIds: Record<string, string>;
  chipContext: ChipContext;
};

export function useGettingStarted(): GettingStarted {
  const { data: session } = useSession();
  const { data: activeOrg } = authClient.useActiveOrganization();
  const userId = session?.user?.id;
  const isAuthenticated =
    Boolean(session?.user) && !isAnonymousUser(session?.user);
  const activeOrgId = activeOrg?.id ?? null;
  const [persisted, setPersisted] = useState<Persisted>(() =>
    readPersisted(undefined)
  );
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [recommendedIds, setRecommendedIds] = useState<Record<string, string>>(
    {}
  );
  const [testnetWorkspace, setTestnetWorkspace] = useState(
    resolveTestnetWorkspace(undefined)
  );
  const { walletAddress } = useWalletInfo();

  const chipContext = useMemo((): ChipContext => {
    return {
      walletAddress,
      isTestnetWorkspace: testnetWorkspace.isTestnetWorkspace,
      chainId: testnetWorkspace.chainId,
      resolvedIds: recommendedIds,
    };
  }, [walletAddress, testnetWorkspace, recommendedIds]);

  // Re-hydrate persisted state once the user id is known (the key is per-user).
  useEffect(() => {
    setPersisted(readPersisted(userId));
  }, [userId]);

  const persistedRef = useRef(persisted);
  persistedRef.current = persisted;

  // Functional updater over a synchronously-maintained ref. Reading the latest
  // value from the ref (not the render closure) lets two mutations fired in the
  // same tick compose -- e.g. setStepWorkflowId + completeStep on a chip clone --
  // instead of the second clobbering the first. localStorage is written
  // synchronously so the value survives an immediate navigation.
  const persist = useCallback(
    (update: (prev: Persisted) => Persisted) => {
      const next = update(persistedRef.current);
      persistedRef.current = next;
      setPersisted(next);
      try {
        localStorage.setItem(storageKey(userId), JSON.stringify(next));
      } catch {
        // localStorage unavailable
      }
    },
    [userId]
  );

  const workflowIds = Object.values(persisted.workflows).join(",");
  const fetchStatus = useCallback(() => {
    if (!isAuthenticated) {
      return;
    }
    const query = workflowIds
      ? `?workflowIds=${encodeURIComponent(workflowIds)}`
      : "";
    const checked = workflowIds ? workflowIds.split(",") : [];
    fetch(`/api/onboarding/status${query}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: Omit<OnboardingStatus, "checkedWorkflowIds"> | null) => {
        if (data) {
          setStatus({ ...data, checkedWorkflowIds: checked });
        }
      })
      .catch(() => undefined);
  }, [isAuthenticated, workflowIds]);

  // Refresh real-state signals on mount and whenever the window regains focus
  // (e.g. returning from the builder after running a workflow).
  useEffect(() => {
    fetchStatus();
    window.addEventListener("focus", fetchStatus);
    return () => window.removeEventListener("focus", fetchStatus);
  }, [fetchStatus]);

  // Fetch hub workflow ids for onboarding chips once per session.
  useEffect(() => {
    if (!isAuthenticated || persisted.state === "dismissed") {
      return;
    }
    fetch("/api/onboarding/recommendations")
      .then((r) =>
        r.ok ? (r.json() as Promise<Record<string, string>>) : null
      )
      .then((data) => {
        if (data) {
          setRecommendedIds(data);
        }
      })
      .catch(() => undefined);
  }, [isAuthenticated, persisted.state]);

  // Derive testnet workspace from org wallet balances when the launcher is expanded.
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeOrgId is the refetch trigger on org switch; balances are scoped server-side
  useEffect(() => {
    if (!isAuthenticated || persisted.state !== "expanded") {
      setTestnetWorkspace(resolveTestnetWorkspace(undefined));
      return;
    }
    fetch("/api/user/wallet/balances")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { balances?: WalletBalanceEntry[] } | null) => {
        if (data) {
          setTestnetWorkspace(resolveTestnetWorkspace(data.balances));
        }
      })
      .catch(() => undefined);
  }, [isAuthenticated, persisted.state, activeOrgId]);

  // While the checklist is open, poll so an outcome completed elsewhere (an
  // in-app overlay, or running the draft in the builder) is reflected without
  // a manual refresh.
  useEffect(() => {
    if (persisted.state !== "expanded") {
      return;
    }
    const id = setInterval(fetchStatus, 6000);
    return () => clearInterval(id);
  }, [persisted.state, fetchStatus]);

  // Latch satisfied real signals into `done` so completion survives the user
  // later deleting the workflow / key that produced it. Read persisted via ref
  // so this effect only reacts to status changes, not to every launcher action.
  useEffect(() => {
    if (!status) {
      return;
    }
    persist((prev) => {
      const fresh = newlyCompletedSteps(status, prev.done, prev.workflows);
      return fresh.length > 0
        ? { ...prev, done: [...prev.done, ...fresh] }
        : prev;
    });
  }, [status, persist]);

  const setState = useCallback(
    (next: LauncherState) => persist((prev) => ({ ...prev, state: next })),
    [persist]
  );
  const setBranch = useCallback(
    (next: BranchKey) => persist((prev) => ({ ...prev, branch: next })),
    [persist]
  );
  const markStepActioned = useCallback(
    (step: Step) => {
      // Outcome steps complete from real state, not from being opened.
      if (!CLICK_DRIVEN.has(step.signal)) {
        return;
      }
      persist((prev) =>
        prev.done.includes(step.key)
          ? prev
          : { ...prev, done: [...prev.done, step.key] }
      );
    },
    [persist]
  );
  // A launcher-tracked workflow id is "live" when it still exists in the org.
  // Optimistic before the first status fetch and for ids not yet checked (so a
  // just-cloned workflow reads as live immediately); only an id confirmed
  // deleted by a status response reads as not-live. This is what makes a chip
  // un-mark itself when its clone is deleted, instead of trusting a stale
  // localStorage pointer.
  const isWorkflowLive = useCallback(
    (id: string | undefined): boolean => {
      if (!id) {
        return false;
      }
      if (!status) {
        return true;
      }
      return !(
        status.checkedWorkflowIds.includes(id) &&
        !status.existingWorkflowIds.includes(id)
      );
    },
    [status]
  );
  const hasLiveStepWorkflow = useCallback(
    (key: string): boolean => isWorkflowLive(persisted.workflows[key]),
    [isWorkflowLive, persisted.workflows]
  );
  const isStepComplete = useCallback(
    (step: Step): boolean =>
      isChipAwareStepComplete({
        step,
        done: persisted.done,
        workflows: persisted.workflows,
        status,
        isWorkflowLive,
        resolveRealSignal,
        isClickDriven: (signal) => CLICK_DRIVEN.has(signal),
      }),
    [persisted.done, persisted.workflows, status, isWorkflowLive]
  );
  const getStepWorkflowId = useCallback(
    (key: string): string | undefined => persisted.workflows[key],
    [persisted.workflows]
  );
  const setStepWorkflowId = useCallback(
    (key: string, workflowId: string) =>
      persist((prev) => ({
        ...prev,
        workflows: { ...prev.workflows, [key]: workflowId },
      })),
    [persist]
  );

  return {
    isStepComplete,
    state: persisted.state,
    setState,
    branch: persisted.branch,
    setBranch,
    markStepActioned,
    getStepWorkflowId,
    setStepWorkflowId,
    hasLiveStepWorkflow,
    refetch: fetchStatus,
    isAuthenticated,
    recommendedIds,
    chipContext,
  };
}
