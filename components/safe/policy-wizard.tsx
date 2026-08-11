"use client";

import { ethers } from "ethers";
import { AlertTriangleIcon, InfoIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AddressWithExplorer } from "@/components/safe/address-with-explorer";
import { getChainDisplayName } from "@/components/safe/chain-prefixes";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { buildAddressUrl } from "@/lib/build-explorer-url";
import {
  defaultAmountForSymbol,
  resolveDefaultTokensForProtocol,
} from "@/lib/safe/protocol-default-tokens";
import {
  type EnforcementLevel,
  getProtocolLabel,
  listProtocolsForChain,
  type ProtocolCatalogEntry,
  type ProtocolSlug,
} from "@/lib/safe/protocol-registry";
import { getProtocolTargets } from "@/lib/safe/protocol-targets";
import { DirectRulesSection } from "./direct-rules-section";
import { PolicyProtocolCard } from "./policy-protocol-card";
import { POLICY_PERIOD_OPTIONS, type TokenRowValue } from "./policy-token-row";

const DEFAULT_PERIOD_SECONDS = POLICY_PERIOD_OPTIONS[1].seconds;

function buildSeededTokens(
  slug: ProtocolSlug,
  chainId: number,
  explorerInfo: { explorerUrl: string | null; addressPath: string | null }
): TokenRowValue[] {
  const defaults = resolveDefaultTokensForProtocol(slug, chainId);
  return defaults.map((t) => ({
    tokenAddress: t.address,
    tokenSymbol: t.symbol,
    tokenDecimals: t.decimals,
    amountHuman: defaultAmountForSymbol(t.symbol),
    periodSeconds: DEFAULT_PERIOD_SECONDS,
    explorerUrl: buildAddressUrl(
      explorerInfo.explorerUrl,
      explorerInfo.addressPath,
      t.address
    ),
  }));
}

/**
 * Shared policy wizard used by both:
 *   1. Deploy-with-policies wizard (inside DeployDialog)
 *   2. Install-policies dialog (inside RolePermissionsCard)
 *
 * Steps: "configure" -> "review" (optional simulation result).
 *
 * The wizard emits the new per-protocol `PolicyConfig` shape consumed by
 * `installRolesWithInitialConfig` and the `/role/simulate` route:
 *   { protocols: [{ slug, tokens: [{ tokenAddress, tokenSymbol,
 *     tokenDecimals, amountHuman, periodSeconds }] }] }
 *
 * The caller owns the surrounding Dialog and controls open/close.
 */

export type TokenLimitInput = {
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  amountHuman: string;
  periodSeconds: number;
};

export type ProtocolInput = {
  slug: string;
  tokens: TokenLimitInput[];
};

/**
 * Direct rules configure on-chain spending policies that don't go through
 * a known protocol. Three kinds:
 *   - erc20-transfer: ERC20 transfer to a specific recipient with refillable cap
 *   - erc20-approve: ERC20 approve to a specific spender with refillable cap
 *   - native-transfer: native ETH transfer to a specific recipient (target-only,
 *     no on-chain value cap; the rule only enforces "this exact recipient is allowed")
 *
 * `tokenAddress` is required for the two ERC20 kinds and ignored for native.
 */
export type DirectRuleKind =
  | "erc20-transfer"
  | "erc20-approve"
  | "native-transfer";

export type DirectRuleInput = {
  kind: DirectRuleKind;
  tokenAddress: string | null;
  tokenSymbol: string;
  tokenDecimals: number;
  tokenLogoUrl?: string | null;
  counterparty: string;
  amountHuman: string;
  periodSeconds: number;
};

export type PolicyConfig = {
  protocols: ProtocolInput[];
  directRules?: DirectRuleInput[];
};

export type SimulationPlan = {
  safe: { chainName: string; safeAddress: string };
  plan: {
    operations: Array<{ label: string; detail: string; gasUnits: string }>;
    totalGasUnits: string;
    totalCostNative: string;
    totalCostUsd: number | null;
    nativePriceUsd: number | null;
    note: string;
  };
  applied?: string[];
  skipped?: string[];
};

