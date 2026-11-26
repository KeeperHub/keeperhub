"use client";

import { Plus } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Notice } from "@/components/ui/notice";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { CoverageGap } from "@/lib/rpc/engine/org/coverage";
import type { OrgRpcConfigView } from "@/lib/rpc/engine/org/service";
import { ConfirmDeleteDialog } from "./confirm-delete-dialog";
import { useRpcEndpoints } from "./hooks/use-rpc-endpoints";
import {
  AutoFallbackChange,
  AutoFallbackConfirm,
  type AutoFallbackPrompt,
} from "./rpc/auto-fallback-confirm";
import { RpcHowItWorks } from "./rpc/how-it-works";
import {
  filterChainGroups,
  groupConfigsByChain,
  isCoverageRefusal,
  RPC_CHAIN_FILTER_LABEL,
  RpcChainFilter,
  YOUR_ENDPOINTS_ONLY,
} from "./rpc/model";
import {
  AddRpcConfigDialog,
  CoverageRefusalDialog,
  EditRpcConfigDialog,
} from "./rpc/rpc-config-dialogs";
import { type RpcConfigActions, RpcConfigList } from "./rpc/rpc-config-list";
import { EmptyState, SectionHeader, SettingsCard } from "./section";
import { useSettingsContext } from "./settings-context";
import { RowsSkeleton } from "./skeletons";

export const CONFIGURED_ENDPOINTS_TITLE = "Configured endpoints";

type Refusal = { message: string; gaps: CoverageGap[] };

