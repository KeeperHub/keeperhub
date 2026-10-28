"use client";

import { Check, Loader2 } from "lucide-react";
import { useCallback, useState } from "react";
import { Notice } from "@/components/ui/notice";

type SaveState = "idle" | "saving" | "saved" | "error";

/** A save resolves to null when the server accepted it, or its refusal. */
export type SaveAction = () => Promise<string | null>;

export function useSaveState(): {
  state: SaveState;
  error: string | null;
  run: (action: SaveAction) => Promise<void>;
  reset: () => void;
} {
  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (action: SaveAction): Promise<void> => {
    setState("saving");
    setError(null);
    const refused = await action();
    setState(refused ? "error" : "saved");
    setError(refused);
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
      {shown === "idle" && dirty && "Unsaved changes"}
    </output>
  );
}

/** Why the server refused a save, kept until the next attempt or edit. */
export function SaveError({
  error,
}: {
  error: string | null;
}): React.ReactElement | null {
  if (!error) {
    return null;
  }
  return (
    <div data-testid="failure-alert-save-error">
      <Notice role="alert" tone="danger">
        <span className="font-medium">Not saved.</span> {error}
      </Notice>
    </div>
  );
}
