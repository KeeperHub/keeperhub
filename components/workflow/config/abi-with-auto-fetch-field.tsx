"use client";

import { ethers } from "ethers";
import { Copy, ExternalLink, Info } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { ChainResponse } from "@/app/api/chains/route";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { TemplateBadgeTextarea } from "@/components/ui/template-badge-textarea";
import { toChecksumAddress, truncateAddress } from "@/lib/address-utils";
import { buildAddressUrl } from "@/lib/build-explorer-url";
import type { ActionConfigFieldBase } from "@/plugins/registry";

const AUTO_FETCH_DEBOUNCE_MS = 600;

type DiamondFacet = { address: string; name: string | null };

type AbiFetchResponse = {
  success?: boolean;
  abi?: string;
  diamondProxyAbi?: string;
  isProxy?: boolean;
  isDiamond?: boolean;
  implementationAddress?: string;
  implementationAbi?: string;
  proxyAddress?: string;
  proxyAbi?: string;
  facets?: DiamondFacet[];
  warning?: string;
  error?: string;
};

type DiamondReadAsProxy = { address: string; abi: string };

type AbiFetchCallbacks = {
  onDiamondSuccess: (
    abi: string,
    facets: DiamondFacet[],
    warning: string | null,
    readAsProxy: DiamondReadAsProxy | null
  ) => void;
  onProxyContract: (data: {
    implementationAddress: string;
    proxyAddress?: string;
    abi: string;
    proxyAbi?: string;
    warning?: string;
  }) => void;
  onChange: (value: unknown) => void;
};

function applyDiamondResponse(
  data: AbiFetchResponse,
  response: Response,
  onDiamondSuccess: AbiFetchCallbacks["onDiamondSuccess"]
): void {
  const combinedAbi = data.abi ?? data.diamondProxyAbi;
  if (!(response.ok && data.success && combinedAbi)) {
    throw new Error(data.error || "Failed to fetch ABI from Etherscan");
  }
  const readAsProxy: DiamondReadAsProxy | null =
    data.implementationAddress && data.implementationAbi
      ? { address: data.implementationAddress, abi: data.implementationAbi }
      : null;
  onDiamondSuccess(
    combinedAbi,
    data.facets ?? [],
    data.warning ?? null,
    readAsProxy
  );
}

function applyAbiFetchResponse(
  data: AbiFetchResponse,
  response: Response,
  callbacks: AbiFetchCallbacks
): void {
  if (data.isDiamond) {
    applyDiamondResponse(data, response, callbacks.onDiamondSuccess);
    return;
  }

  if (!(response.ok && data.success && data.abi)) {
    throw new Error(data.error || "Failed to fetch ABI from Etherscan");
  }

  if (data.isProxy && data.implementationAddress) {
    callbacks.onProxyContract({
      implementationAddress: data.implementationAddress,
      proxyAddress: data.proxyAddress,
      abi: data.abi,
      proxyAbi: data.proxyAbi,
      warning: data.warning,
    });
  } else {
    callbacks.onChange(data.abi);
  }
}

type DiamondAbiSourceChoiceProps = {
  readAsProxy: DiamondReadAsProxy;
  useDiamondAbi: boolean;
  onToggle: (useDiamond: boolean) => void;
  proxyOptionLabel: string;
  implementationExplorerUrl: string | null;
};