export function RpcEndpointsSection(): React.ReactElement {
  // Every member reads these; only owners and admins may change them.
  const { isAdmin, roleLoading } = useSettingsContext();
  const canManage = isAdmin;
  const rpc = useRpcEndpoints();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<OrgRpcConfigView | null>(null);
  const [deleting, setDeleting] = useState<OrgRpcConfigView | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [fallbackPrompt, setFallbackPrompt] = useState<{
    details: AutoFallbackPrompt;
    apply: () => void;
  } | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<RpcChainFilter>(RpcChainFilter.ALL);

  const chains = rpc.data?.chains;
  const configs = rpc.data?.configs;
  const policy = rpc.data?.policy;
  const groups = useMemo(
    () =>
      groupConfigsByChain(
        configs ?? [],
        chains ?? [],
        policy ?? { chains: [] }
      ),
    [configs, chains, policy]
  );
  const ownRpcOnlyOn = useCallback(
    (chainId: number): boolean =>
      groups.some((group) => group.chainId === chainId && group.ownRpcOnly),
    [groups]
  );
  const visibleGroups = useMemo(
    () => filterChainGroups(groups, query, filter),
    [groups, query, filter]
  );
  const chainName = useCallback(
    (chainId: number): string =>
      chains?.find((chain) => chain.chainId === chainId)?.name ??
      `Chain ${chainId}`,
    [chains]
  );

  const report = useCallback((error: unknown, fallback: string): void => {
    if (isCoverageRefusal(error)) {
      setRefusal({ message: error.message, gaps: error.gaps });
      return;
    }
    toast.error(error instanceof Error ? error.message : fallback);
  }, []);

  const runRowAction = useCallback(
    async (
      config: OrgRpcConfigView,
      action: () => Promise<void>,
      fallback: string
    ): Promise<void> => {
      setBusyId(config.id);
      try {
        await action();
      } catch (error) {
        report(error, fallback);
      } finally {
        setBusyId(null);
      }
    },
    [report]
  );

  const { update, test, setOwnRpcOnly } = rpc;
  const actions = useMemo<RpcConfigActions>(
    () => ({
      onToggleEnabled: (config, enabled) => {
        const apply = (): void => {
          runRowAction(
            config,
            async () => {
              await update(config.id, { enabled });
              toast.success(
                `${enabled ? "Enabled" : "Disabled"} ${config.name}`
              );
            },
            "Could not change the endpoint."
          );
        };
        if (enabled || !config.isDefault) {
          apply();
          return;
        }
        setFallbackPrompt({
          details: {
            change: AutoFallbackChange.DISABLE_DEFAULT,
            configName: config.name,
            chainName: chainName(config.chainId),
            ownRpcOnly: ownRpcOnlyOn(config.chainId),
          },
          apply,
        });
      },
      onMakeDefault: (config) => {
        runRowAction(
          config,
          async () => {
            await update(config.id, { isDefault: true });
            toast.success(`${config.name} is now the default`);
          },
          "Could not change the default."
        );
      },
      onTest: (config) => {
        runRowAction(
          config,
          async () => {
            const allOk = await test(config.id);
            if (allOk) {
              toast.success(`Every URL in ${config.name} answered`);
            } else {
              toast.error(`Some URLs in ${config.name} did not pass the check`);
            }
          },
          "Could not test the endpoint."
        );
      },
      onEdit: setEditing,
      onDelete: setDeleting,
      onSetOwnRpcOnly: async (chainId, ownRpcOnly) => {
        try {
          await setOwnRpcOnly(chainId, ownRpcOnly);
          toast.success(
            `${YOUR_ENDPOINTS_ONLY} is ${ownRpcOnly ? "on" : "off"} for ${chainName(chainId)}`
          );
        } catch (error) {
          report(
            error,
            `Could not change ${YOUR_ENDPOINTS_ONLY.toLowerCase()}.`
          );
        }
      },
    }),
    [runRowAction, update, test, setOwnRpcOnly, chainName, report, ownRpcOnlyOn]
  );

  const editingChainType =
    groups.find((group) => group.chainId === editing?.chainId)?.chainType ??
    null;

  return (
    <>
      <SectionHeader
        action={
          canManage && (
            <Button disabled={!rpc.data} onClick={() => setAdding(true)}>
              <Plus className="size-4" />
              Add endpoint
            </Button>
          )
        }
        description="Use your own RPC providers instead of KeeperHub's, chain by chain."
        title="RPC endpoints"
      />

      <RpcHowItWorks />

      {!(canManage || roleLoading) && (
        <Notice role="status" tone="info">
          You can view these endpoints. Only owners and admins can change them.
        </Notice>
      )}

      {rpc.failed && !rpc.data && (
        <Notice role="alert" tone="danger">
          <div className="flex flex-wrap items-center gap-3">
            <span>Could not load RPC endpoints.</span>
            <Button
              onClick={() => {
                rpc.refetch().catch(() => undefined);
              }}
              size="sm"
              variant="outline"
            >
              Try again
            </Button>
          </div>
        </Notice>
      )}

      <SettingsCard
        action={
          groups.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <Input
                aria-label="Search chains and endpoints"
                className="h-8 w-48"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search chain, ID or endpoint"
                value={query}
              />
              <Select
                onValueChange={(value) => setFilter(value as RpcChainFilter)}
                value={filter}
              >
                <SelectTrigger
                  aria-label="Filter chains"
                  className="w-40"
                  size="sm"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.values(RpcChainFilter).map((value) => (
                    <SelectItem key={value} value={value}>
                      {RPC_CHAIN_FILTER_LABEL[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )
        }
        description="Open a chain to manage its endpoints. Saved URLs are never shown again, not even in part."
        title={CONFIGURED_ENDPOINTS_TITLE}
      >
        {rpc.loading && <RowsSkeleton rows={2} />}
        {rpc.data && groups.length === 0 && (
          <EmptyState>
            No RPC endpoints yet. Workflows use KeeperHub endpoints until you
            add one.
          </EmptyState>
        )}
        {rpc.data && groups.length > 0 && visibleGroups.length === 0 && (
          <EmptyState>No chain matches this search and filter.</EmptyState>
        )}
        {rpc.data && visibleGroups.length > 0 && (
          <RpcConfigList
            actions={actions}
            busyId={busyId}
            canManage={canManage}
            chainName={chainName}
            groups={visibleGroups}
          />
        )}
      </SettingsCard>

      {canManage && (
        <>
          <AddRpcConfigDialog
            chainName={chainName}
            chains={chains ?? []}
            onCreate={async (body) => {
              const config = await rpc.create(body);
              toast.success(`Added ${config.name}`);
            }}
            onOpenChange={setAdding}
            open={adding}
          />
          <EditRpcConfigDialog
            chainName={chainName}
            chainType={editingChainType}
            config={editing}
            onOpenChange={(next) => !next && setEditing(null)}
            onUpdate={async (configId, body) => {
              const config = await rpc.update(configId, body);
              toast.success(`Saved ${config.name}`);
            }}
            ownRpcOnly={editing ? ownRpcOnlyOn(editing.chainId) : false}
          />
          <ConfirmDeleteDialog
            confirmLabel="Delete"
            description="This cannot be undone. If a workflow would be left without an endpoint, the delete is refused and the affected nodes are listed."
            onConfirm={async () => {
              if (!deleting) {
                return;
              }
              try {
                await rpc.remove(deleting.id);
                toast.success(`Deleted ${deleting.name}`);
              } catch (error) {
                report(error, "Could not delete the endpoint.");
              }
            }}
            onOpenChange={(next) => !next && setDeleting(null)}
            open={deleting !== null}
            title={`Delete ${deleting?.name ?? "endpoint"}?`}
          />
          <AutoFallbackConfirm
            onCancel={() => setFallbackPrompt(null)}
            onConfirm={() => {
              fallbackPrompt?.apply();
              setFallbackPrompt(null);
            }}
            prompt={fallbackPrompt?.details ?? null}
          />
          <CoverageRefusalDialog
            chainName={chainName}
            onOpenChange={(next) => !next && setRefusal(null)}
            refusal={refusal}
          />
        </>
      )}
    </>
  );
}
