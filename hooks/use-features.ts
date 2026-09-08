"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type {
  FeatureDefinition,
  FeatureId,
  FeatureSnapshotForClient,
} from "@/lib/features";
import { resolveActionFeature } from "@/lib/features";

type SnapshotResponse = FeatureSnapshotForClient & { billingEnabled: boolean };

const RETRY_INTERVAL_MS = 250;
const MAX_RETRY_ATTEMPTS = 60;

// Module-level cache: snapshot is keyed only by the current session/org cookie
// the browser sends with the request. Org switches typically trigger a page
// reload elsewhere; if a flow requires invalidation, call `invalidateFeatureSnapshot()`.
let cachedSnapshot: SnapshotResponse | null = null;
let inflight: Promise<SnapshotResponse> | null = null;
let cacheVersion = 0;
const invalidationListeners = new Set<() => void>();

function fetchSnapshot(): Promise<SnapshotResponse> {
  if (cachedSnapshot) {
    return Promise.resolve(cachedSnapshot);
  }
  if (inflight) {
    return inflight;
  }
  inflight = fetch("/api/features", { credentials: "include" })
    .then(async (res) => {
      if (!res.ok) {
        throw new Error(`Failed to load features: ${res.status}`);
      }
      const data = (await res.json()) as SnapshotResponse;
      cachedSnapshot = data;
      inflight = null;
      return data;
    })
    .catch((err: unknown) => {
      inflight = null;
      throw err;
    });
  return inflight;
}

export function invalidateFeatureSnapshot(): void {
  cachedSnapshot = null;
  inflight = null;
  cacheVersion += 1;
  for (const listener of invalidationListeners) {
    listener();
  }
}

type UseFeaturesResult = {
  snapshot: SnapshotResponse | null;
  loading: boolean;
  error: Error | null;
};

export function useFeatures(): UseFeaturesResult {
  const [snapshot, setSnapshot] = useState<SnapshotResponse | null>(
    cachedSnapshot
  );
  const [loading, setLoading] = useState<boolean>(!cachedSnapshot);
  const [error, setError] = useState<Error | null>(null);
  const [version, setVersion] = useState<number>(cacheVersion);
  const listenerRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!listenerRef.current) {
      listenerRef.current = () => {
        setSnapshot(null);
        setLoading(true);
        setVersion(cacheVersion);
      };
    }
    const listener = listenerRef.current;
    invalidationListeners.add(listener);
    return () => {
      invalidationListeners.delete(listener);
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: version is a re-fetch trigger; effect reads module-level cache, not version itself
  useEffect(() => {
    if (cachedSnapshot) {
      setSnapshot(cachedSnapshot);
      setLoading(false);
      return;
    }
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;

    const attempt = (): void => {
      if (cancelled) {
        return;
      }
      attempts += 1;
      fetchSnapshot()
        .then((data) => {
          if (cancelled) {
            return;
          }
          setSnapshot(data);
          setError(null);
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (cancelled) {
            return;
          }
          setError(err instanceof Error ? err : new Error(String(err)));
          if (attempts >= MAX_RETRY_ATTEMPTS) {
            setLoading(false);
            return;
          }
          // Poll until /api/features responds. UI stays in loading state so
          // gated nodes never appear unlocked during the outage. Server-side
          // guards remain authoritative regardless.
          timeoutId = setTimeout(attempt, RETRY_INTERVAL_MS);
        });
    };
    attempt();

    return () => {
      cancelled = true;
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
    };
  }, [version]);

  return { snapshot, loading, error };
}

type UseFeatureResult = {
  enabled: boolean;
  loading: boolean;
  feature: FeatureDefinition | undefined;
};

export function useFeature(featureId: FeatureId): UseFeatureResult {
  const { snapshot, loading } = useFeatures();
  if (!snapshot) {
    return { enabled: false, loading, feature: undefined };
  }
  return {
    enabled: snapshot.enabledFeatureIds.includes(featureId),
    loading,
    feature: snapshot.features.find((f) => f.id === featureId),
  };
}

// Convenience for the action picker: look up gating by the actionType string
// stored on a workflow node. Returns `{ feature: undefined }` for non-gated
// actions (most of them) so the caller can render normally.
type UseActionFeatureResult = {
  feature: FeatureDefinition | undefined;
  enabled: boolean;
  loading: boolean;
};

export function useActionFeature(actionType: string): UseActionFeatureResult {
  const { snapshot, loading } = useFeatures();
  const feature = resolveActionFeature(actionType);

  if (!feature) {
    return { feature: undefined, enabled: true, loading };
  }
  if (!snapshot) {
    return { feature, enabled: false, loading };
  }
  return {
    feature,
    enabled: snapshot.enabledFeatureIds.includes(feature.id),
    loading,
  };
}

const GATED_WORKFLOW_TOAST_ID = "gated-workflow-warning";

export function useGatedWorkflowWarning(
  workflowKey: string | null,
  actionTypes: readonly string[]
): void {
  const { snapshot, loading } = useFeatures();
  const lastSignature = useRef<string | null>(null);

  useEffect(() => {
    if (loading || !snapshot || !workflowKey) {
      return;
    }
    if (actionTypes.length === 0) {
      return;
    }

    const gatedNames: string[] = [];
    const seenFeatureIds = new Set<string>();
    for (const actionType of actionTypes) {
      const feature = resolveActionFeature(actionType);
      if (!feature) {
        continue;
      }
      if (snapshot.enabledFeatureIds.includes(feature.id)) {
        continue;
      }
      if (seenFeatureIds.has(feature.id)) {
        continue;
      }
      seenFeatureIds.add(feature.id);
      gatedNames.push(feature.name);
    }

    const planTag = snapshot.plan;
    const signature = `${planTag}::${workflowKey}::${[...gatedNames].sort().join("|")}`;
    if (lastSignature.current === signature) {
      return;
    }
    lastSignature.current = signature;

    if (gatedNames.length === 0) {
      toast.dismiss(GATED_WORKFLOW_TOAST_ID);
      return;
    }

    toast.warning("This workflow uses paid features", {
      id: GATED_WORKFLOW_TOAST_ID,
      description: `${gatedNames.join(", ")} ${gatedNames.length === 1 ? "requires" : "require"} a paid plan. Runs will fail until you upgrade.`,
      duration: 8000,
      action: {
        label: "Upgrade",
        onClick: () => {
          window.open(
            "https://keeperhub.com/pricing",
            "_blank",
            "noopener,noreferrer"
          );
        },
      },
    });
  }, [workflowKey, actionTypes, snapshot, loading]);
}
