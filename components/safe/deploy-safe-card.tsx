"use client";

import { Copy, ExternalLink, Plus, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  getExplorerAddressUrl,
  getSafeAppUrl,
} from "@/components/safe/chain-prefixes";
import {
  type PolicyConfig,
  PolicyWizard,
  type SimulationPlan,
} from "@/components/safe/policy-wizard";
import { RolePermissionsCard } from "@/components/safe/role-permissions-card";
import { SafeSigningToggle } from "@/components/safe/safe-signing-toggle";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { toChecksumAddress, truncateAddress } from "@/lib/address-utils";

type SafeSummary = {
  id: string;
  chainId: number;
  safeAddress: string;
  owners: string[];
  threshold: number;
  safeVersion: string;
  deploymentTxHash: string | null;
  deploymentBlock: number | null;
  status: string;
  isSigningActive: boolean;
  deployedAt: string | null;
};

type ListResponse = {
  safes: SafeSummary[];
  supportedChainIds: number[];
};

type DeployResponse = {
  success?: true;
  alreadyDeployed?: boolean;
  safe?: SafeSummary;
  error?: string;
};

const WIZARD_DEFAULT_PROTOCOLS: readonly string[] = [];

// Label map covers every chain we might ever render, not just the
// currently deploy-supported set, so stale or legacy rows render with a
// real name instead of the "Chain <id>" fallback.
const CHAIN_LABELS: Record<number, string> = {
  // mainnets
  1: "Ethereum",
  10: "Optimism",
  8453: "Base",
  42161: "Arbitrum One",
  56: "BNB Smart Chain",
  137: "Polygon",
  43114: "Avalanche",
  // testnets
  11155111: "Ethereum Sepolia",
  11155420: "Optimism Sepolia",
  84532: "Base Sepolia",
  421614: "Arbitrum Sepolia",
  97: "BSC Testnet",
  80002: "Polygon Amoy",
  43113: "Avalanche Fuji",
};

function chainLabel(chainId: number): string {
  return CHAIN_LABELS[chainId] ?? `Chain ${chainId}`;
}

// Mainnet chain IDs the Safe deploy surface knows about. Anything not in
// this set renders as a testnet in the network picker. Kept in sync with
// the "// mainnets" block in CHAIN_LABELS above.
const MAINNET_CHAIN_IDS: ReadonlySet<number> = new Set<number>([
  1, 10, 8453, 42_161, 56, 137, 43_114,
]);

function partitionChainsByNetworkClass(chainIds: readonly number[]): {
  mainnets: number[];
  testnets: number[];
} {
  const mainnets: number[] = [];
  const testnets: number[] = [];
  for (const id of chainIds) {
    if (MAINNET_CHAIN_IDS.has(id)) {
      mainnets.push(id);
    } else {
      testnets.push(id);
    }
  }
  return { mainnets, testnets };
}