function DiamondAbiSourceChoice({
  readAsProxy,
  useDiamondAbi,
  onToggle,
  proxyOptionLabel,
  implementationExplorerUrl,
}: DiamondAbiSourceChoiceProps) {
  const checksummed = toChecksumAddress(readAsProxy.address);
  const addressLabel = truncateAddress(readAsProxy.address);

  return (
    <fieldset aria-label="ABI source" className="mt-2">
      <legend className="sr-only">ABI source</legend>
      <div className="grid grid-cols-2 gap-1 rounded-md border border-blue-200 bg-blue-100/50 p-1 dark:border-blue-800 dark:bg-blue-900/30">
        <Button
          aria-pressed={useDiamondAbi}
          className="h-8 min-w-0 text-sm"
          onClick={() => onToggle(true)}
          size="sm"
          type="button"
          variant={useDiamondAbi ? "default" : "ghost"}
        >
          Diamond Proxy
        </Button>
        <Button
          aria-pressed={!useDiamondAbi}
          className="h-8 min-w-0 text-sm"
          onClick={() => onToggle(false)}
          size="sm"
          title={`Implementation: ${checksummed}`}
          type="button"
          variant={useDiamondAbi ? "ghost" : "default"}
        >
          {proxyOptionLabel}
        </Button>
      </div>
      <p className="mt-1 flex min-h-7 items-center gap-0.5 text-muted-foreground text-xs">
        {useDiamondAbi ? (
          <>
            Combined ABI from all facets.
            <span aria-hidden className="h-7 w-7 shrink-0" />
          </>
        ) : (
          <>
            Implementation contract at {addressLabel}
            {implementationExplorerUrl ? (
              <Button
                asChild
                className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
                size="icon"
                variant="ghost"
              >
                <a
                  href={implementationExplorerUrl}
                  rel="noopener noreferrer"
                  target="_blank"
                  title={`View ${checksummed} on explorer`}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </Button>
            ) : (
              <span aria-hidden className="h-7 w-7 shrink-0" />
            )}
          </>
        )}
      </p>
    </fieldset>
  );
}

type DiamondFacetItemProps = {
  facet: DiamondFacet;
  explorerUrl: string | null;
};

function DiamondFacetItem({ facet, explorerUrl }: DiamondFacetItemProps) {
  const addressLabel = truncateAddress(facet.address);
  const checksummed = toChecksumAddress(facet.address);

  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(checksummed);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Failed to copy address");
    }
  };

  return (
    <li className="flex w-full items-center gap-2 rounded px-1.5 py-0.5 odd:bg-blue-100/50 dark:odd:bg-blue-900/20">
      <span>{facet.name ?? "Unnamed"}</span>
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        <span className="text-muted-foreground text-xs">({addressLabel})</span>
        <Button
          className="h-7 w-7 text-muted-foreground hover:text-foreground"
          onClick={copyAddress}
          size="icon"
          type="button"
          variant="ghost"
        >
          <Copy className="h-3.5 w-3.5" />
        </Button>
        {explorerUrl && (
          <Button
            asChild
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            size="icon"
            variant="ghost"
          >
            <a
              href={explorerUrl}
              rel="noopener noreferrer"
              target="_blank"
              title="View on explorer"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </Button>
        )}
      </div>
    </li>
  );
}

function getExplorerAddressUrl(
  network: string,
  chains: ChainResponse[],
  address: string
): string | null {
  const chainIdNum =
    typeof network === "string" ? Number.parseInt(network, 10) : network;
  if (Number.isNaN(chainIdNum) || chains.length === 0) {
    return null;
  }
  const chain = chains.find((c) => c.chainId === chainIdNum);
  if (!chain) {
    return null;
  }
  return buildAddressUrl(chain.explorerUrl, chain.explorerAddressPath, address);
}

type DiamondFacetsListProps = {
  facets: DiamondFacet[];
  network: string;
  chains: ChainResponse[];
};

function DiamondFacetsList({
  facets,
  network,
  chains,
}: DiamondFacetsListProps) {
  return (
    <div className="mt-3 w-full">
      <span className="font-medium text-blue-900 text-sm dark:text-blue-100">
        Facets
      </span>
      <ul className="mt-1 list-inside list-disc space-y-0.5 text-blue-800 text-sm dark:text-blue-200">
        {facets.map((facet) => (
          <DiamondFacetItem
            explorerUrl={getExplorerAddressUrl(network, chains, facet.address)}
            facet={facet}
            key={facet.address}
          />
        ))}
      </ul>
    </div>
  );
}

type DiamondContractAlertProps = {
  facets: DiamondFacet[];
  warning: string | null;
  readAsProxy: DiamondReadAsProxy | null;
  useDiamondAbi: boolean;
  onToggle: (useDiamond: boolean) => void;
  proxyOptionLabel: string;
  network: string;
  chains: ChainResponse[];
};

