"use client";

import { Copy, X } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Shown once, right after a key is minted -- the secret is never returned again. */
export function NewKeyBanner({
  secret,
  onCopy,
  onDismiss,
}: {
  secret: string;
  onCopy: () => void;
  onDismiss: () => void;
}): React.ReactElement {
  return (
    <div className="m-2 rounded-lg border border-amber-500/40 bg-amber-500/[0.06] p-3">
      <div className="flex items-start justify-between gap-3">
        <p className="font-medium text-amber-400 text-sm">
          Copy this key now. It will not be shown again.
        </p>
        <Button
          aria-label="Dismiss"
          className="-mt-1 -mr-1 size-7"
          onClick={onDismiss}
          size="icon"
          variant="ghost"
        >
          <X className="size-3.5" />
        </Button>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1.5 font-mono text-xs">
          {secret}
        </code>
        <Button onClick={onCopy} size="sm" variant="outline">
          <Copy className="size-3.5" />
          Copy
        </Button>
      </div>
    </div>
  );
}
