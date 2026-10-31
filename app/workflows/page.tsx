"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api-client";
import {
  latestVisibleWorkflow,
  newestWorkflow,
} from "@/lib/workflow/latest-workflow";

type IndexState = "loading" | "empty" | "error";

// Index route for `/workflows` (no workflow selected). Without this the bare
// path 404s in the canvas. Redirects to the most recently created workflow so
// the canvas always has content; falls back to an empty state when the org has
// none. A digest-email deep link (`?digestSettings=`) switches organization
// and opens a modal over this page, so the redirect waits while it is followed
// (the param stays until it is done with), rather than redirecting with the
// old organization's workflows. `?latest=edited` (the phone navigation
// drawer's Workflows) redirects to the workflow edited most recently instead,
// among those the lists show.
export default function WorkflowsIndexPage(): React.ReactElement | null {
  const router = useRouter();
  const searchParams = useSearchParams();
  const hasDeepLink = searchParams.get("digestSettings") !== null;
  const lastEdited = searchParams.get("latest") === "edited";
  const resolvedRef = useRef(false);
  const [state, setState] = useState<IndexState>("loading");

  const resolve = useCallback(async (): Promise<void> => {
    setState("loading");
    try {
      const list = await api.workflow.getAll();
      const mostRecent = lastEdited
        ? latestVisibleWorkflow(list)
        : newestWorkflow(list);
      if (mostRecent) {
        router.replace(`/workflows/${mostRecent.id}`);
      } else {
        setState("empty");
      }
    } catch {
      setState("error");
    }
  }, [router, lastEdited]);

  useEffect(() => {
    if (hasDeepLink || resolvedRef.current) {
      return;
    }
    resolvedRef.current = true;
    resolve();
  }, [hasDeepLink, resolve]);

  const handleRetry = (): void => {
    resolvedRef.current = true;
    resolve();
  };

  if (state === "loading") {
    return null;
  }

  if (state === "error") {
    return (
      <div className="flex h-dvh w-full flex-col items-center justify-center gap-3 text-center">
        <h1 className="font-semibold text-xl">Couldn&apos;t load workflows</h1>
        <p className="text-muted-foreground text-sm">
          Something went wrong while fetching your workflows. Try again.
        </p>
        <Button onClick={handleRetry}>Retry</Button>
      </div>
    );
  }

  return (
    <div className="flex h-dvh w-full flex-col items-center justify-center gap-3 text-center">
      <h1 className="font-semibold text-xl">No workflows yet</h1>
      <p className="text-muted-foreground text-sm">
        Create your first workflow to get started.
      </p>
      <Button onClick={() => router.push("/")}>New workflow</Button>
    </div>
  );
}