type ExplorerInfo = {
  explorerUrl: string | null;
  explorerAddressPath: string | null;
};

export type PolicyWizardProps = {
  chainId: number;
  defaultEnabledSlugs?: readonly string[];
  defaultProtocolTokens?: Readonly<Record<string, TokenLimitInput[]>>;
  defaultDirectRules?: readonly DirectRuleInput[];
  mode?: "install" | "edit";
  safeAddress?: string;
  submitting: boolean;
  /**
   * Optional simulator. When provided, the wizard inserts a "Review" step
   * before confirm. Return null to skip the review step entirely.
   */
  simulate?: (config: PolicyConfig) => Promise<SimulationPlan | null>;
  onConfirm: (config: PolicyConfig) => Promise<void>;
  onCancel: () => void;
  /** Label on the primary button in the final step. Defaults to "Confirm". */
  confirmLabel?: string;
  /** Optional explorer info so target-contract links work. */
  explorer?: ExplorerInfo;
  /** Optional override for the protocol catalog (testing hook). */
  catalog?: readonly ProtocolCatalogEntry[];
  /**
   * Notified whenever the wizard transitions between its internal
   * "configure" and "review" sub-steps. Lets a host modal sync an outer
   * stepper bar without duplicating state.
   */
  onStepChange?: (step: "configure" | "review") => void;
};

const HUMAN_AMOUNT_REGEX = /^\d+(\.\d+)?$/;

type ProtocolState = {
  enabled: boolean;
  tokens: TokenRowValue[];
};

function enforcementLabel(level: EnforcementLevel): string {
  return level === "per-parameter"
    ? "Per-parameter policy"
    : "Contract allowlist";
}

