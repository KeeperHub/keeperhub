"use client";

import { useId, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Notice } from "@/components/ui/notice";
import { Switch } from "@/components/ui/switch";
import { CoverageGapList } from "./coverage-gaps";
import { type RpcChainGroup, YOUR_ENDPOINTS_ONLY } from "./model";

function explanation(chainName: string): string {
  return `Steps and triggers on ${chainName} will use only the endpoints you added. If they fail, the step fails: KeeperHub's endpoints are never used on ${chainName}, not even as a fallback.`;
}

/** The "your endpoints only" switch of one chain, with what blocks or breaks it. */
export function ChainOwnRpcOnly({
  group,
  canManage,
  chainName,
  onChange,
}: {
  group: RpcChainGroup;
  canManage: boolean;
  chainName: (chainId: number) => string;
  /** Resolves once saved; a refusal is reported by the caller. */
  onChange: (chainId: number, ownRpcOnly: boolean) => Promise<void>;
}): React.ReactElement {
  const switchId = useId();
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const blocked = !group.ownRpcOnly && group.gaps.length > 0;

  const save = async (next: boolean): Promise<void> => {
    setSaving(true);
    try {
      await onChange(group.chainId, next);
    } finally {
      setSaving(false);
      setConfirming(false);
    }
  };

  return (
    <div className="flex flex-col gap-2" data-testid="rpc-chain-own-only">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/40 px-3 py-2">
        <div className="flex min-w-0 flex-col">
          <label
            className="font-medium text-sm"
            htmlFor={canManage ? switchId : undefined}
          >
            {YOUR_ENDPOINTS_ONLY}
          </label>
          <span className="text-muted-foreground text-xs">
            {group.ownRpcOnly
              ? "On: KeeperHub's endpoints are never used here. If yours fail, the step fails."
              : "Off: if your endpoints fail or cannot serve a call, KeeperHub's endpoints take over."}
          </span>
        </div>
        {canManage ? (
          <Switch
            aria-label={`${YOUR_ENDPOINTS_ONLY} on ${group.name}`}
            checked={group.ownRpcOnly}
            disabled={saving || blocked}
            id={switchId}
            onCheckedChange={(next) => {
              if (next) {
                setConfirming(true);
              } else {
                save(false).catch(() => undefined);
              }
            }}
          />
        ) : (
          <span className="text-muted-foreground text-xs">
            {group.ownRpcOnly ? "On" : "Off"}
          </span>
        )}
      </div>

      {group.gaps.length > 0 && (
        <Notice tone="warning">
          <div className="flex flex-col gap-2">
            <span>
              {group.ownRpcOnly
                ? `These steps have no endpoint on ${group.name} that can serve them, so they will not run:`
                : "To turn this on, first add an endpoint that can serve each step below:"}
            </span>
            <CoverageGapList chainName={chainName} gaps={group.gaps} />
          </div>
        </Notice>
      )}

      <AlertDialog
        onOpenChange={(next) => !(next || saving) && setConfirming(false)}
        open={confirming}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Use only your endpoints on {group.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {explanation(group.name)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={saving}
              onClick={(event) => {
                event.preventDefault();
                save(true).catch(() => undefined);
              }}
            >
              {saving ? "Turning on..." : "Turn on"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