function DeployedSafeRow({
  safe,
  isAdmin,
  isOwner,
  onSigningChange,
}: {
  safe: SafeSummary;
  isAdmin: boolean;
  isOwner: boolean;
  onSigningChange: (safeId: string, next: boolean) => void;
}): React.ReactElement {
  const label = chainLabel(safe.chainId);
  const checksummed = toChecksumAddress(safe.safeAddress);
  const explorerUrl = getExplorerAddressUrl(safe.chainId, safe.safeAddress);
  const safeAppUrl = getSafeAppUrl(safe.chainId, safe.safeAddress);

  const handleCopy = (): void => {
    navigator.clipboard.writeText(checksummed);
    toast.success("Safe address copied");
  };

  return (
    <li className="space-y-3 rounded-md border bg-muted/20 px-3 py-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm">{label}</span>
            {safe.isSigningActive && (
              <span className="rounded-full bg-keeperhub-green/10 px-1.5 py-0.5 font-medium text-[10px] text-keeperhub-green/80 uppercase tracking-wide">
                Active signer
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 text-muted-foreground text-xs">
            <code className="break-all font-mono">
              {truncateAddress(checksummed)}
            </code>
            <button
              aria-label="Copy Safe address"
              className="hover:text-foreground"
              onClick={handleCopy}
              type="button"
            >
              <Copy className="h-3 w-3" />
            </button>
            {explorerUrl && (
              <a
                aria-label="View on explorer"
                className="hover:text-foreground"
                href={explorerUrl}
                rel="noopener noreferrer"
                target="_blank"
              >
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
            {safeAppUrl && (
              <a
                className="ml-1 text-muted-foreground text-xs hover:text-foreground"
                href={safeAppUrl}
                rel="noopener noreferrer"
                target="_blank"
              >
                View on Safe
              </a>
            )}
          </div>
          <div className="text-muted-foreground text-xs">
            {safe.threshold}/{safe.owners.length} owners - v{safe.safeVersion}
          </div>
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-xs capitalize ${
            safe.status === "deployed"
              ? "bg-keeperhub-green/10 text-keeperhub-green/80"
              : "bg-muted/50 text-muted-foreground"
          }`}
        >
          {safe.status}
        </span>
      </div>

      {safe.status === "deployed" && (
        <SafeSigningToggle
          chainLabel={label}
          isActive={safe.isSigningActive}
          isAdmin={isAdmin}
          onChange={(next) => onSigningChange(safe.id, next)}
          safeId={safe.id}
        />
      )}

      {safe.status === "deployed" && (
        <RolePermissionsCard
          chainId={safe.chainId}
          isAdmin={isAdmin}
          isOwner={isOwner}
          safeAddress={safe.safeAddress}
          safeId={safe.id}
        />
      )}
    </li>
  );
}

type DeployStep = "network" | "policies" | "review" | "deploying";

const STEP_DEFS: ReadonlyArray<{ key: DeployStep; label: string }> = [
  { key: "network", label: "Network" },
  { key: "policies", label: "Policies" },
  { key: "review", label: "Review" },
  { key: "deploying", label: "Deploy" },
] as const;

type StepStatus = "current" | "done" | "pending";

function bubbleClassFor(status: StepStatus): string {
  if (status === "current") {
    return "border-primary bg-primary text-primary-foreground";
  }
  if (status === "done") {
    return "border-primary/40 bg-primary/10 text-primary";
  }
  return "border-border bg-muted/40 text-muted-foreground";
}

function labelClassFor(status: StepStatus): string {
  if (status === "current") {
    return "font-medium text-foreground";
  }
  if (status === "done") {
    return "text-foreground";
  }
  return "text-muted-foreground";
}

function statusFor(idx: number, currentIdx: number): StepStatus {
  if (idx === currentIdx) {
    return "current";
  }
  if (idx < currentIdx) {
    return "done";
  }
  return "pending";
}

function StepIndicator({
  current,
}: {
  current: DeployStep;
}): React.ReactElement {
  const currentIdx = STEP_DEFS.findIndex((s) => s.key === current);
  return (
    <ol className="flex items-center gap-2 px-1 pb-1 text-xs">
      {STEP_DEFS.map((s, idx) => {
        const status = statusFor(idx, currentIdx);
        const isLast = idx === STEP_DEFS.length - 1;
        return (
          <li className="flex items-center gap-2" key={s.key}>
            <span
              className={`flex h-5 w-5 items-center justify-center rounded-full border font-medium text-[10px] ${bubbleClassFor(status)}`}
            >
              {idx + 1}
            </span>
            <span className={labelClassFor(status)}>{s.label}</span>
            {!isLast && (
              <span
                aria-hidden="true"
                className={`h-px w-6 ${status === "done" ? "bg-primary/40" : "bg-border"}`}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Step-form deploy wizard:
 *   1. Network    -- pick the target chain
 *   2. Policies   -- configure protocols and direct rules (PolicyWizard configure)
 *   3. Review     -- simulation results from /api/user/safe/simulate-deploy
 *   4. Deploy     -- terminal step while the deploy + install fires
 */
function DeployDialog({
  open,
  onOpenChange,
  deployableChainIds,
  onDeploy,
  deploying,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deployableChainIds: number[];
  onDeploy: (
    chainId: number,
    policyConfig: PolicyConfig | null
  ) => Promise<void>;
  deploying: boolean;
}): React.ReactElement {
  const [step, setStep] = useState<DeployStep>("network");
  const [selectedChain, setSelectedChain] = useState<string>("");

  const resetWizard = useCallback((): void => {
    setStep("network");
    setSelectedChain("");
  }, []);

  const chainIdNumber = Number.parseInt(selectedChain, 10);
  const hasValidChain = Number.isFinite(chainIdNumber);

  const currentStep: DeployStep = deploying ? "deploying" : step;

  const handleNetworkContinue = (): void => {
    if (!hasValidChain) {
      toast.error("Select a network");
      return;
    }
    setStep("policies");
  };

  const handleConfirmWithPolicies = async (
    config: PolicyConfig
  ): Promise<void> => {
    if (!hasValidChain) {
      toast.error("Select a network");
      return;
    }
    await onDeploy(chainIdNumber, config);
    resetWizard();
  };

  const handleSimulateDeploy = async (
    config: PolicyConfig
  ): Promise<SimulationPlan | null> => {
    if (!hasValidChain) {
      throw new Error("Select a network before simulating");
    }
    const res = await fetch("/api/user/safe/simulate-deploy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chainId: chainIdNumber,
        protocols: config.protocols,
      }),
    });
    const data = (await res.json()) as SimulationPlan | { error?: string };
    if (!res.ok || "error" in data) {
      const message =
        "error" in data
          ? (data.error ?? "Simulation failed")
          : "Simulation failed";
      throw new Error(message);
    }
    return data as SimulationPlan;
  };

  const handlePolicyStepChange = (s: "configure" | "review"): void => {
    setStep(s === "review" ? "review" : "policies");
  };

  const titleByStep: Record<DeployStep, string> = {
    network: "Pick a network",
    policies: "Configure on-chain policies",
    review: "Review the deploy plan",
    deploying: "Deploying Safe...",
  };

  const descriptionByStep: Record<DeployStep, string> = {
    network:
      "The organization EOA becomes the sole owner at threshold 1. Gas is paid from the EOA's balance on the target chain.",
    policies:
      "Pick at least one protocol or inline rule. The Safe's role can only call what you allow here; everything else reverts on chain.",
    review:
      "Confirm the on-chain operations and estimated gas before broadcasting.",
    deploying:
      "Broadcasting the Safe deployment and installing your policies. This may take a moment.",
  };

  return (
    <Dialog
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) {
          resetWizard();
        }
      }}
      open={open}
    >
      <DialogContent className="thin-scrollbar flex max-h-[85vh] max-w-2xl flex-col gap-3 overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{titleByStep[currentStep]}</DialogTitle>
          <DialogDescription>
            {descriptionByStep[currentStep]}
          </DialogDescription>
        </DialogHeader>

        <StepIndicator current={currentStep} />

        {step === "network" && (
          <div className="space-y-2">
            <Label className="text-xs" htmlFor="safe-deploy-dialog-chain">
              Network
            </Label>
            <Select
              disabled={deploying}
              onValueChange={setSelectedChain}
              value={selectedChain}
            >
              <SelectTrigger id="safe-deploy-dialog-chain">
                <SelectValue placeholder="Select a network" />
              </SelectTrigger>
              <SelectContent>
                {(() => {
                  const { mainnets, testnets } =
                    partitionChainsByNetworkClass(deployableChainIds);
                  return (
                    <>
                      {mainnets.length > 0 && (
                        <SelectGroup>
                          <SelectLabel className="font-medium text-[10px] text-keeperhub-green/80 uppercase tracking-wide">
                            Mainnet
                          </SelectLabel>
                          {mainnets.map((id) => (
                            <SelectItem key={id} value={id.toString()}>
                              {chainLabel(id)}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      )}
                      {testnets.length > 0 && (
                        <SelectGroup>
                          <SelectLabel className="font-medium text-[10px] text-keeperhub-green/80 uppercase tracking-wide">
                            Testnet
                          </SelectLabel>
                          {testnets.map((id) => (
                            <SelectItem key={id} value={id.toString()}>
                              {chainLabel(id)}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      )}
                    </>
                  );
                })()}
              </SelectContent>
            </Select>
          </div>
        )}

        {(step === "policies" || step === "review") && hasValidChain && (
          <PolicyWizard
            chainId={chainIdNumber}
            confirmLabel={
              deploying ? "Deploying..." : "Deploy + install policies"
            }
            defaultEnabledSlugs={WIZARD_DEFAULT_PROTOCOLS}
            onCancel={() => setStep("network")}
            onConfirm={handleConfirmWithPolicies}
            onStepChange={handlePolicyStepChange}
            simulate={handleSimulateDeploy}
            submitting={deploying}
          />
        )}

        {step === "network" && (
          <DialogFooter>
            <Button
              disabled={deploying}
              onClick={() => onOpenChange(false)}
              type="button"
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              disabled={deploying || !selectedChain}
              onClick={handleNetworkContinue}
              type="button"
            >
              Continue
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function DeploySafeCard({
  isAdmin,
  isOwner,
  hideExistingList = false,
}: {
  isAdmin: boolean;
  isOwner: boolean;
  /**
   * When true, the inline list of already-deployed Safes is omitted. Used
   * by the wallet overlay's Deploy-a-Safe modal where each existing Safe is
   * already represented as an account row in the parent overlay; showing
   * them again here was just visual noise.
   */
  hideExistingList?: boolean;
}): React.ReactElement | null {
  const [loading, setLoading] = useState<boolean>(true);
  const [safes, setSafes] = useState<SafeSummary[]>([]);
  const [supportedChainIds, setSupportedChainIds] = useState<number[]>([]);
  const [deployOpen, setDeployOpen] = useState<boolean>(false);
  const [deploying, setDeploying] = useState<boolean>(false);

  const loadSafes = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const res = await fetch("/api/user/safe");
      if (!res.ok) {
        toast.error("Failed to load Safe wallets");
        return;
      }
      const data = (await res.json()) as ListResponse;
      setSafes(data.safes);
      setSupportedChainIds(data.supportedChainIds);
    } catch {
      toast.error("Failed to load Safe wallets");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSafes().catch(() => {
      // Toast already fired inside loadSafes.
    });
  }, [loadSafes]);

  const deployedChainIds = new Set(safes.map((s) => s.chainId));
  const deployableChainIds = supportedChainIds.filter(
    (id) => !deployedChainIds.has(id)
  );

  const handleDeploy = async (
    chainId: number,
    policyConfig: PolicyConfig | null
  ): Promise<void> => {
    setDeploying(true);
    try {
      const res = await fetch("/api/user/safe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chainId }),
      });
      const data = (await res.json()) as DeployResponse;
      if (!(res.ok && data.success)) {
        toast.error(data.error ?? "Safe deployment failed");
        return;
      }
      if (data.alreadyDeployed) {
        toast.info(`Safe already exists on ${chainLabel(chainId)}`);
      } else {
        toast.success(`Safe deployed on ${chainLabel(chainId)}`);
      }

      // Optionally install Zodiac Roles + initial protocol allowlist + token
      // allowances in the same flow. Deploy succeeds even if policy install
      // fails -- the admin can retry from the Safe's card.
      if (policyConfig && data.safe?.id) {
        try {
          const installRes = await fetch(
            `/api/user/safe/${data.safe.id}/role`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(policyConfig),
            }
          );
          const installData = (await installRes.json()) as {
            success?: boolean;
            error?: string;
            skipped?: string[];
          };
          if (installRes.ok && installData.success) {
            if (installData.skipped && installData.skipped.length > 0) {
              toast.warning(
                `Skipped protocols: ${installData.skipped.join(", ")}`
              );
            }
            toast.success("On-chain policies installed");
          } else {
            toast.error(
              installData.error ??
                "Policies install failed; retry from the Safe card"
            );
          }
        } catch (err) {
          toast.error(
            err instanceof Error
              ? err.message
              : "Policies install failed; retry from the Safe card"
          );
        }
      }

      setDeployOpen(false);
      await loadSafes();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Safe deployment failed"
      );
    } finally {
      setDeploying(false);
    }
  };

  const handleSigningChange = (safeId: string, next: boolean): void => {
    setSafes((current) =>
      current.map((s) =>
        s.id === safeId ? { ...s, isSigningActive: next } : s
      )
    );
  };

  if (!isAdmin && safes.length === 0) {
    return null;
  }

  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-muted-foreground" />
        <h3 className="font-medium text-sm">Safe smart account</h3>
      </div>
      <p className="mb-3 text-muted-foreground text-xs">
        Deploy a Safe smart wallet on-chain per network. Safes can hold funds
        and sign workflow transactions independently from the Turnkey EOA.
      </p>

      {loading && (
        <div className="flex items-center justify-center py-4">
          <Spinner />
        </div>
      )}

      {!(loading || hideExistingList) && safes.length > 0 && (
        <ul className="mb-3 space-y-3">
          {safes.map((safe) => (
            <DeployedSafeRow
              isAdmin={isAdmin}
              isOwner={isOwner}
              key={safe.id}
              onSigningChange={handleSigningChange}
              safe={safe}
            />
          ))}
        </ul>
      )}

      {!loading && isAdmin && deployableChainIds.length > 0 && (
        <Button
          onClick={() => setDeployOpen(true)}
          size="sm"
          type="button"
          variant="outline"
        >
          <Plus className="h-3 w-3" />
          Deploy on new chain
        </Button>
      )}

      {!loading &&
        isAdmin &&
        deployableChainIds.length === 0 &&
        safes.length > 0 && (
          <p className="text-muted-foreground text-xs">
            Safes deployed on every supported chain.
          </p>
        )}

      <DeployDialog
        deployableChainIds={deployableChainIds}
        deploying={deploying}
        onDeploy={handleDeploy}
        onOpenChange={setDeployOpen}
        open={deployOpen}
      />
    </section>
  );
}

async function postDeploy(
  chainId: number,
  policyConfig: PolicyConfig | null
): Promise<{ ok: boolean }> {
  const res = await fetch("/api/user/safe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chainId }),
  });
  const data = (await res.json()) as DeployResponse;
  if (!(res.ok && data.success)) {
    toast.error(data.error ?? "Safe deployment failed");
    return { ok: false };
  }
  if (data.alreadyDeployed) {
    toast.info(`Safe already exists on ${chainLabel(chainId)}`);
  } else {
    toast.success(`Safe deployed on ${chainLabel(chainId)}`);
  }
  if (!(policyConfig && data.safe?.id)) {
    return { ok: true };
  }
  try {
    const installRes = await fetch(`/api/user/safe/${data.safe.id}/role`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(policyConfig),
    });
    const installData = (await installRes.json()) as {
      success?: boolean;
      error?: string;
      skipped?: string[];
    };
    if (installRes.ok && installData.success) {
      if (installData.skipped && installData.skipped.length > 0) {
        toast.warning(`Skipped protocols: ${installData.skipped.join(", ")}`);
      }
      toast.success("On-chain policies installed");
    } else {
      toast.error(
        installData.error ?? "Policies install failed; retry from the Safe card"
      );
    }
  } catch (err) {
    toast.error(
      err instanceof Error
        ? err.message
        : "Policies install failed; retry from the Safe card"
    );
  }
  return { ok: true };
}

/**
 * Self-contained deploy step form. Loads supported/deployed chains, runs the
 * Network -> Policies -> Review -> Deploy stepper inline (no Dialog wrapper),
 * and POSTs to /api/user/safe (+ /role) under the hood. Used by the wallet
 * overlay's Deploy-a-Safe view to skip the redundant intermediate "Deploy on
 * new chain" click.
 */
export function DeploySafeFlow({
  onComplete,
  onCancel,
}: {
  onComplete: () => void;
  onCancel: () => void;
}): React.ReactElement {
  const [loading, setLoading] = useState<boolean>(true);
  const [deployableChainIds, setDeployableChainIds] = useState<number[]>([]);
  const [deploying, setDeploying] = useState<boolean>(false);
  const [step, setStep] = useState<DeployStep>("network");
  const [selectedChain, setSelectedChain] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const res = await fetch("/api/user/safe");
        if (!res.ok) {
          if (!cancelled) {
            toast.error("Failed to load Safe wallets");
          }
          return;
        }
        const data = (await res.json()) as ListResponse;
        if (cancelled) {
          return;
        }
        const deployedChainIds = new Set(data.safes.map((s) => s.chainId));
        setDeployableChainIds(
          data.supportedChainIds.filter((id) => !deployedChainIds.has(id))
        );
      } catch {
        if (!cancelled) {
          toast.error("Failed to load Safe wallets");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };
    load().catch(() => {
      // load() already toasts the user.
    });
    return (): void => {
      cancelled = true;
    };
  }, []);

  const chainIdNumber = Number.parseInt(selectedChain, 10);
  const hasValidChain = Number.isFinite(chainIdNumber);
  const currentStep: DeployStep = deploying ? "deploying" : step;

  const handleDeploy = async (
    chainId: number,
    policyConfig: PolicyConfig | null
  ): Promise<void> => {
    setDeploying(true);
    try {
      const result = await postDeploy(chainId, policyConfig);
      if (result.ok) {
        onComplete();
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Safe deployment failed"
      );
    } finally {
      setDeploying(false);
    }
  };

  const handleNetworkContinue = (): void => {
    if (!hasValidChain) {
      toast.error("Select a network");
      return;
    }
    setStep("policies");
  };

  const handleConfirmWithPolicies = async (
    config: PolicyConfig
  ): Promise<void> => {
    if (!hasValidChain) {
      toast.error("Select a network");
      return;
    }
    await handleDeploy(chainIdNumber, config);
  };

  const handleSimulateDeploy = async (
    config: PolicyConfig
  ): Promise<SimulationPlan | null> => {
    if (!hasValidChain) {
      throw new Error("Select a network before simulating");
    }
    const res = await fetch("/api/user/safe/simulate-deploy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chainId: chainIdNumber,
        protocols: config.protocols,
      }),
    });
    const data = (await res.json()) as SimulationPlan | { error?: string };
    if (!res.ok || "error" in data) {
      const message =
        "error" in data
          ? (data.error ?? "Simulation failed")
          : "Simulation failed";
      throw new Error(message);
    }
    return data as SimulationPlan;
  };

  const handlePolicyStepChange = (s: "configure" | "review"): void => {
    setStep(s === "review" ? "review" : "policies");
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-6">
        <Spinner />
      </div>
    );
  }

  if (deployableChainIds.length === 0) {
    return (
      <p className="text-muted-foreground text-xs">
        Safes deployed on every supported chain.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <StepIndicator current={currentStep} />

      {step === "network" && (
        <div className="space-y-2">
          <Label className="text-xs" htmlFor="safe-deploy-flow-chain">
            Network
          </Label>
          <Select
            disabled={deploying}
            onValueChange={setSelectedChain}
            value={selectedChain}
          >
            <SelectTrigger id="safe-deploy-flow-chain">
              <SelectValue placeholder="Select a network" />
            </SelectTrigger>
            <SelectContent>
              {(() => {
                const { mainnets, testnets } =
                  partitionChainsByNetworkClass(deployableChainIds);
                return (
                  <>
                    {mainnets.length > 0 && (
                      <SelectGroup>
                        <SelectLabel className="font-medium text-[10px] text-keeperhub-green/80 uppercase tracking-wide">
                          Mainnet
                        </SelectLabel>
                        {mainnets.map((id) => (
                          <SelectItem key={id} value={id.toString()}>
                            {chainLabel(id)}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    )}
                    {testnets.length > 0 && (
                      <SelectGroup>
                        <SelectLabel className="font-medium text-[10px] text-keeperhub-green/80 uppercase tracking-wide">
                          Testnet
                        </SelectLabel>
                        {testnets.map((id) => (
                          <SelectItem key={id} value={id.toString()}>
                            {chainLabel(id)}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    )}
                  </>
                );
              })()}
            </SelectContent>
          </Select>
        </div>
      )}

      {(step === "policies" || step === "review") && hasValidChain && (
        <PolicyWizard
          chainId={chainIdNumber}
          confirmLabel={
            deploying ? "Deploying..." : "Deploy + install policies"
          }
          defaultEnabledSlugs={WIZARD_DEFAULT_PROTOCOLS}
          onCancel={() => setStep("network")}
          onConfirm={handleConfirmWithPolicies}
          onStepChange={handlePolicyStepChange}
          simulate={handleSimulateDeploy}
          submitting={deploying}
        />
      )}

      {step === "network" && (
        <div className="flex justify-end gap-2 pt-1">
          <Button
            disabled={deploying}
            onClick={onCancel}
            type="button"
            variant="ghost"
          >
            Cancel
          </Button>
          <Button
            disabled={deploying || !selectedChain}
            onClick={handleNetworkContinue}
            type="button"
          >
            Continue
          </Button>
        </div>
      )}
    </div>
  );
}
