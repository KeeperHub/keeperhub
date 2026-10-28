"use client";

import { Check, Loader2 } from "lucide-react";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";

type SaveState = "idle" | "saving" | "saved" | "error";

/** Why the server refused a save; stale means someone else saved first (409). */
export type SaveRefusal = { message: string; stale?: boolean };

/** A save resolves to null when the server accepted it. */
export type SaveAction = () => Promise<SaveRefusal | null>;

export function useSaveState(): {
  state: SaveState;
  error: SaveRefusal | null;
  run: (action: SaveAction) => Promise<boolean>;
  reset: () => void;
} {
  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState<SaveRefusal | null>(null);

  const run = useCallback(async (action: SaveAction): Promise<boolean> => {
    setState("saving");
    setError(null);
    const refused = await action();
    setState(refused ? "error" : "saved");
    setError(refused);
    return !refused;
  }, []);

  const reset = useCallback((): void => {
    setState("idle");
    setError(null);
  }, []);

  return { state, error, run, reset };
}

/** Saving / Saved / Not saved, beside a Save button. */
export function SaveFeedback({
  state,
  dirty,
  testId,
}: {
  state: SaveState;
  dirty: boolean;
  testId: string;
}): React.ReactElement {
  const shown = state === "saved" && dirty ? "idle" : state;
  return (
    <output
      aria-live="polite"
      className="flex items-center gap-1 text-muted-foreground text-xs"
      data-state={shown}
      data-testid={testId}
    >
      {shown === "saving" && (
        <>
          <Loader2 className="size-3 animate-spin" />
          Saving
        </>
      )}
      {shown === "saved" && (
        <>
          <Check className="size-3 text-keeperhub-green-dark" />
          Saved
        </>
      )}
      {shown === "error" && <span className="text-destructive">Not saved</span>}
      {shown === "idle" && dirty && "Not saved yet"}
    </output>
  );
}

/** Why the server refused a save, kept until the next attempt or edit. */
export function SaveError({
  error,
  onReload,
}: {
  error: SaveRefusal | null;
  /** Offered when someone else saved first. */
  onReload?: () => void;
}): React.ReactElement | null {
  if (!error) {
    return null;
  }
  return (
    <div
      data-stale={Boolean(error.stale)}
      data-testid="failure-alert-save-error"
    >
      <Notice role="alert" tone="danger">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>
            <span className="font-medium">Not saved.</span> {error.message}
          </span>
          {error.stale && onReload && (
            <Button
              className="h-auto px-0 text-xs"
              onClick={onReload}
              type="button"
              variant="link"
            >
              Reload
            </Button>
          )}
        </span>
      </Notice>
    </div>
  );
}
