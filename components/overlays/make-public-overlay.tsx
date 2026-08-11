"use client";

import { Check, Link2, Share2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Overlay } from "./overlay";
import { useOverlay } from "./overlay-provider";
import type { OverlayComponentProps } from "./types";

type MakePublicOverlayProps = OverlayComponentProps<{
  onConfirm: () => void;
}>;

export function MakePublicOverlay({
  overlayId,
  onConfirm,
}: MakePublicOverlayProps) {
  const { closeAll } = useOverlay();
  const [copied, setCopied] = useState(false);

  const handleConfirm = () => {
    closeAll();
    onConfirm();
  };

  const handleCopyLink = async (): Promise<void> => {
    await navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    toast.success("Link copied to clipboard");
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Overlay
      actions={[
        { label: "Cancel", variant: "outline", onClick: closeAll },
        { label: "Share", onClick: handleConfirm },
      ]}
      overlayId={overlayId}
      title="Share Workflow?"
    >
      <div className="flex items-center gap-2 text-muted-foreground">
        <Share2 className="size-5 shrink-0" />
        <p className="text-sm">
          Sharing this workflow means anyone with the link can:
        </p>
      </div>

      <ul className="mt-3 list-inside list-disc space-y-1 text-muted-foreground text-sm">
        <li>View the workflow structure and steps</li>
        <li>See action types and configurations</li>
        <li>Duplicate the workflow to their own account</li>
      </ul>

      <p className="mt-4 font-medium text-foreground text-sm">
        The following will remain private:
      </p>
      <ul className="mt-2 list-inside list-disc space-y-1 text-muted-foreground text-sm">
        <li>Your integration credentials (API keys, tokens)</li>
        <li>Execution logs and run history</li>
      </ul>

      <div className="mt-5 flex items-center gap-3 border-t border-border/50 pt-4">
        <Button
          className="gap-2 text-keeperhub-green hover:text-keeperhub-green"
          onClick={handleCopyLink}
          size="sm"
          variant="outline"
        >
          {copied ? (
            <Check className="size-4" />
          ) : (
            <Link2 className="size-4" />
          )}
          {copied ? "Copied" : "Copy link"}
        </Button>
        <span className="text-muted-foreground text-xs">
          Link will be accessible to others once shared
        </span>
      </div>
    </Overlay>
  );
}
