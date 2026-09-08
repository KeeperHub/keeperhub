"use client";

import { AlertTriangle, Globe, Link2, Lock } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Overlay } from "@/components/overlays/overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import type { OverlayComponentProps } from "@/components/overlays/types";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { api, type PublicTag } from "@/lib/api-client";
import type { WorkflowVisibility } from "@/lib/workflow/store";
import { PublicTagSelector } from "./public-tag-selector";

type GoLiveResult = {
  name: string;
  publicTags: PublicTag[];
  visibility: WorkflowVisibility;
};

type GoLiveOverlayProps = OverlayComponentProps<{
  workflowId: string;
  currentName: string;
  currentVisibility: WorkflowVisibility;
  orgTagNames: string[];
  initialTags?: PublicTag[];
  isEditing?: boolean;
  onConfirm: (data: GoLiveResult) => void;
}>;

export function GoLiveOverlay({
  overlayId,
  workflowId,
  currentName,
  currentVisibility,
  orgTagNames,
  initialTags = [],
  isEditing = false,
  onConfirm,
}: GoLiveOverlayProps): React.JSX.Element {
  const { closeAll } = useOverlay();
  const [name, setName] = useState(currentName);
  const [selectedTags, setSelectedTags] = useState<PublicTag[]>(initialTags);
  const [access, setAccess] = useState<WorkflowVisibility>(
    currentVisibility ?? "private"
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isCopying, setIsCopying] = useState(false);
  const [copied, setCopied] = useState(false);

  const title = isEditing ? "Share Settings" : "Share";

  const persistChanges = async (
    targetVisibility: WorkflowVisibility,
    options: { closeAfter: boolean; quiet?: boolean }
  ): Promise<GoLiveResult | null> => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast.error("Please enter a workflow name");
      return null;
    }

    if (!options.quiet) {
      setIsSubmitting(true);
    }
    try {
      if (targetVisibility === "private") {
        await api.workflow.update(workflowId, {
          name: trimmedName,
          visibility: "private",
        });
      } else {
        await api.workflow.goLive(workflowId, {
          name: trimmedName,
          mode: targetVisibility,
          publicTagIds:
            targetVisibility === "public"
              ? selectedTags.map((t) => t.id)
              : undefined,
        });
      }
      const result: GoLiveResult = {
        name: trimmedName,
        publicTags: targetVisibility === "public" ? selectedTags : [],
        visibility: targetVisibility,
      };
      if (options.closeAfter) {
        closeAll();
        setTimeout(() => onConfirm(result), 250);
      } else {
        setIsSubmitting(false);
        onConfirm(result);
      }
      return result;
    } catch (error) {
      setIsSubmitting(false);
      toast.error(
        error instanceof Error ? error.message : `Failed to ${title.toLowerCase()}`
      );
      return null;
    }
  };

  const handleDone = async (): Promise<void> => {
    await persistChanges(access, { closeAfter: true });
  };

  const handleCopyLink = async (): Promise<void> => {
    setIsCopying(true);
    // Persist any pending non-private access change first so the recipient's
    // link matches what's shown in the dialog. Private stays private — the
    // user is explicitly copying a private URL and we don't silently promote.
    if (access !== "private" && access !== currentVisibility) {
      const result = await persistChanges(access, {
        closeAfter: false,
        quiet: true,
      });
      if (!result) {
        setIsCopying(false);
        return;
      }
    }
    await navigator.clipboard.writeText(window.location.href);
    setIsCopying(false);
    setCopied(true);
    toast.success("Link copied to clipboard");
    setTimeout(() => setCopied(false), 2000);
  };

  if (isSubmitting) {
    return (
      <Overlay overlayId={overlayId} title={`${title}...`}>
        <div className="flex items-center justify-center py-8">
          <Spinner />
        </div>
      </Overlay>
    );
  }

  return (
    <Overlay
      actions={[
        {
          label: isCopying ? "Copying..." : copied ? "Copied" : "Copy link",
          variant: "ghost" as const,
          onClick: () => {
            void handleCopyLink();
          },
          disabled: isCopying,
        },
        {
          label: "Done",
          variant: "outline" as const,
          onClick: () => {
            void handleDone();
          },
          disabled: !name.trim() || isCopying,
        },
      ]}
      overlayId={overlayId}
      title={title}
    >
      <div className="space-y-6">
        <div className="space-y-2">
          <Label htmlFor="workflow-name">Workflow Name</Label>
          <Input
            id="workflow-name"
            onChange={(e) => setName(e.target.value)}
            placeholder="Enter workflow name..."
            value={name}
          />
          {name.toLowerCase().startsWith("untitled") && (
            <div className="flex items-start gap-2 rounded-md border border-yellow-200 bg-yellow-50 p-2 text-xs text-yellow-800 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-200">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>Give your workflow a descriptive name.</span>
            </div>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="general-access">General access</Label>
          <div className="flex items-center gap-3">
            <AccessIcon visibility={access} />
            <Select
              onValueChange={(v) => setAccess(v as WorkflowVisibility)}
              value={access}
            >
              <SelectTrigger id="general-access">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="private">Private</SelectItem>
                <SelectItem value="unlisted">Anyone with the link</SelectItem>
                <SelectItem value="public">Public (on the Hub)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {access === "public" && (
          <div className="space-y-2">
            <Label>Tags</Label>
            <p className="text-muted-foreground text-sm">
              Choose tags to make your workflow discoverable on the Hub.
            </p>
            <PublicTagSelector
              initialTags={initialTags}
              onTagsChange={setSelectedTags}
              orgTagNames={orgTagNames}
              selectedTags={selectedTags}
            />
          </div>
        )}

        {access === "unlisted" && (
          <div className="flex items-start gap-2.5 rounded-md border border-border/40 bg-muted/30 px-3 py-2.5">
            <Link2 className="mt-[3px] size-4 shrink-0 text-muted-foreground" />
            <div className="space-y-1 text-muted-foreground text-sm">
              <p>
                Anyone with the link can open this workflow and view its full
                configuration, including any potentially sensitive values in
                node fields. Your credentials and logs remain private.
              </p>
              <p>The workflow will not appear on the Hub.</p>
            </div>
          </div>
        )}

        {access === "public" && (
          <div className="flex items-start gap-2.5 rounded-md border border-border/40 bg-muted/30 px-3 py-2.5">
            <Globe className="mt-[3px] size-4 shrink-0 text-muted-foreground" />
            <div className="space-y-1 text-muted-foreground text-sm">
              <p>
                Shared workflows are visible on the{" "}
                <a
                  className="underline underline-offset-2 hover:text-foreground"
                  href="/hub"
                  rel="noopener"
                  target="_blank"
                >
                  Hub
                </a>
                . Others can view the structure and duplicate it. Your
                credentials and logs remain private.
              </p>
              <p>Workflow link will be accessible to others once shared.</p>
            </div>
          </div>
        )}
      </div>
    </Overlay>
  );
}

function AccessIcon({
  visibility,
}: {
  visibility: WorkflowVisibility;
}): React.JSX.Element {
  const wrapper =
    "flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground";
  if (visibility === "public") {
    return (
      <div className={wrapper}>
        <Globe className="size-4" />
      </div>
    );
  }
  if (visibility === "unlisted") {
    return (
      <div className={wrapper}>
        <Link2 className="size-4" />
      </div>
    );
  }
  return (
    <div className={wrapper}>
      <Lock className="size-4" />
    </div>
  );
}
