"use client";

import { CheckCircle2, CircleDot, Loader2 } from "lucide-react";
import { timeAgo } from "@/components/settings/hub/relative-time";
import { Button } from "@/components/ui/button";
import { WARNING_TEXT } from "@/components/ui/notice";
import { cn } from "@/lib/utils";
import { SaveError, type SaveRefusal } from "./save-state";

/**
 * One Save for the rules, email and every method, pinned to the bottom of the
 * screen, so it is always clear whether what is on the page is saved.
 */
export function SaveBar({
  dirty,
  saving,
  error,
  savedAt,
  onSave,
  onDiscard,
  onReload,
}: {
  dirty: boolean;
  saving: boolean;
  error: SaveRefusal | null;
  /** When this page last saved, for "Saved just now". */
  savedAt: number | null;
  onSave: () => void;
  onDiscard: () => void;
  onReload: () => void;
}): React.ReactElement {
  return (
    <div
      className={cn(
        "sticky bottom-3 z-10 space-y-2 rounded-xl border-2 bg-card/95 p-3 shadow-lg backdrop-blur-sm",
        dirty ? "border-yellow-500/50" : "border-keeperhub-green/40"
      )}
      data-dirty={dirty}
      data-testid="failure-alerts-save-bar"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p
          className="flex min-w-0 flex-1 basis-56 items-center gap-2 text-sm"
          role="status"
        >
          {dirty ? (
            <>
              <CircleDot
                aria-hidden="true"
                className={cn("size-4 shrink-0", WARNING_TEXT)}
              />
              <span>
                <span className={cn("font-semibold", WARNING_TEXT)}>
                  Unsaved changes.
                </span>{" "}
                <span className="text-muted-foreground">
                  Rules, email and methods are saved together.
                </span>
              </span>
            </>
          ) : (
            <>
              <CheckCircle2
                aria-hidden="true"
                className="size-4 shrink-0 text-keeperhub-green-dark"
              />
              <span className="font-medium">
                All changes saved
                {savedAt ? (
                  <span className="font-normal text-muted-foreground">
                    {" "}
                    ({timeAgo(new Date(savedAt).toISOString())})
                  </span>
                ) : null}
              </span>
            </>
          )}
        </p>
        <div className="flex gap-2">
          <Button
            data-testid="failure-alerts-discard"
            disabled={!dirty || saving}
            onClick={onDiscard}
            size="sm"
            type="button"
            variant="ghost"
          >
            Discard
          </Button>
          <Button
            data-testid="failure-alerts-save"
            disabled={!dirty || saving}
            onClick={onSave}
            size="sm"
            type="button"
          >
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {saving ? "Saving..." : "Save changes"}
          </Button>
        </div>
      </div>
      <SaveError error={error} onReload={onReload} />
    </div>
  );
}
