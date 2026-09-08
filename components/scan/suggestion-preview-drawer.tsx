"use client";

import { useSetAtom } from "jotai";
import { AlertTriangle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useAuthPrompt } from "@/components/auth/provider";
import { AddressActions } from "@/components/scan/address-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { WorkflowCanvas } from "@/components/workflow/workflow-canvas";
import { getChainName } from "@/lib/chain-utils";
import { buildWorkflow } from "@/lib/scan/factory";
import {
  addressFieldLabel,
  formatThresholdForDisplay,
  isEditableThreshold,
  parseThresholdToBaseUnits,
  thresholdDecimals,
  thresholdFieldMeta,
} from "@/lib/scan/factory/threshold-format";
import { persistSuggestion } from "@/lib/scan/persist-suggestion";
import type { SuggestionDescriptor } from "@/lib/scan/suggestions/types";
import {
  edgesAtom,
  isWorkflowOwnerAtom,
  nodesAtom,
  rightPanelWidthAtom,
} from "@/lib/workflow/store";

/** A confirmInputs value that is a raw EVM address. */
const ADDRESS_DISPLAY_RE = /^0x[0-9a-fA-F]{40}$/;

type SuggestionPreviewDrawerProps = {
  suggestion: SuggestionDescriptor | null;
  /**
   * Sibling descriptors when the selected card grouped multiple
   * (token, network) options. The drawer renders Token/Network pickers and
   * swaps the previewed workflow to the matching variant.
   */
  variants?: SuggestionDescriptor[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isAuthenticated: boolean;
  /** Scanned EVM address from the page — used to build the redirectTo URL for
   *  the anon sign-in round-trip (FUNNEL-02). */
  address: string;
  /** Signed-in user's email, used to prefill the alert node's recipient so
   *  Run / Save pass config validation. Undefined when anonymous. */
  userEmail?: string;
  /** ENS name the scan resolved, shown alongside the wallet address. */
  ensName?: string;
  /** Detected kind of the scanned address; adapts the wallet field label. */
  addressKind?: "eoa" | "contract";
};

export function SuggestionPreviewDrawer({
  suggestion,
  variants,
  open,
  onOpenChange,
  isAuthenticated,
  address,
  userEmail,
  ensName,
  addressKind,
}: SuggestionPreviewDrawerProps): React.ReactElement | null {
  const setNodes = useSetAtom(nodesAtom);
  const setEdges = useSetAtom(edgesAtom);
  const setIsOwner = useSetAtom(isWorkflowOwnerAtom);
  const setRightPanelWidth = useSetAtom(rightPanelWidthAtom);
  const { openAuthPrompt } = useAuthPrompt();
  const router = useRouter();
  const [needsWallet, setNeedsWallet] = useState<boolean>(false);
  const [isPersisting, setIsPersisting] = useState<boolean>(false);
  const [isProvisioning, setIsProvisioning] = useState<boolean>(false);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [lastSuggestionId, setLastSuggestionId] = useState<string | null>(null);

  // In-progress human-readable threshold edits, keyed by confirmInputs key.
  // Held per active descriptor id (editsForId) so switching token/network or
  // card starts fresh.
  const [thresholdEdits, setThresholdEdits] = useState<Record<string, string>>(
    {}
  );
  const [editsForId, setEditsForId] = useState<string | null>(null);

  // Editable alert recipient. null = fall back to the signed-in user's email;
  // once the user types, this holds their value.
  const [emailEdit, setEmailEdit] = useState<string | null>(null);
  const alertEmail = emailEdit ?? userEmail ?? "";

  // A new card selection resets the token/network choice
  // (adjust-state-during-render pattern; avoids an effect round-trip).
  if ((suggestion?.id ?? null) !== lastSuggestionId) {
    setLastSuggestionId(suggestion?.id ?? null);
    setActiveId(suggestion?.id ?? null);
  }

  const variantList = useMemo(() => {
    if (variants && variants.length > 0) {
      return variants;
    }
    return suggestion ? [suggestion] : [];
  }, [variants, suggestion]);

  // The descriptor currently previewed: the picked variant, falling back to
  // the card's primary suggestion.
  const active = variantList.find((v) => v.id === activeId) ?? suggestion;

  // Reset threshold edits whenever the active descriptor changes (card,
  // token, or network). Discard-during-render: edits only apply while
  // editsForId matches, so this render already sees an empty edit set.
  const activeIdKey = active?.id ?? null;
  if (activeIdKey !== editsForId) {
    setEditsForId(activeIdKey);
    setThresholdEdits({});
  }
  const activeEdits = activeIdKey === editsForId ? thresholdEdits : {};

  // Apply valid human-readable edits back onto confirmInputs as base units.
  // An invalid/in-progress edit (e.g. "1.") is skipped so the preview never
  // breaks; the original value stays until the edit parses.
  const effectiveActive = useMemo(() => {
    if (!active) {
      return null;
    }
    const keys = Object.keys(activeEdits);
    if (keys.length === 0) {
      return active;
    }
    const overridden: Record<string, string> = { ...active.confirmInputs };
    for (const key of keys) {
      const parsed = parseThresholdToBaseUnits(
        activeEdits[key],
        thresholdDecimals(key, active)
      );
      if (parsed !== null) {
        overridden[key] = parsed;
      }
    }
    return { ...active, confirmInputs: overridden };
  }, [active, activeEdits]);

  // Build the prefilled workflow client-side. Factory has no server-only
  // import (confirmed in RESEARCH). Guard with try/catch: buildWorkflow throws
  // on invalid template refs or MaxUint256 approvals.
  const workflow = useMemo(() => {
    if (!effectiveActive) {
      return null;
    }
    try {
      return buildWorkflow(effectiveActive);
    } catch {
      return null;
    }
  }, [effectiveActive]);

  // Hydrate global Jotai workflow atoms when the drawer opens.
  // CRITICAL: cleanup MUST reset atoms on close so the homepage canvas
  // is not polluted when the user navigates away (T-53-08 / Pitfall 2).
  // Also resets the provision gate (needsWallet) so it does not carry over
  // to a different suggestion opened in a subsequent drawer session.
  useEffect(() => {
    if (open && workflow) {
      setNodes(workflow.nodes);
      setEdges(workflow.edges);
      // isWorkflowOwnerAtom=false → WorkflowToolbar shows read-only mode;
      // NodeConfigPanel gates all write controls behind isOwner (Pitfall 3).
      setIsOwner(false);
      // Reset any stale panel width from a previous /workflows/* visit
      // (Pitfall 3: rightPanelWidth would narrow the canvas otherwise).
      setRightPanelWidth(null);
    }

    return () => {
      // Runs on close (open changes) and on unmount.
      // currentWorkflowIdAtom is deliberately NOT set here or anywhere in
      // this component — keeping it null suppresses WorkflowToolbar and
      // prevents autosave (T-53-08).
      setNodes([]);
      setEdges([]);
      setIsOwner(true);
      setRightPanelWidth(null);
      setNeedsWallet(false);
    };
  }, [open, workflow, setNodes, setEdges, setIsOwner, setRightPanelWidth]);

  // Short-circuit AFTER hooks so the hook call order is stable.
  if (!suggestion) {
    return null;
  }

  const activeSuggestion = effectiveActive ?? suggestion;
  const tokenOptions = [
    ...new Set(variantList.map((v) => v.symbol ?? "").filter(Boolean)),
  ];
  const networkOptions = variantList.filter(
    (v) => v.symbol === activeSuggestion.symbol
  );
  const showTokenPicker = tokenOptions.length > 1;
  const showNetworkPicker = networkOptions.length > 1;
  const showVariantPickers = showTokenPicker || showNetworkPicker;

  const handleThresholdChange = (key: string, human: string): void => {
    setThresholdEdits((prev) => ({ ...prev, [key]: human }));
  };

  const handleTokenChange = (symbol: string): void => {
    // Prefer keeping the current network when the new token exists there.
    const sameChain = variantList.find(
      (v) => v.symbol === symbol && v.chainId === activeSuggestion.chainId
    );
    const target = sameChain ?? variantList.find((v) => v.symbol === symbol);
    if (target) {
      setActiveId(target.id);
    }
  };

  const handleNetworkChange = (chainId: string): void => {
    const target = variantList.find(
      (v) =>
        v.symbol === activeSuggestion.symbol && String(v.chainId) === chainId
    );
    if (target) {
      setActiveId(target.id);
    }
  };

  const handleCta = async (mode: "run" | "schedule"): Promise<void> => {
    if (!isAuthenticated) {
      // Anon path (T-54-30): set the pending_scan cookie, then open the
      // auth prompt. No create/PATCH/execute while unauthenticated — the
      // server APIs 401 anon regardless (defence-in-depth).
      try {
        await fetch("/api/auth/scan-intent", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            intent: JSON.stringify({ ...activeSuggestion, mode }),
          }),
        });
      } catch {
        // Non-fatal: if the cookie write fails the round-trip won't auto-
        // resume, but the user can still sign in and proceed manually.
      }
      openAuthPrompt({
        action: mode === "schedule" ? "scan-schedule" : "scan-run",
        redirectTo: `/scan?address=${encodeURIComponent(address)}`,
      });
      return;
    }

    // Write gate (FUNNEL-05, forward-compat): all v1.13 real suggestions are
    // read-only; this branch is exercised only by SYNTHETIC_WRITE_DESCRIPTOR.
    if (activeSuggestion.readOrWrite === "write") {
      try {
        const res = await fetch("/api/scan/wallet-check", {
          method: "GET",
          credentials: "same-origin",
        });
        if (!res.ok) {
          toast.error("Could not verify wallet status. Please try again.");
          return;
        }
        const data = (await res.json()) as { hasWallet: boolean };
        if (!data.hasWallet) {
          // Surface the provision CTA; do NOT persist (T-54-33).
          setNeedsWallet(true);
          return;
        }
      } catch {
        toast.error("Could not verify wallet status. Please try again.");
        return;
      }
    }

    // Authenticated + read suggestion (or write + wallet present): persist inline.
    setIsPersisting(true);
    try {
      const { id } = await persistSuggestion(activeSuggestion, mode, {
        defaultEmail: alertEmail,
      });
      toast.success("Workflow saved!");
      router.push(`/workflows/${id}`);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to save workflow";
      toast.error(message);
    } finally {
      setIsPersisting(false);
    }
  };

  const handleUseClick = (): void => {
    // These suggestions are recurring monitors, so "use" saves them on their
    // schedule (create enabled + sync schedule + run once).
    handleCta("schedule").catch(() => {
      // Errors are handled inside handleCta.
    });
  };

  const doProvision = async (): Promise<void> => {
    setIsProvisioning(true);
    try {
      const res = await fetch("/api/agentic-wallet/provision", {
        method: "POST",
        credentials: "same-origin",
      });
      if (res.ok) {
        toast.success("Wallet set up! You can now run this workflow.");
        setNeedsWallet(false);
      } else {
        toast.error("Failed to set up wallet. Please try again.");
      }
    } catch {
      toast.error("Failed to set up wallet. Please try again.");
    } finally {
      setIsProvisioning(false);
    }
  };

  const handleProvisionClick = (): void => {
    doProvision().catch(() => {
      // Errors are handled inside doProvision.
    });
  };

  // A committed valid edit only changes threshold keys (whose display uses the
  // in-progress activeEdits value anyway), so iterating the effective
  // confirmInputs here is equivalent to the originals for display purposes and
  // keeps the descriptor non-null for the helpers below.
  const confirmEntries = Object.entries(activeSuggestion.confirmInputs);

  const renderParamField = (key: string, value: string): React.ReactElement => {
    if (isEditableThreshold(key, value)) {
      const decimals = thresholdDecimals(key, activeSuggestion);
      const meta = thresholdFieldMeta(key, activeSuggestion);
      const shown =
        key in activeEdits
          ? activeEdits[key]
          : formatThresholdForDisplay(value, decimals);
      const invalid =
        key in activeEdits &&
        parseThresholdToBaseUnits(activeEdits[key], decimals) === null;
      return (
        <div className="mb-3" key={key}>
          <label
            className="mb-1 block text-muted-foreground text-xs"
            htmlFor={`param-${key}`}
          >
            {meta.label}
          </label>
          <div className="relative">
            <Input
              aria-invalid={invalid || undefined}
              className="pr-16 font-mono text-sm"
              id={`param-${key}`}
              inputMode="decimal"
              onChange={(e) => handleThresholdChange(key, e.target.value)}
              value={shown}
            />
            {meta.unit ? (
              <span className="-translate-y-1/2 pointer-events-none absolute top-1/2 right-3 text-muted-foreground text-xs">
                {meta.unit}
              </span>
            ) : null}
          </div>
          {invalid ? (
            <p className="mt-1 text-[var(--color-text-error)] text-xs">
              Enter a valid number.
            </p>
          ) : null}
        </div>
      );
    }
    // Wallet field: show the ENS name when the scan resolved one; otherwise
    // the FULL address (never truncated - the user must be able to verify it).
    const displayValue = key === "walletAddress" && ensName ? ensName : value;
    const label =
      key === "walletAddress" && addressKind === "contract"
        ? "Contract address"
        : addressFieldLabel(key);
    const isAddress = ADDRESS_DISPLAY_RE.test(value);
    return (
      <div className="mb-3" key={key}>
        <div className="mb-1 flex items-center justify-between gap-2">
          <label
            className="block text-muted-foreground text-xs"
            htmlFor={`param-${key}`}
          >
            {label}
          </label>
          {isAddress ? (
            <AddressActions
              address={value}
              canBookmark={isAuthenticated}
              chainId={activeSuggestion.chainId}
            />
          ) : null}
        </div>
        <Input
          className="cursor-default bg-muted font-mono text-sm"
          id={`param-${key}`}
          readOnly
          tabIndex={-1}
          value={displayValue}
        />
      </div>
    );
  };

  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent
        className="sm:max-w-xl w-full overflow-y-auto"
        // Radix focuses the first tabbable element on open, which lands on the
        // threshold input and selects its text — reads as "highlighted by
        // default". Keep focus on the sheet itself instead.
        onOpenAutoFocus={(e) => e.preventDefault()}
        side="right"
      >
        <SheetHeader className="border-b border-border/20">
          <SheetTitle className="text-base font-semibold text-foreground">
            {activeSuggestion.name}
          </SheetTitle>
          <SheetDescription className="mt-1 text-sm text-muted-foreground">
            {activeSuggestion.description}
          </SheetDescription>
        </SheetHeader>

        <div className="p-4">
          {/* Canvas preview area — WorkflowCanvas fills the container at
              100% height. [data-testid="workflow-canvas"] is on the canvas
              root div inside WorkflowCanvas (verified in source). */}
          {/* Height fits the single-row node chain: the shapes are always a
              4-node horizontal flow, so a tall canvas was mostly empty space
              (UAT feedback). fitView scales the row to this shorter band. */}
          <section
            aria-label="Workflow preview"
            className="h-48 w-full rounded-lg border border-border/20 bg-[var(--color-hub-overlay)] overflow-hidden"
          >
            <WorkflowCanvas />
          </section>

          {/* Token / network pickers — shown when the card grouped multiple
              (token, network) sibling suggestions into one entry. */}
          {showVariantPickers && (
            <div className="mt-4 grid grid-cols-2 gap-3">
              {showTokenPicker && (
                <div>
                  <label
                    className="mb-1 block text-xs text-muted-foreground"
                    htmlFor="variant-token"
                  >
                    Token
                  </label>
                  <Select
                    onValueChange={handleTokenChange}
                    value={activeSuggestion.symbol ?? ""}
                  >
                    <SelectTrigger className="w-full" id="variant-token">
                      <SelectValue placeholder="Select token" />
                    </SelectTrigger>
                    <SelectContent>
                      {tokenOptions.map((sym) => (
                        <SelectItem key={sym} value={sym}>
                          {sym}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {showNetworkPicker && (
                <div>
                  <label
                    className="mb-1 block text-xs text-muted-foreground"
                    htmlFor="variant-network"
                  >
                    Network
                  </label>
                  <Select
                    onValueChange={handleNetworkChange}
                    value={String(activeSuggestion.chainId)}
                  >
                    <SelectTrigger className="w-full" id="variant-network">
                      <SelectValue placeholder="Select network" />
                    </SelectTrigger>
                    <SelectContent>
                      {networkOptions.map((v) => (
                        <SelectItem key={v.chainId} value={String(v.chainId)}>
                          {getChainName(String(v.chainId))}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          )}

          {/* Workflow parameters — thresholds are human-readable and editable;
              addresses are read-only. Values rendered via the React value prop
              only (T-53-07: no dangerouslySetInnerHTML). */}
          {/* Render even with no confirmInputs (e.g. depeg watch) so the
              signed-in email field always gives the preview a config surface. */}
          {(confirmEntries.length > 0 || isAuthenticated) && (
            <div className="mt-4">
              <h3 className="mb-2 font-semibold text-muted-foreground text-xs uppercase tracking-wide">
                Alert settings
              </h3>
              {confirmEntries.map(([key, value]) =>
                renderParamField(key, value)
              )}
              {isAuthenticated && (
                <div className="mb-3">
                  <label
                    className="mb-1 block text-muted-foreground text-xs"
                    htmlFor="param-alert-email"
                  >
                    Alert email
                  </label>
                  <Input
                    id="param-alert-email"
                    onChange={(e) => setEmailEdit(e.target.value)}
                    placeholder="you@example.com"
                    type="email"
                    value={alertEmail}
                  />
                </div>
              )}
            </div>
          )}

          {/* CTAs — see FUNNEL-02/03/04/05 for the full branching logic.
              needsWallet replaces the normal CTA pair with a provision prompt
              (FUNNEL-05, write-type suggestion only, forward-compat). */}
          {needsWallet ? (
            <div className="mt-6">
              <p className="mb-3 text-sm text-muted-foreground">
                This workflow requires a connected wallet. Set one up to
                continue.
              </p>
              <Button
                className="w-full"
                disabled={isProvisioning}
                onClick={handleProvisionClick}
                variant="default"
              >
                Set up Wallet
              </Button>
            </div>
          ) : (
            <div className="mt-6">
              <Button
                className="w-full"
                disabled={isPersisting || (isAuthenticated && !alertEmail)}
                onClick={handleUseClick}
                variant="default"
              >
                Use this workflow
              </Button>
            </div>
          )}

          {/* Risk note — rendered as JSX text (T-53-07). */}
          <div className="mt-4 flex items-start gap-1.5">
            <AlertTriangle
              aria-hidden="true"
              className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/60"
            />
            <p className="text-xs leading-relaxed text-muted-foreground/80">
              {suggestion.riskNote}
            </p>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
