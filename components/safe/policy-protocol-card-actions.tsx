"use client";

import {
  ChevronDownIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  PencilIcon,
  RotateCcwIcon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";

export type PolicyProtocolCardAction =
  | "edit"
  | "remove"
  | "undo"
  | "add"
  | "none";

type Props = {
  expanded: boolean;
  onToggleExpanded: () => void;
  action: PolicyProtocolCardAction;
  onAction?: () => void;
  docsUrl?: string;
  hideChevron?: boolean;
};

export function PolicyProtocolCardActions({
  expanded,
  onToggleExpanded,
  action,
  onAction,
  docsUrl,
  hideChevron,
}: Props): React.ReactElement {
  return (
    <div className="flex shrink-0 items-center gap-1">
      {docsUrl && (
        <a
          aria-label="Open protocol documentation"
          className="inline-flex h-9 w-9 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          href={docsUrl}
          onClick={(e) => e.stopPropagation()}
          rel="noopener noreferrer"
          target="_blank"
        >
          <ExternalLinkIcon className="h-4 w-4" />
        </a>
      )}
      {action === "edit" && (
        <Button
          aria-label="Edit this protocol"
          className="text-muted-foreground hover:text-foreground"
          onClick={onAction}
          size="icon"
          type="button"
          variant="ghost"
        >
          <PencilIcon className="h-4 w-4" />
        </Button>
      )}
      {action === "remove" && (
        <Button
          aria-label="Remove this protocol"
          className="text-muted-foreground hover:text-destructive"
          onClick={onAction}
          size="icon"
          type="button"
          variant="ghost"
        >
          <XIcon className="h-4 w-4" />
        </Button>
      )}
      {action === "undo" && (
        <Button
          aria-label="Undo removal"
          className="gap-1 text-xs"
          onClick={onAction}
          size="sm"
          type="button"
          variant="outline"
        >
          <RotateCcwIcon className="h-3 w-3" />
          Undo
        </Button>
      )}
      {action === "add" && (
        <Button
          aria-label="Add this protocol"
          className="text-xs"
          onClick={onAction}
          size="sm"
          type="button"
          variant="outline"
        >
          Add
        </Button>
      )}
      {!hideChevron && (
        <Button
          aria-expanded={expanded}
          aria-label={expanded ? "Hide details" : "Show details"}
          onClick={onToggleExpanded}
          size="icon"
          type="button"
          variant="ghost"
        >
          {expanded ? (
            <ChevronDownIcon className="h-4 w-4" />
          ) : (
            <ChevronRightIcon className="h-4 w-4" />
          )}
        </Button>
      )}
    </div>
  );
}