export function PolicyWizard({
  chainId,
  defaultEnabledSlugs = [],
  defaultProtocolTokens,
  defaultDirectRules,
  mode = "install",
  safeAddress,
  submitting,
  simulate,
  onConfirm,
  onCancel,
  confirmLabel = "Confirm",
  explorer,
  catalog,
  onStepChange,
}: PolicyWizardProps): React.ReactElement {
  const resolvedCatalog: ProtocolCatalogEntry[] = useMemo(() => {
    if (catalog) {
      return catalog.slice();
    }
    return listProtocolsForChain(chainId);
  }, [catalog, chainId]);

  const orderedCatalog: ProtocolCatalogEntry[] = useMemo(() => {
    if (mode !== "edit") {
      return resolvedCatalog;
    }
    return [...resolvedCatalog].sort((a, b) => {
      const aActive = defaultEnabledSlugs.includes(a.slug) ? 0 : 1;
      const bActive = defaultEnabledSlugs.includes(b.slug) ? 0 : 1;
      return aActive - bActive;
    });
  }, [mode, resolvedCatalog, defaultEnabledSlugs]);

  const explorerInfo = useMemo(
    () => ({
      explorerUrl: explorer?.explorerUrl ?? null,
      addressPath: explorer?.explorerAddressPath ?? null,
    }),
    [explorer]
  );

  const seedTokensForSlug = useCallback(
    (slug: string): TokenRowValue[] => {
      const preset = defaultProtocolTokens?.[slug];
      if (preset && preset.length > 0) {
        return preset.map((t) => ({
          tokenAddress: t.tokenAddress,
          tokenSymbol: t.tokenSymbol,
          tokenDecimals: t.tokenDecimals,
          amountHuman: t.amountHuman,
          periodSeconds: t.periodSeconds,
          explorerUrl: buildAddressUrl(
            explorerInfo.explorerUrl,
            explorerInfo.addressPath,
            t.tokenAddress
          ),
        }));
      }
      return buildSeededTokens(slug as ProtocolSlug, chainId, explorerInfo);
    },
    [defaultProtocolTokens, chainId, explorerInfo]
  );

  const [step, setStep] = useState<"configure" | "review">("configure");
  const [states, setStates] = useState<Record<string, ProtocolState>>(() => {
    const init: Record<string, ProtocolState> = {};
    for (const entry of resolvedCatalog) {
      init[entry.slug] = {
        enabled: defaultEnabledSlugs.includes(entry.slug),
        tokens: seedTokensForSlug(entry.slug),
      };
    }
    return init;
  });
  const [simulating, setSimulating] = useState<boolean>(false);
  const [simulation, setSimulation] = useState<SimulationPlan | null>(null);
  const [directRules, setDirectRules] = useState<DirectRuleInput[]>(() =>
    defaultDirectRules ? [...defaultDirectRules] : []
  );

  // Re-sync when chain changes (catalog may shrink/grow). Newly-introduced
  // protocols get their default token seed; existing protocols keep
  // whatever the admin already configured.
  useEffect(() => {
    setStates((prev) => {
      const next: Record<string, ProtocolState> = {};
      for (const entry of resolvedCatalog) {
        next[entry.slug] = prev[entry.slug] ?? {
          enabled: defaultEnabledSlugs.includes(entry.slug),
          tokens: seedTokensForSlug(entry.slug),
        };
      }
      return next;
    });
  }, [resolvedCatalog, defaultEnabledSlugs, seedTokensForSlug]);

  const targetsFor = useCallback(
    (slug: string): Array<{ address: string; explorerUrl: string | null }> => {
      const addrs = getProtocolTargets(slug as ProtocolSlug, chainId);
      return addrs.map((a) => ({
        address: a,
        explorerUrl: buildAddressUrl(
          explorer?.explorerUrl ?? null,
          explorer?.explorerAddressPath ?? null,
          a
        ),
      }));
    },
    [chainId, explorer]
  );

  const setEnabled = (slug: string, enabled: boolean): void => {
    setStates((prev) => ({
      ...prev,
      [slug]: {
        enabled,
        tokens: prev[slug]?.tokens ?? [],
      },
    }));
  };

  const setTokens = (slug: string, tokens: TokenRowValue[]): void => {
    setStates((prev) => ({
      ...prev,
      [slug]: {
        enabled: prev[slug]?.enabled ?? false,
        tokens,
      },
    }));
  };

  const buildConfig = (): PolicyConfig | null => {
    const protocols: ProtocolInput[] = [];
    for (const entry of resolvedCatalog) {
      const state = states[entry.slug];
      if (!state?.enabled) {
        continue;
      }
      if (state.tokens.length === 0) {
        toast.error(`Add at least one token for ${entry.label}`);
        return null;
      }
      for (const t of state.tokens) {
        if (!t.amountHuman.trim()) {
          toast.error(`Set an amount for ${t.tokenSymbol} on ${entry.label}`);
          return null;
        }
        if (!HUMAN_AMOUNT_REGEX.test(t.amountHuman.trim())) {
          toast.error(
            `Amount for ${t.tokenSymbol} on ${entry.label} must be a positive number`
          );
          return null;
        }
      }
      protocols.push({
        slug: entry.slug,
        tokens: state.tokens.map((t) => ({
          tokenAddress: t.tokenAddress,
          tokenSymbol: t.tokenSymbol,
          tokenDecimals: t.tokenDecimals,
          amountHuman: t.amountHuman.trim(),
          periodSeconds: t.periodSeconds,
        })),
      });
    }

    const validatedDirect: DirectRuleInput[] = [];
    for (const rule of directRules) {
      if (rule.kind !== "native-transfer" && !rule.tokenAddress) {
        toast.error("Pick a token for every ERC20 rule");
        return null;
      }
      if (!ethers.isAddress(rule.counterparty)) {
        toast.error("Direct rule recipient/spender must be a valid address");
        return null;
      }
      if (!rule.amountHuman.trim()) {
        toast.error("Set an amount for every direct rule");
        return null;
      }
      if (!HUMAN_AMOUNT_REGEX.test(rule.amountHuman.trim())) {
        toast.error("Direct-rule amount must be a positive number");
        return null;
      }
      validatedDirect.push({
        ...rule,
        counterparty: ethers.getAddress(rule.counterparty),
        amountHuman: rule.amountHuman.trim(),
      });
    }

    if (protocols.length === 0 && validatedDirect.length === 0) {
      toast.error("Enable at least one protocol or add a direct rule");
      return null;
    }
    return { protocols, directRules: validatedDirect };
  };

  const handleNext = async (): Promise<void> => {
    const config = buildConfig();
    if (!config) {
      return;
    }
    if (!simulate) {
      await onConfirm(config);
      return;
    }
    setSimulating(true);
    try {
      const plan = await simulate(config);
      if (plan) {
        setSimulation(plan);
        setStep("review");
        onStepChange?.("review");
      } else {
        await onConfirm(config);
      }
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not simulate the plan"
      );
    } finally {
      setSimulating(false);
    }
  };

  const handleBack = (): void => {
    setStep("configure");
    onStepChange?.("configure");
  };

  const handleConfirm = async (): Promise<void> => {
    const config = buildConfig();
    if (!config) {
      return;
    }
    await onConfirm(config);
  };

  return (
    <div className="flex flex-col gap-3">
      {step === "configure" && (
        <>
          {safeAddress && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/20 px-3 py-2 text-xs">
              <span className="font-medium">Safe being managed</span>
              <AddressWithExplorer address={safeAddress} chainId={chainId} />
              <span className="text-muted-foreground">
                on {getChainDisplayName(chainId)}
              </span>
            </div>
          )}

          <div>
            <div className="flex items-center gap-1.5">
              <Label className="text-xs">
                {mode === "edit"
                  ? "Manage protocols on this Safe"
                  : "Protocols available on this chain"}
              </Label>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    aria-label="How protocol policies work"
                    className="text-muted-foreground transition-colors hover:text-foreground"
                    type="button"
                  >
                    <InfoIcon className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs" side="right">
                  <ul className="list-inside list-disc space-y-1">
                    <li>
                      Workflows on this Safe can only call the protocols you
                      enable. Anything else reverts on chain.
                    </li>
                    <li>
                      Per protocol, pick tokens it can spend, the cap per
                      period, and how often it refills.
                    </li>
                    <li>
                      {enforcementLabel("per-parameter")} pins specific function
                      arguments on chain.{" "}
                      {enforcementLabel("contract-allowlist")} allows any
                      function on the listed contracts; the cap is the only
                      protection.
                    </li>
                    <li>
                      Each protocol has its own cap per token. Two protocols
                      holding USDC each have independent allowances, never
                      shared.
                    </li>
                    <li>
                      Owner caveat: at threshold 1 your Turnkey EOA can still
                      sign `safe.execTransaction` directly and bypass these
                      rules. Treat policies as workflow-scoping, not an absolute
                      spending boundary.
                    </li>
                  </ul>
                </TooltipContent>
              </Tooltip>
            </div>
            {mode === "edit" && (
              <p className="mt-1 mb-1 text-muted-foreground text-xs">
                Active protocols are listed first. Click × on a protocol to
                remove it, or Add to enable a new one. Your changes apply in one
                Safe transaction when you confirm.
              </p>
            )}
            <ul className="thin-scrollbar mt-1 max-h-[28rem] space-y-2 overflow-y-auto rounded-md border p-2">
              {orderedCatalog.map((entry) => {
                const state = states[entry.slug] ?? {
                  enabled: false,
                  tokens: [],
                };
                return (
                  <PolicyProtocolCard
                    alreadyApplied={defaultEnabledSlugs.includes(entry.slug)}
                    catalog={entry}
                    chainId={chainId}
                    enabled={state.enabled}
                    key={entry.slug}
                    mode={mode}
                    onEnabledChange={(enabled) =>
                      setEnabled(entry.slug, enabled)
                    }
                    onTokensChange={(tokens) => setTokens(entry.slug, tokens)}
                    targets={targetsFor(entry.slug)}
                    tokens={state.tokens}
                  />
                );
              })}
              {orderedCatalog.length === 0 && (
                <li className="rounded border bg-muted/20 p-3 text-muted-foreground text-xs">
                  No protocols are currently available on chain {chainId}.
                </li>
              )}
            </ul>
          </div>

          <DirectRulesSection
            chainId={chainId}
            onChange={setDirectRules}
            rules={directRules}
            safeAddress={safeAddress}
          />
        </>
      )}

      {step === "review" && simulation && (
        <div className="space-y-3 text-sm">
          <div className="rounded-md border bg-muted/20 p-3">
            <div className="mb-1 font-medium">Target</div>
            <div className="space-y-0.5 text-muted-foreground text-xs">
              <div>
                <span className="text-foreground">Network:</span>{" "}
                {getChainDisplayName(chainId)}
              </div>
              <div>
                <span className="text-foreground">Address:</span>{" "}
                {simulation.safe.safeAddress}
              </div>
            </div>
          </div>

          {simulation.applied && simulation.applied.length > 0 && (
            <div className="rounded-md border bg-muted/20 p-3">
              <div className="mb-1 font-medium">Protocols applied</div>
              <div className="text-muted-foreground text-xs">
                {simulation.applied.map(getProtocolLabel).join(", ")}
              </div>
            </div>
          )}

          {simulation.skipped && simulation.skipped.length > 0 && (
            <div className="rounded-md border border-amber-300/40 bg-amber-500/10 p-3">
              <div className="mb-1 flex items-center gap-1 font-medium">
                <AlertTriangleIcon className="h-3.5 w-3.5" />
                Protocols skipped
              </div>
              <div className="text-muted-foreground text-xs">
                {simulation.skipped.map(getProtocolLabel).join(", ")}. These are
                not supported on this chain or lack a template.
              </div>
            </div>
          )}

          <div className="rounded-md border bg-muted/20 p-3">
            <div className="mb-2 font-medium">On-chain operations</div>
            <ol className="space-y-2 text-xs">
              {simulation.plan.operations.map((op) => (
                <li className="rounded border bg-background p-2" key={op.label}>
                  <div className="font-medium">{op.label}</div>
                  <div className="text-muted-foreground">{op.detail}</div>
                  <div className="mt-1 text-muted-foreground">
                    ~{op.gasUnits} gas
                  </div>
                </li>
              ))}
            </ol>
          </div>

          <div className="rounded-md border bg-muted/20 p-3">
            <div className="mb-1 font-medium">Estimated total cost</div>
            <div className="font-mono text-xs">
              {simulation.plan.totalGasUnits} gas ·{" "}
              {simulation.plan.totalCostNative} native
              {simulation.plan.totalCostUsd !== null && (
                <span> (~${simulation.plan.totalCostUsd.toFixed(2)})</span>
              )}
            </div>
            <p className="mt-2 text-muted-foreground text-xs">
              {simulation.plan.note}
            </p>
          </div>
        </div>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <Button
          disabled={submitting || simulating}
          onClick={step === "review" ? handleBack : onCancel}
          type="button"
          variant="outline"
        >
          {step === "review" ? "Back" : "Cancel"}
        </Button>
        {step === "configure" && (
          <Button
            disabled={submitting || simulating}
            onClick={handleNext}
            type="button"
          >
            {simulating && <Spinner className="h-4 w-4" />}
            {!simulating && (simulate ? "Review" : confirmLabel)}
          </Button>
        )}
        {step === "review" && (
          <Button disabled={submitting} onClick={handleConfirm} type="button">
            {submitting ? <Spinner className="h-4 w-4" /> : confirmLabel}
          </Button>
        )}
      </div>
    </div>
  );
}
