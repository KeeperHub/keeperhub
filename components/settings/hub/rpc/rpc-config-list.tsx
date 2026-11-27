"use client";

import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  MoreHorizontal,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { WARNING_TEXT } from "@/components/ui/notice";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { OrgRpcConfigView } from "@/lib/rpc/engine/org/service";
import type {
  RpcConfigUrlSlot,
  RpcUrlCheck,
} from "@/lib/rpc/engine/org/url-slots";
import { cn } from "@/lib/utils";
import { timeAgo } from "../relative-time";
import { ChainOwnRpcOnly } from "./chain-own-rpc-only";
import { ChainBadges } from "./chain-picker";
import {
  chainGroupHealth,
  filledSlots,
  type RpcChainGroup,
  SLOT_LABEL,
  SLOT_SHORT_LABEL,
  SUBTLE_BADGE_CLASS,
  YOUR_ENDPOINTS_ONLY,
} from "./model";

export type RpcConfigActions = {
  onToggleEnabled: (config: OrgRpcConfigView, enabled: boolean) => void;
  onMakeDefault: (config: OrgRpcConfigView) => void;
  onTest: (config: OrgRpcConfigView) => void;
  onEdit: (config: OrgRpcConfigView) => void;
  onDelete: (config: OrgRpcConfigView) => void;
  onSetOwnRpcOnly: (chainId: number, ownRpcOnly: boolean) => Promise<void>;
};

const UNREADABLE_NOTE =
  "Its saved URLs can no longer be read. Edit it and paste them again.";

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function checkText(check: RpcUrlCheck | undefined): string {
  if (!check) {
    return "Not checked yet";
  }
  const checked = `checked ${timeAgo(check.checkedAt)}`;
  return check.ok
    ? `Answered for this chain, ${checked}`
    : `${check.error ?? "Did not pass the check."} (${checked})`;
}

function SlotChip({
  slot,
  check,
}: {
  slot: RpcConfigUrlSlot;
  check: RpcUrlCheck | undefined;
}): React.ReactElement {
  let icon = (
    <CircleDashed aria-hidden="true" className="size-3 text-muted-foreground" />
  );
  if (check?.ok) {
    icon = (
      <CheckCircle2
        aria-hidden="true"
        className="size-3 text-keeperhub-green"
      />
    );
  } else if (check) {
    icon = <XCircle aria-hidden="true" className="size-3 text-destructive" />;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs",
            SUBTLE_BADGE_CLASS,
            check && !check.ok && "text-destructive"
          )}
          data-slot-name={slot}
        >
          {icon}
          {SLOT_SHORT_LABEL[slot]}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        {SLOT_LABEL[slot]}: {checkText(check)}
      </TooltipContent>
    </Tooltip>
  );
}

function ConfigActionsMenu({
  config,
  busy,
  actions,
}: {
  config: OrgRpcConfigView;
  busy: boolean;
  actions: RpcConfigActions;
}): React.ReactElement {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={`Actions for ${config.name}`}
          className="size-7"
          disabled={busy}
          size="icon-sm"
          variant="ghost"
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => actions.onEdit(config)}>
          Edit
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => actions.onTest(config)}>
          Test connection
        </DropdownMenuItem>
        {!config.isDefault && (
          <DropdownMenuItem onSelect={() => actions.onMakeDefault(config)}>
            Make default
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          onSelect={() => actions.onDelete(config)}
        >
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ConfigLine({
  config,
  canManage,
  busy,
  actions,
}: {
  config: OrgRpcConfigView;
  canManage: boolean;
  busy: boolean;
  actions: RpcConfigActions;
}): React.ReactElement {
  return (
    <li
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5",
        !config.enabled && "bg-muted/30"
      )}
      data-testid="rpc-config-row"
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        <span className="font-medium text-sm">{config.name}</span>
        {config.isDefault && (
          <Badge
            className={cn(SUBTLE_BADGE_CLASS, "text-foreground")}
            variant="outline"
          >
            Default
          </Badge>
        )}
        {!config.enabled && <Badge variant="outline">Disabled</Badge>}
        {config.unreadable ? (
          <span className="text-destructive text-xs">{UNREADABLE_NOTE}</span>
        ) : (
          <span className="flex flex-wrap items-center gap-1">
            {filledSlots(config).map((slot) => (
              <SlotChip
                check={config.verification[slot]}
                key={slot}
                slot={slot}
              />
            ))}
          </span>
        )}
      </div>
      {canManage && (
        <div className="flex items-center gap-1">
          {busy && (
            <span className="text-muted-foreground text-xs">Working...</span>
          )}
          <Switch
            aria-label={`Enable ${config.name}`}
            checked={config.enabled}
            disabled={busy}
            onCheckedChange={(next) => actions.onToggleEnabled(config, next)}
          />
          <ConfigActionsMenu actions={actions} busy={busy} config={config} />
        </div>
      )}
    </li>
  );
}

