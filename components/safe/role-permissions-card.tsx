"use client";

import {
  ChevronDown,
  ChevronRight,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { AddressWithExplorer } from "@/components/safe/address-with-explorer";
import { RoleAllowanceEditDialog } from "@/components/safe/role-allowance-edit-dialog";
import { RoleDirectRuleEditDialog } from "@/components/safe/role-direct-rule-edit-dialog";
import {
  type RoleDirectRule,
  RoleDirectRuleRow,
} from "@/components/safe/role-direct-rule-row";
import { RoleEditDialog } from "@/components/safe/role-edit-dialog";
import { RoleInstallDialog } from "@/components/safe/role-install-dialog";
import { RoleProtocolGroup } from "@/components/safe/role-protocol-group";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

type RoleSummary = {
  installed: boolean;
  role: null | {
    id: string;
    safeWalletId: string;
    roleKey: string;
    rolesModifierAddress: string;
    delegateAddress: string;
    status: string;
  };
  protocols: Array<{
    id: string;
    protocolSlug: string;
    templateSlug: string;
    allowedTokenSymbols: string[];
    status: string;
  }>;
  allowances: Array<{
    id: string;
    protocolSlug: string;
    tokenAddress: string;
    tokenSymbol: string;
    tokenDecimals: number;
    maxRefillWei: string;
    refillWei: string;
    periodSeconds: number;
    lastChainBalanceWei: string | null;
  }>;
  directRules?: Array<{
    id: string;
    kind: string;
    tokenAddress: string | null;
    tokenSymbol: string;
    tokenDecimals: number;
    counterparty: string;
    amountHuman: string;
    periodSeconds: number;
    status: string;
  }>;
};

type Props = {
  safeId: string;
  chainId: number;
  isAdmin: boolean;
  /**
   * Strict subset of `isAdmin` for destructive controls. Admins can view +
   * edit policies; only owners can revoke an on-chain allowance bucket.
   * The UI uses this to disable + tooltip the Revoke action for admins
   * (members never see the button regardless).
   */
  isOwner: boolean;
  safeAddress?: string;
  safeUrl?: string | null;
  /**
   * Drop the outer card wrapper + "On-chain policies" header when the parent
   * surface already announces the Safe (e.g. the account-detail overlay
   * titled "Safe -- Ethereum"). The Refresh-from-chain action moves to the
   * top of the inner content so admin actions are still reachable.
   */
  bare?: boolean;
};

type SupportedTokensResponse = {
  tokens?: Array<{
    tokenAddress: string;
    symbol?: string;
    logoUrl?: string | null;
    available?: boolean;
  }>;
};

async function fetchTokenLogoMap(
  chainId: number
): Promise<Record<string, string>> {
  const res = await fetch(`/api/supported-tokens?chainId=${chainId}`, {
    credentials: "include",
  });
  if (!res.ok) {
    return {};
  }
  const data = (await res.json()) as SupportedTokensResponse;
  const map: Record<string, string> = {};
  for (const t of data.tokens ?? []) {
    if (!t.logoUrl) {
      continue;
    }
    map[t.tokenAddress.toLowerCase()] = t.logoUrl;
    if (t.symbol) {
      map[`sym:${t.symbol.toLowerCase()}`] = t.logoUrl;
    }
  }
  return map;
}

function resolveDirectRuleLogo(
  rule: { tokenAddress: string | null; tokenSymbol: string },
  tokenLogoMap: Record<string, string>
): string | null {
  const tokenAddrLower = rule.tokenAddress?.toLowerCase();
  if (tokenAddrLower && tokenLogoMap[tokenAddrLower]) {
    return tokenLogoMap[tokenAddrLower];
  }
  return tokenLogoMap[`sym:${rule.tokenSymbol.toLowerCase()}`] ?? null;
}

const NATIVE_TOKEN_SENTINEL = "0x0000000000000000000000000000000000000000";

function findDirectAllowance<
  A extends { protocolSlug: string; tokenAddress: string },
>(
  rule: { kind: string; tokenAddress: string | null },
  allowances: A[]
): A | null {
  const tokenAddrLower =
    rule.tokenAddress?.toLowerCase() ??
    (rule.kind === "native-transfer" ? NATIVE_TOKEN_SENTINEL : null);
  if (!tokenAddrLower) {
    return null;
  }
  return (
    allowances.find(
      (a) =>
        a.protocolSlug === "direct" &&
        a.tokenAddress.toLowerCase() === tokenAddrLower
    ) ?? null
  );
}

function CardWrapper({
  bare,
  children,
}: {
  bare: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  return bare ? (
    <div>{children}</div>
  ) : (
    <div className="rounded-lg border bg-card p-4">{children}</div>
  );
}

export function RolePermissionsCard({
  safeId,
  chainId,
  isAdmin,
  isOwner,
  safeAddress,
  safeUrl,
  bare = false,
}: Props): React.ReactElement | null {
  const [loading, setLoading] = useState<boolean>(true);
  const [role, setRole] = useState<RoleSummary | null>(null);
  const [installing, setInstalling] = useState<boolean>(false);
  const [editing, setEditing] = useState<boolean>(false);
  const [syncing, setSyncing] = useState<boolean>(false);
  const [showDetails, setShowDetails] = useState<boolean>(false);
  const [protocolsOpen, setProtocolsOpen] = useState<boolean>(true);
  const [directRulesOpen, setDirectRulesOpen] = useState<boolean>(true);
  const [tokenLogoMap, setTokenLogoMap] = useState<Record<string, string>>({});
  const [editingDirectRule, setEditingDirectRule] =
    useState<RoleDirectRule | null>(null);
  // Per-allowance edit modal target. Each protocol allowance bucket is its
  // own policy; clicking the row's pencil sets this and we render the
  // dedicated edit dialog scoped to that single bucket.
  const [editingAllowanceId, setEditingAllowanceId] = useState<string | null>(
    null
  );

  useEffect(() => {
    fetchTokenLogoMap(chainId).then(setTokenLogoMap, () => {
      setTokenLogoMap({});
    });
  }, [chainId]);

  const loadRole = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/user/safe/${safeId}/role`);
      if (!res.ok) {
        toast.error("Failed to load role state");
        return;
      }
      const data = (await res.json()) as RoleSummary;
      setRole(data);
    } catch {
      toast.error("Failed to load role state");
    } finally {
      setLoading(false);
    }
  }, [safeId]);

  const syncFromChain = useCallback(async (): Promise<void> => {
    setSyncing(true);
    try {
      const res = await fetch(`/api/user/safe/${safeId}/role/reconcile`, {
        method: "POST",
      });
      const data = (await res.json()) as {
        installed?: boolean;
        addedAllowances?: number;
        updatedAllowances?: number;
        staleAllowances?: number;
        error?: string;
      };
      if (!res.ok) {
        toast.error(data.error ?? "Sync failed");
        return;
      }
      if (data.installed === false) {
        toast.warning(
          "No Zodiac Roles modifier is enabled on this Safe on chain."
        );
      } else {
        const added = data.addedAllowances ?? 0;
        const updated = data.updatedAllowances ?? 0;
        const stale = data.staleAllowances ?? 0;
        if (added + updated + stale === 0) {
          toast.success("Already in sync with on-chain state");
        } else {
          toast.success(
            `Synced from chain: ${added} added, ${updated} updated, ${stale} cleared`
          );
        }
      }
      await loadRole();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }, [safeId, loadRole]);

  useEffect(() => {
    loadRole().catch(() => {
      // toast already fired
    });
  }, [loadRole]);

  if (!(isAdmin || role?.installed)) {
    return null;
  }

  const enabledProtocols =
    role?.protocols.filter(
      (p) => p.status === "allowed" && p.protocolSlug !== "direct"
    ) ?? [];
  const directRules = role?.directRules ?? [];
  const editingAllowance = editingAllowanceId
    ? (role?.allowances.find((a) => a.id === editingAllowanceId) ?? null)
    : null;

  const headerBar = (
    <div className="mb-3 flex items-center gap-2">
      {!bare && (
        <>
          <ShieldCheck className="h-4 w-4 text-muted-foreground" />
          <h3 className="font-medium text-sm">On-chain policies</h3>
        </>
      )}
      {role?.installed && isAdmin && (
        <Button
          className="ml-auto h-7 gap-1 px-2 text-xs"
          disabled={syncing}
          onClick={() => {
            syncFromChain().catch(() => {
              // toast already fired
            });
          }}
          size="sm"
          type="button"
          variant="ghost"
        >
          {syncing ? (
            <Spinner className="h-3 w-3" />
          ) : (
            <RefreshCw className="h-3 w-3" />
          )}
          Refresh from chain
        </Button>
      )}
    </div>
  );

  const blurb = !bare && (
    <p className="mb-4 text-muted-foreground text-xs">
      Workflow transactions on this Safe can only execute the policies below.
      Anything else reverts on chain. Owner calls via safe.global bypass these
      rules.
    </p>
  );

  return (
    <CardWrapper bare={bare}>
      {headerBar}
      {blurb}

      {loading && (
        <div className="flex items-center justify-center py-4">
          <Spinner />
        </div>
      )}

      {!loading && role && !role.installed && isAdmin && (
        <RoleInstallDialog
          chainId={chainId}
          installing={installing}
          onInstalled={loadRole}
          safeAddress={safeAddress}
          safeId={safeId}
          setInstalling={setInstalling}
        />
      )}

      {!loading && role?.installed && (
        <div className="space-y-4">
          <section className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <button
                aria-expanded={protocolsOpen}
                className="flex flex-1 cursor-pointer items-center gap-2 rounded px-1 py-1 text-left font-medium text-sm hover:bg-muted/40"
                onClick={() => setProtocolsOpen((v) => !v)}
                type="button"
              >
                {protocolsOpen ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronRight className="h-3 w-3" />
                )}
                Active protocols
                <span className="text-muted-foreground text-xs">
                  ({enabledProtocols.length})
                </span>
              </button>
              {isAdmin && (
                <RoleEditDialog
                  chainId={chainId}
                  editing={editing}
                  onUpdated={loadRole}
                  role={role}
                  safeAddress={safeAddress}
                  safeId={safeId}
                  setEditing={setEditing}
                />
              )}
            </div>
            {protocolsOpen && (
              <div className="space-y-2">
                {enabledProtocols.length > 0 ? (
                  enabledProtocols.map((protocol) => (
                    <RoleProtocolGroup
                      allowances={role.allowances.filter(
                        (a) => a.protocolSlug === protocol.protocolSlug
                      )}
                      isAdmin={isAdmin}
                      isOwner={isOwner}
                      key={protocol.id}
                      onAllowanceRevoked={loadRole}
                      onEditAllowance={
                        isAdmin ? setEditingAllowanceId : undefined
                      }
                      protocolSlug={protocol.protocolSlug}
                      safeId={safeId}
                    />
                  ))
                ) : (
                  <div className="rounded border bg-muted/10 p-3 text-muted-foreground text-xs">
                    No protocols are enabled yet. Click Manage policies to scope
                    this Safe to specific protocols and tokens.
                  </div>
                )}
              </div>
            )}
          </section>

          {directRules.length > 0 && (
            <section className="space-y-2">
              <button
                aria-expanded={directRulesOpen}
                className="flex w-full cursor-pointer items-center gap-2 rounded px-1 py-1 text-left font-medium text-sm hover:bg-muted/40"
                onClick={() => setDirectRulesOpen((v) => !v)}
                type="button"
              >
                {directRulesOpen ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronRight className="h-3 w-3" />
                )}
                Direct rules
                <span className="text-muted-foreground text-xs">
                  ({directRules.length})
                </span>
              </button>
              {directRulesOpen && (
                <div className="space-y-2">
                  <div className="text-muted-foreground text-xs">
                    Per-recipient transfers, approvals, and native sends not
                    bound to a protocol preset.
                  </div>
                  <ul className="space-y-1.5">
                    {directRules.map((rule) => (
                      <RoleDirectRuleRow
                        allowance={findDirectAllowance(rule, role.allowances)}
                        chainId={chainId}
                        key={rule.id}
                        onEdit={
                          isAdmin ? () => setEditingDirectRule(rule) : undefined
                        }
                        rule={rule}
                        tokenLogoUrl={resolveDirectRuleLogo(rule, tokenLogoMap)}
                      />
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}

          {editingDirectRule && (
            <RoleDirectRuleEditDialog
              allDirectRules={role.directRules ?? []}
              allowances={role.allowances}
              onOpenChange={(o) => {
                if (!o) {
                  setEditingDirectRule(null);
                }
              }}
              onUpdated={async () => {
                await loadRole();
              }}
              open={true}
              protocols={role.protocols}
              rule={editingDirectRule}
              safeId={safeId}
            />
          )}

          {editingAllowance && (
            <RoleAllowanceEditDialog
              allAllowances={role.allowances}
              allowance={editingAllowance}
              directRules={role.directRules ?? []}
              onOpenChange={(o) => {
                if (!o) {
                  setEditingAllowanceId(null);
                }
              }}
              onUpdated={async () => {
                await loadRole();
              }}
              open={true}
              protocols={role.protocols}
              safeId={safeId}
            />
          )}

          <details
            className="rounded border bg-muted/10 px-3 py-2 text-xs"
            onToggle={(e) => setShowDetails(e.currentTarget.open)}
            open={showDetails}
          >
            <summary className="flex cursor-pointer items-center gap-1 text-muted-foreground hover:text-foreground">
              {showDetails ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              Technical details
            </summary>
            <div className="mt-2 space-y-1 pl-4">
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">Roles modifier</span>
                {role.role && (
                  <AddressWithExplorer
                    address={role.role.rolesModifierAddress}
                    chainId={chainId}
                  />
                )}
              </div>
              {role.role && (
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">Delegate EOA</span>
                  <AddressWithExplorer
                    address={role.role.delegateAddress}
                    chainId={chainId}
                  />
                </div>
              )}
              {safeUrl && (
                <a
                  className="inline-block text-muted-foreground underline hover:text-foreground"
                  href={safeUrl}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  View Safe on safe.global
                </a>
              )}
            </div>
          </details>
        </div>
      )}
    </CardWrapper>
  );
}
