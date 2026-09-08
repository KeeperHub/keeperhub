"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ENFORCEMENT_LEVEL_LABELS,
  ENFORCEMENT_LEVEL_TOOLTIPS,
  type EnforcementLevel,
  type ProtocolCatalogEntry,
} from "@/lib/safe/protocol-registry";
import {
  type PolicyProtocolCardAction,
  PolicyProtocolCardActions,
} from "./policy-protocol-card-actions";
import { PolicyProtocolCardView } from "./policy-protocol-card-view";
import { PolicyProtocolTargets } from "./policy-protocol-targets";
import type { TokenRowValue } from "./policy-token-row";
import { ProtocolTokenAllowances } from "./protocol-token-allowances";

type TargetLink = {
  address: string;
  explorerUrl: string | null;
};

type PolicyProtocolCardProps = {
  catalog: ProtocolCatalogEntry;
  chainId: number;
  enabled: boolean;
  tokens: TokenRowValue[];
  targets: readonly TargetLink[];
  onEnabledChange: (next: boolean) => void;
  onTokensChange: (next: TokenRowValue[]) => void;
  mode?: "install" | "edit";
  alreadyApplied?: boolean;
};

function EnforcementBadge({
  level,
}: {
  level: EnforcementLevel;
}): React.ReactElement {
  const variant = level === "per-parameter" ? "default" : "secondary";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge className="text-[10px]" variant={variant}>
          {ENFORCEMENT_LEVEL_LABELS[level]}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-xs">
        {ENFORCEMENT_LEVEL_TOOLTIPS[level]}
      </TooltipContent>
    </Tooltip>
  );
}

function computeCardBorderClass(options: {
  showPendingRemoval: boolean;
  enabled: boolean;
}): string {
  if (options.showPendingRemoval) {
    return "border-destructive/40 bg-destructive/5";
  }
  if (options.enabled) {
    return "border-primary/40 bg-primary/5";
  }
  return "";
}

function computeCardAction(options: {
  isEditMode: boolean;
  showAddNew: boolean;
  showPendingRemoval: boolean;
  showActive: boolean;
  editingInputs: boolean;
}): PolicyProtocolCardAction {
  if (!options.isEditMode) {
    return "none";
  }
  if (options.showAddNew) {
    return "add";
  }
  if (options.showPendingRemoval) {
    return "undo";
  }
  if (options.showActive && !options.editingInputs) {
    return "edit";
  }
  return "remove";
}

function StateBadges({
  showActive,
  showPendingRemoval,
  showNewlyAdded,
}: {
  showActive: boolean;
  showPendingRemoval: boolean;
  showNewlyAdded: boolean;
}): React.ReactElement | null {
  if (showActive) {
    return (
      <Badge
        className="border-emerald-500/40 bg-emerald-500/10 text-[10px] text-emerald-600 dark:text-emerald-400"
        variant="outline"
      >
        Active
      </Badge>
    );
  }
  if (showPendingRemoval) {
    return (
      <Badge className="text-[10px]" variant="destructive">
        Pending removal
      </Badge>
    );
  }
  if (showNewlyAdded) {
    return (
      <Badge className="border-primary/40 text-[10px]" variant="outline">
        New
      </Badge>
    );
  }
  return null;
}

export function PolicyProtocolCard({
  catalog,
  chainId,
  enabled,
  tokens,
  targets,
  onEnabledChange,
  onTokensChange,
  mode = "install",
  alreadyApplied = false,
}: PolicyProtocolCardProps): React.ReactElement {
  const [expanded, setExpanded] = useState<boolean>(enabled);
  const [editingInputs, setEditingInputs] = useState<boolean>(false);

  useEffect(() => {
    if (enabled) {
      setExpanded(true);
    }
  }, [enabled]);

  useEffect(() => {
    if (mode === "edit" && !alreadyApplied && enabled) {
      setEditingInputs(true);
      return;
    }
    setEditingInputs(false);
  }, [mode, alreadyApplied, enabled]);

  const isEditMode = mode === "edit";
  const showActive = isEditMode && alreadyApplied && enabled;
  const showPendingRemoval = isEditMode && alreadyApplied && !enabled;
  const showNewlyAdded = isEditMode && !alreadyApplied && enabled;
  const showAddNew = isEditMode && !alreadyApplied && !enabled;

  const cardBorderClass = computeCardBorderClass({
    showPendingRemoval,
    enabled,
  });
  const action = computeCardAction({
    isEditMode,
    showAddNew,
    showPendingRemoval,
    showActive,
    editingInputs,
  });

  const handleAction = (): void => {
    if (action === "add" || action === "undo") {
      onEnabledChange(true);
      return;
    }
    if (action === "remove") {
      onEnabledChange(false);
      return;
    }
    if (action === "edit") {
      setEditingInputs(true);
    }
  };

  const showViewBody = showActive && !editingInputs;
  const showInputBody = enabled && !showViewBody && !showPendingRemoval;
  const showPreviewBody = !(showViewBody || showInputBody);

  return (
    <li className={`rounded border p-3 text-sm ${cardBorderClass}`}>
      <div className="flex items-center gap-2">
        {!isEditMode && (
          <input
            checked={enabled}
            id={`pw-protocol-${catalog.slug}`}
            onChange={(e) => onEnabledChange(e.target.checked)}
            type="checkbox"
          />
        )}
        <label
          className={
            isEditMode
              ? "flex min-w-0 flex-1 flex-wrap items-center gap-2"
              : "flex min-w-0 flex-1 cursor-pointer flex-wrap items-center gap-2"
          }
          htmlFor={`pw-protocol-${catalog.slug}`}
        >
          <span className="font-medium">{catalog.label}</span>
          <EnforcementBadge level={catalog.enforcementLevel} />
          <StateBadges
            showActive={showActive}
            showNewlyAdded={showNewlyAdded}
            showPendingRemoval={showPendingRemoval}
          />
        </label>
        <PolicyProtocolCardActions
          action={action}
          docsUrl={catalog.docsUrl}
          expanded={expanded}
          onAction={handleAction}
          onToggleExpanded={() => setExpanded((v) => !v)}
        />
      </div>
      <div className="mt-1 text-muted-foreground text-xs">
        {catalog.description}
      </div>

      {expanded && showViewBody && (
        <div className="mt-3">
          <PolicyProtocolCardView
            chainId={chainId}
            targets={targets}
            tokens={tokens}
          />
        </div>
      )}

      {expanded && showInputBody && (
        <div className="mt-3 space-y-3">
          <ProtocolTokenAllowances
            chainId={chainId}
            onChange={onTokensChange}
            tokens={tokens}
          />
          <PolicyProtocolTargets chainId={chainId} targets={targets} />
        </div>
      )}

      {expanded && showPreviewBody && (
        <div className="mt-3 space-y-2">
          <PolicyProtocolTargets chainId={chainId} targets={targets} />
          {showAddNew && (
            <div className="text-muted-foreground text-xs">
              Click Add to enable this protocol and configure token caps.
            </div>
          )}
          {showPendingRemoval && (
            <div className="text-muted-foreground text-xs">
              This protocol will be removed when you confirm. Click Undo to keep
              it.
            </div>
          )}
        </div>
      )}
    </li>
  );
}