function HealthSummary({ group }: { group: RpcChainGroup }): React.ReactNode {
  const health = chainGroupHealth(group);
  if (health.failedChecks > 0) {
    return (
      <span className="inline-flex items-center gap-1 text-destructive text-xs">
        <XCircle aria-hidden="true" className="size-3.5" />
        {plural(health.failedChecks, "failed check")}
      </span>
    );
  }
  if (health.gaps > 0) {
    return (
      <span
        className={cn("inline-flex items-center gap-1 text-xs", WARNING_TEXT)}
      >
        <AlertTriangle aria-hidden="true" className="size-3.5" />
        {plural(health.gaps, "node")} without an endpoint
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-muted-foreground text-xs">
      <CheckCircle2
        aria-hidden="true"
        className="size-3.5 text-keeperhub-green"
      />
      Healthy
    </span>
  );
}

function ChainRow({
  group,
  canManage,
  busyId,
  actions,
  chainName,
}: {
  group: RpcChainGroup;
  canManage: boolean;
  busyId: string | null;
  actions: RpcConfigActions;
  chainName: (chainId: number) => string;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const defaultConfig = group.configs.find((config) => config.isDefault);
  return (
    <Collapsible
      className="rounded-lg border"
      data-testid="rpc-chain-row"
      onOpenChange={setOpen}
      open={open}
    >
      <CollapsibleTrigger asChild>
        <button
          className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-3 py-2.5 text-left hover:bg-muted/40"
          type="button"
        >
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90"
            )}
          />
          <span className="font-semibold text-sm">{group.name}</span>
          <ChainBadges
            chain={{ chainId: group.chainId, chainType: group.chainType }}
          />
          {group.ownRpcOnly && (
            <Badge
              className={cn(SUBTLE_BADGE_CLASS, "text-foreground")}
              variant="outline"
            >
              {YOUR_ENDPOINTS_ONLY}
            </Badge>
          )}
          <span className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-muted-foreground text-xs">
              {defaultConfig ? `Default: ${defaultConfig.name}` : "No default"}
              {" · "}
              {plural(group.configs.length, "endpoint")}
            </span>
            <HealthSummary group={group} />
          </span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-3 border-t p-3">
        <ChainOwnRpcOnly
          canManage={canManage}
          chainName={chainName}
          group={group}
          onChange={actions.onSetOwnRpcOnly}
        />
        {group.configs.length === 0 ? (
          <p className="text-muted-foreground text-xs">
            No endpoints on this chain. Add one, or turn off{" "}
            {YOUR_ENDPOINTS_ONLY.toLowerCase()}.
          </p>
        ) : (
          <ul className="divide-y rounded-md border">
            {group.configs.map((config) => (
              <ConfigLine
                actions={actions}
                busy={busyId === config.id}
                canManage={canManage}
                config={config}
                key={config.id}
              />
            ))}
          </ul>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function RpcConfigList({
  groups,
  canManage,
  busyId,
  actions,
  chainName,
}: {
  groups: readonly RpcChainGroup[];
  canManage: boolean;
  busyId: string | null;
  actions: RpcConfigActions;
  chainName: (chainId: number) => string;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-2">
      {groups.map((group) => (
        <ChainRow
          actions={actions}
          busyId={busyId}
          canManage={canManage}
          chainName={chainName}
          group={group}
          key={group.chainId}
        />
      ))}
    </div>
  );
}