function DiamondContractAlert({
  facets,
  warning,
  readAsProxy,
  useDiamondAbi,
  onToggle,
  proxyOptionLabel,
  network,
  chains,
}: DiamondContractAlertProps) {
  return (
    <Alert className="border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-950">
      <Info className="h-4 w-4 text-blue-600 dark:text-blue-400" />
      <AlertTitle className="text-blue-900 dark:text-blue-100">
        Diamond Contract (EIP-2535) Detected
      </AlertTitle>
      <AlertDescription className="text-blue-800 dark:text-blue-200">
        <p className="text-sm">Choose how to interact with this contract:</p>
        {readAsProxy ? (
          <DiamondAbiSourceChoice
            implementationExplorerUrl={getExplorerAddressUrl(
              network,
              chains,
              readAsProxy.address
            )}
            onToggle={onToggle}
            proxyOptionLabel={proxyOptionLabel}
            readAsProxy={readAsProxy}
            useDiamondAbi={useDiamondAbi}
          />
        ) : (
          <p className="mt-2 text-sm">
            Using combined ABI from all facets (Diamond Proxy).
          </p>
        )}
        {useDiamondAbi && (
          <DiamondFacetsList
            chains={chains}
            facets={facets}
            network={network}
          />
        )}
        {warning && (
          <p className="mt-2 text-amber-700 text-sm dark:text-amber-300">
            {warning}
          </p>
        )}
      </AlertDescription>
    </Alert>
  );
}

type ProxyContractAlertProps = {
  implementationAddress: string;
  network: string;
  proxyWarning: string | null;
  useProxyAbi: boolean;
  isLoading: boolean;
  chains: ChainResponse[];
  onToggleProxyAbi: (useProxy: boolean) => void;
};

function ProxyContractAlert({
  implementationAddress,
  network,
  proxyWarning,
  useProxyAbi,
  isLoading,
  chains,
  onToggleProxyAbi,
}: ProxyContractAlertProps) {
  const explorerUrl = useMemo(() => {
    if (!(network && implementationAddress) || chains.length === 0) {
      return null;
    }

    const chainIdNum =
      typeof network === "string" ? Number.parseInt(network, 10) : network;

    if (Number.isNaN(chainIdNum)) {
      return null;
    }

    const chain = chains.find((c) => c.chainId === chainIdNum);
    if (
      chain?.explorerUrl &&
      chain?.explorerAddressPath &&
      implementationAddress
    ) {
      const path = chain.explorerAddressPath.replace(
        "{address}",
        implementationAddress
      );
      return `${chain.explorerUrl}${path}`;
    }

    return null;
  }, [network, implementationAddress, chains]);

  return (
    <Alert className="border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-950">
      <Info className="h-4 w-4 text-blue-600 dark:text-blue-400" />
      <AlertTitle className="text-blue-900 dark:text-blue-100">
        Proxy Contract Detected
      </AlertTitle>
      <AlertDescription className="text-blue-800 dark:text-blue-200">
        <div className="mt-1 space-y-2">
          <p>
            Using implementation ABI from{" "}
            <code className="rounded bg-blue-100 px-1 py-0.5 text-xs dark:bg-blue-900">
              {`${implementationAddress.slice(0, 6)}...${implementationAddress.slice(-4)}`}
            </code>
            {explorerUrl && (
              <a
                className="ml-1.5 inline-flex items-center text-blue-700 underline hover:text-blue-800 dark:text-blue-300 dark:hover:text-blue-200"
                href={explorerUrl}
                rel="noopener noreferrer"
                target="_blank"
              >
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </p>
          {proxyWarning && (
            <p className="text-amber-700 dark:text-amber-300">{proxyWarning}</p>
          )}
          <div className="flex items-center gap-2">
            <Button
              className="h-auto p-0 text-blue-700 underline dark:text-blue-300"
              disabled={isLoading}
              onClick={() => onToggleProxyAbi(!useProxyAbi)}
              size="sm"
              variant="link"
            >
              {useProxyAbi
                ? "Use implementation ABI instead"
                : "Use proxy ABI instead"}
            </Button>
          </div>
        </div>
      </AlertDescription>
    </Alert>
  );
}

type FieldProps = {
  field: ActionConfigFieldBase;
  value: string;
  onChange: (value: unknown) => void;
  disabled?: boolean;
};

type AbiWithAutoFetchProps = FieldProps & {
  contractAddressField?: string;
  contractInteractionType?: "read" | "write";
  networkField?: string;
  config: Record<string, unknown>;
  // Required: the manual-ABI checkbox is fully controlled by config.useManualAbi,
  // so without this the toggle would have no way to persist a user's choice.
  onUpdateConfig: (key: string, value: unknown) => void;
};

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: ABI field handles proxy, diamond, and read/write-as-proxy states with toggles
export function AbiWithAutoFetchField({
  field,
  value,
  onChange,
  disabled,
  contractAddressField = "contractAddress",
  contractInteractionType,
  networkField = "network",
  config,
  onUpdateConfig,
}: AbiWithAutoFetchProps) {
  // Derived directly from config on every render (not mirrored into local
  // state) so the checkbox can never drift from the persisted value: it only
  // ever changes when the user toggles it (via onUpdateConfig) or when the
  // config prop itself changes, e.g. after a reload.
  const useManualAbi = String(config.useManualAbi) === "true";
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isProxy, setIsProxy] = useState(false);
  const [implementationAddress, setImplementationAddress] = useState<
    string | null
  >(null);
  const [proxyAddress, setProxyAddress] = useState<string | null>(null);
  const [useProxyAbi, setUseProxyAbi] = useState(false);
  const [proxyWarning, setProxyWarning] = useState<string | null>(null);
  const [proxyAbi, setProxyAbi] = useState<string | null>(null);
  const [implementationAbi, setImplementationAbi] = useState<string | null>(
    null
  );
  // Diamond contract state
  const [isDiamond, setIsDiamond] = useState(false);
  const [diamondFacets, setDiamondFacets] = useState<DiamondFacet[] | null>(
    null
  );
  const [diamondWarning, setDiamondWarning] = useState<string | null>(null);
  const [diamondCombinedAbi, setDiamondCombinedAbi] = useState<string | null>(
    null
  );
  const [diamondReadAsProxy, setDiamondReadAsProxy] =
    useState<DiamondReadAsProxy | null>(null);
  const [useDiamondAbi, setUseDiamondAbi] = useState(true);
  const [chains, setChains] = useState<ChainResponse[]>([]);

  const proxyOptionLabel =
    contractInteractionType === "write" ? "Write as Proxy" : "Read as Proxy";

  const contractAddress = (config[contractAddressField] as string) || "";
  const network = (config[networkField] as string) || "";

  // Fetch chains once on mount
  useEffect(() => {
    async function fetchChains() {
      try {
        const response = await fetch("/api/chains");
        const data = (await response.json()) as ChainResponse[];
        setChains(data);
      } catch (err) {
        console.error("Failed to fetch chains:", err);
      }
    }

    fetchChains();
  }, []);

  // Sync ABI when toggle state changes for regular proxies
  const lastUseProxyAbiRef = useRef<boolean | null>(null);
  // Sync ABI when Diamond Proxy vs Read/Write as Proxy toggle changes
  const lastUseDiamondAbiRef = useRef<boolean | null>(null);

  // Track last fetched (contract, network) so we only auto-fetch when they change.
  // If the ABI is already populated on mount, seed with the current pair so we
  // don't needlessly refetch when the user clicks back into the node.
  const lastFetchedRef = useRef<{
    contractAddress: string;
    network: string;
  } | null>(
    value && contractAddress && network ? { contractAddress, network } : null
  );
  const currentTargetRef = useRef<{
    contractAddress: string;
    network: string;
  } | null>(null);
  const performAbiFetchRef = useRef<(() => Promise<void>) | null>(null);

  const abiToString = useCallback((abi: string | null): string | null => {
    if (!abi) {
      return null;
    }
    return typeof abi === "string" ? abi : JSON.stringify(abi);
  }, []);

  const getAbiForToggle = useCallback((): string | null => {
    if (useProxyAbi) {
      return abiToString(proxyAbi);
    }
    return abiToString(implementationAbi);
  }, [useProxyAbi, proxyAbi, implementationAbi, abiToString]);

  useEffect(() => {
    if (!isProxy || isDiamond || !implementationAddress) {
      return;
    }

    // Only sync if the toggle state actually changed
    if (lastUseProxyAbiRef.current === useProxyAbi) {
      return;
    }

    lastUseProxyAbiRef.current = useProxyAbi;

    const abiString = getAbiForToggle();
    if (abiString) {
      onChange(abiString);
    }
  }, [
    useProxyAbi,
    isProxy,
    isDiamond,
    implementationAddress,
    onChange,
    getAbiForToggle,
  ]);

  useEffect(() => {
    if (!(isDiamond && diamondCombinedAbi && diamondReadAsProxy)) {
      return;
    }
    if (lastUseDiamondAbiRef.current === useDiamondAbi) {
      return;
    }
    lastUseDiamondAbiRef.current = useDiamondAbi;
    onChange(useDiamondAbi ? diamondCombinedAbi : diamondReadAsProxy.abi);
  }, [
    isDiamond,
    useDiamondAbi,
    diamondCombinedAbi,
    diamondReadAsProxy,
    onChange,
  ]);

  const handleDiamondToggle = useCallback((useDiamond: boolean) => {
    setUseDiamondAbi(useDiamond);
  }, []);

  // Validate contract address
  const isValidAddress = useMemo(() => {
    if (!contractAddress || contractAddress.trim() === "") {
      return false;
    }
    try {
      return ethers.isAddress(contractAddress);
    } catch {
      return false;
    }
  }, [contractAddress]);

  const resetProxyState = useCallback(() => {
    setIsProxy(false);
    setImplementationAddress(null);
    setProxyAddress(null);
    setUseProxyAbi(false);
    setProxyWarning(null);
    setProxyAbi(null);
    setImplementationAbi(null);
    setIsDiamond(false);
    setDiamondFacets(null);
    setDiamondWarning(null);
    setDiamondCombinedAbi(null);
    setDiamondReadAsProxy(null);
    setUseDiamondAbi(true);
    lastUseDiamondAbiRef.current = null;
  }, []);

  const handleDiamondSuccess = useCallback(
    (
      abi: string,
      facets: DiamondFacet[],
      warning: string | null,
      readAsProxy: DiamondReadAsProxy | null
    ) => {
      setIsDiamond(true);
      setDiamondFacets(facets);
      setDiamondWarning(warning);
      setDiamondCombinedAbi(abi);
      setDiamondReadAsProxy(readAsProxy);
      setUseDiamondAbi(true);
      lastUseDiamondAbiRef.current = true;
      onChange(abi);
    },
    [onChange]
  );

  const handleProxyContract = useCallback(
    (data: {
      implementationAddress: string;
      proxyAddress?: string;
      abi: string;
      proxyAbi?: string;
      warning?: string;
    }) => {
      setIsProxy(true);
      setImplementationAddress(data.implementationAddress);
      setProxyAddress(data.proxyAddress || contractAddress);
      setImplementationAbi(data.abi);
      setProxyAbi(data.proxyAbi || null);
      setProxyWarning(data.warning || null);

      // Always use implementation ABI by default when proxy is detected
      setUseProxyAbi(false);
      onChange(data.abi);
    },
    [contractAddress, onChange]
  );

  const performAbiFetch = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    resetProxyState();

    try {
      const response = await fetch("/api/web3/fetch-abi", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contractAddress,
          network,
        }),
      });

      const data = (await response.json()) as AbiFetchResponse;
      applyAbiFetchResponse(data, response, {
        onDiamondSuccess: handleDiamondSuccess,
        onProxyContract: handleProxyContract,
        onChange,
      });
      setError(null);
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Failed to fetch ABI";
      setError(errorMessage);
    } finally {
      setIsLoading(false);
    }
  }, [
    contractAddress,
    network,
    onChange,
    resetProxyState,
    handleDiamondSuccess,
    handleProxyContract,
  ]);

  // Auto-fetch ABI when contract address or network changes (debounced, once per pair).
  // performAbiFetch is stored in a ref and accessed via performAbiFetchRef.current inside
  // the effect. This avoids adding performAbiFetch to the dependency array, which would
  // cause the effect to re-run on every render and defeat the debounce logic.
  performAbiFetchRef.current = performAbiFetch;
  useEffect(() => {
    if (!(isValidAddress && network) || useManualAbi) {
      return;
    }

    currentTargetRef.current = { contractAddress, network };
    const last = lastFetchedRef.current;

    if (
      last?.contractAddress === contractAddress &&
      last?.network === network
    ) {
      return;
    }
    const timeoutId = setTimeout(() => {
      if (currentTargetRef.current) {
        lastFetchedRef.current = { ...currentTargetRef.current };
      }
      const fetchTarget = { contractAddress, network };
      const fn = performAbiFetchRef.current;
      if (fn) {
        fn().catch((err: unknown) => {
          // Only set error if the target hasn't changed since fetch started
          const current = currentTargetRef.current;
          if (
            current?.contractAddress === fetchTarget.contractAddress &&
            current?.network === fetchTarget.network
          ) {
            const message =
              err instanceof Error ? err.message : "Failed to fetch ABI";
            setError(message);
          }
        });
      }
    }, AUTO_FETCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timeoutId);
    };
  }, [contractAddress, network, isValidAddress, useManualAbi]);

  const fetchProxyAbi = useCallback(async (): Promise<string> => {
    if (!proxyAddress) {
      throw new Error("Proxy address not available");
    }

    const response = await fetch("/api/web3/fetch-abi", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contractAddress: proxyAddress,
        network,
      }),
    });

    const data = (await response.json()) as {
      success?: boolean;
      abi?: string;
      proxyAbi?: string;
      error?: string;
    };

    if (!(response.ok && data.success)) {
      throw new Error(data.error || "Failed to fetch proxy ABI");
    }

    const abiToUse = data.proxyAbi || data.abi;
    if (!abiToUse) {
      throw new Error("No ABI returned from API");
    }

    return abiToUse;
  }, [proxyAddress, network]);

  const handleToggleProxyAbi = async (useProxy: boolean) => {
    setUseProxyAbi(useProxy);

    if (!useProxy || proxyAbi || !proxyAddress) {
      return;
    }

    setIsLoading(true);
    try {
      const abi = await fetchProxyAbi();
      setProxyAbi(abi);
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Failed to fetch proxy ABI";
      console.error("[Proxy UI] Error:", errorMessage);
      setError(errorMessage);
      setUseProxyAbi(false);
    } finally {
      setIsLoading(false);
    }
  };

  const handleManualToggle = (checked: boolean) => {
    onUpdateConfig("useManualAbi", String(checked));
    setError(null);
    if (checked) {
      onChange("");
      resetProxyState();
    }
    // Reset last-fetched so the auto-fetch effect re-triggers when switching
    // back to automatic mode (unchecking manual ABI).
    lastFetchedRef.current = null;
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        {isLoading && <Spinner className="h-4 w-4" />}
        <Checkbox
          checked={useManualAbi}
          disabled={disabled}
          id={`${field.key}-manual`}
          onCheckedChange={handleManualToggle}
        />
        <Label
          className="cursor-pointer font-normal text-sm"
          htmlFor={`${field.key}-manual`}
        >
          Use manual ABI
        </Label>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-destructive text-sm">
          {error}
        </div>
      )}

      {isDiamond && diamondFacets && !useManualAbi && (
        <DiamondContractAlert
          chains={chains}
          facets={diamondFacets}
          network={network}
          onToggle={handleDiamondToggle}
          proxyOptionLabel={proxyOptionLabel}
          readAsProxy={diamondReadAsProxy}
          useDiamondAbi={useDiamondAbi}
          warning={diamondWarning}
        />
      )}

      {isProxy && !isDiamond && implementationAddress && (
        <ProxyContractAlert
          chains={chains}
          implementationAddress={implementationAddress}
          isLoading={isLoading}
          network={network}
          onToggleProxyAbi={handleToggleProxyAbi}
          proxyWarning={proxyWarning}
          useProxyAbi={useProxyAbi}
        />
      )}

      <TemplateBadgeTextarea
        className="max-h-40 overflow-y-auto"
        disabled={disabled || isLoading || !useManualAbi}
        id={field.key}
        // Do not include `value.length` in the key: it remounts the textarea
        // on every keystroke and kills focus mid-word. Parent-driven value
        // changes are already synced via TemplateBadgeTextarea's effect when
        // the field is blurred.
        key={`${field.key}-${useProxyAbi ? "proxy" : "impl"}${isDiamond ? `-${useDiamondAbi ? "diamond" : "proxy"}` : ""}`}
        maxRows={4}
        onChange={(val) => {
          onChange(val);
          setError(null);
        }}
        placeholder={
          useManualAbi
            ? "Paste your ABI here"
            : "ABI will be fetched automatically when a contract address and network are set"
        }
        rows={4}
        value={value}
      />
    </div>
  );
}
