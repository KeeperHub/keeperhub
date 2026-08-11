"use client";

import { ExternalLinkIcon } from "lucide-react";
import Image from "next/image";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

/**
 * Token picker dialog used from inside the policy wizard's per-protocol
 * card. Merges system-wide `supported_tokens` and the org's custom
 * `organization_tokens` for the selected chain, with a fallback flow to
 * paste a raw ERC20 address which calls `POST /api/user/wallet/tokens`.
 *
 * Returns the selected token to the caller via `onSelect`. The caller is
 * responsible for opening the dialog, passing the chain id, and filtering
 * out tokens already added to the protocol.
 */

export type PickedToken = {
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  name?: string | null;
  logoUrl?: string | null;
  explorerUrl?: string | null;
  available: boolean;
};

type SupportedTokenRow = {
  id: string;
  chainId: number;
  tokenAddress: string;
  symbol: string;
  name: string;
  decimals: number;
  logoUrl?: string | null;
  isStablecoin?: boolean;
  sortOrder?: number;
  available?: boolean;
  explorerUrl?: string | null;
};

type OrgTokenRow = {
  id: string;
  chainId: number;
  tokenAddress: string;
  symbol: string;
  name: string;
  decimals: number;
  logoUrl?: string | null;
};

type TokenPickerProps = {
  chainId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (token: PickedToken) => void;
  /** Token addresses (lowercase) already picked and therefore hidden */
  excludeAddresses?: readonly string[];
};

const ERC20_ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;

function truncateAddress(addr: string): string {
  if (addr.length < 12) {
    return addr;
  }
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export function TokenPicker({
  chainId,
  open,
  onOpenChange,
  onSelect,
  excludeAddresses = [],
}: TokenPickerProps): React.ReactElement {
  const [query, setQuery] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [supported, setSupported] = useState<SupportedTokenRow[]>([]);
  const [orgTokens, setOrgTokens] = useState<OrgTokenRow[]>([]);
  const [showCustomForm, setShowCustomForm] = useState<boolean>(false);
  const [customAddress, setCustomAddress] = useState<string>("");
  const [submittingCustom, setSubmittingCustom] = useState<boolean>(false);

  const exclude = useMemo(
    () => new Set(excludeAddresses.map((a) => a.toLowerCase())),
    [excludeAddresses]
  );

  const fetchTokens = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const [supportedRes, orgRes] = await Promise.all([
        fetch(`/api/supported-tokens?chainId=${chainId}`, {
          credentials: "include",
        }),
        fetch("/api/user/wallet/tokens", { credentials: "include" }),
      ]);
      if (!supportedRes.ok) {
        throw new Error("Failed to load supported tokens");
      }
      if (!orgRes.ok) {
        throw new Error("Failed to load org tokens");
      }
      const supportedJson = (await supportedRes.json()) as {
        tokens?: SupportedTokenRow[];
      };
      const orgJson = (await orgRes.json()) as { tokens?: OrgTokenRow[] };
      setSupported(supportedJson.tokens ?? []);
      setOrgTokens((orgJson.tokens ?? []).filter((t) => t.chainId === chainId));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not load tokens");
    } finally {
      setLoading(false);
    }
  }, [chainId]);

  useEffect(() => {
    if (!open) {
      return;
    }
    setQuery("");
    setShowCustomForm(false);
    setCustomAddress("");
    fetchTokens().catch(() => {
      // fetchTokens already surfaces errors via toast
    });
  }, [open, fetchTokens]);

  const merged: PickedToken[] = useMemo(() => {
    const seen = new Set<string>();
    const rows: PickedToken[] = [];
    for (const t of supported) {
      const key = t.tokenAddress.toLowerCase();
      if (seen.has(key) || exclude.has(key)) {
        continue;
      }
      if (t.available === false) {
        continue;
      }
      seen.add(key);
      rows.push({
        tokenAddress: t.tokenAddress,
        tokenSymbol: t.symbol,
        tokenDecimals: t.decimals,
        name: t.name,
        logoUrl: t.logoUrl ?? null,
        explorerUrl: t.explorerUrl ?? null,
        available: t.available ?? true,
      });
    }
    for (const t of orgTokens) {
      const key = t.tokenAddress.toLowerCase();
      if (seen.has(key) || exclude.has(key)) {
        continue;
      }
      seen.add(key);
      rows.push({
        tokenAddress: t.tokenAddress,
        tokenSymbol: t.symbol,
        tokenDecimals: t.decimals,
        name: t.name,
        logoUrl: t.logoUrl ?? null,
        explorerUrl: null,
        available: true,
      });
    }
    return rows;
  }, [supported, orgTokens, exclude]);

  const filtered: PickedToken[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return merged;
    }
    return merged.filter(
      (t) =>
        t.tokenSymbol.toLowerCase().includes(q) ||
        t.name?.toLowerCase().includes(q) ||
        t.tokenAddress.toLowerCase().includes(q)
    );
  }, [merged, query]);

  const handlePickExisting = (token: PickedToken): void => {
    onSelect(token);
    onOpenChange(false);
  };

  const handleAddCustom = async (): Promise<void> => {
    const addr = customAddress.trim();
    if (!ERC20_ADDRESS_REGEX.test(addr)) {
      toast.error("Enter a valid 0x ERC20 address");
      return;
    }
    setSubmittingCustom(true);
    try {
      const res = await fetch("/api/user/wallet/tokens", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chainId, tokenAddress: addr }),
      });
      const json = (await res.json()) as {
        token?: OrgTokenRow;
        error?: string;
      };
      if (!(res.ok && json.token)) {
        throw new Error(json.error ?? "Failed to add token");
      }
      const token: PickedToken = {
        tokenAddress: json.token.tokenAddress,
        tokenSymbol: json.token.symbol,
        tokenDecimals: json.token.decimals,
        name: json.token.name,
        logoUrl: json.token.logoUrl ?? null,
        explorerUrl: null,
        available: true,
      };
      toast.success(`Added ${token.tokenSymbol}`);
      onSelect(token);
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not add token");
    } finally {
      setSubmittingCustom(false);
    }
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Pick a token</DialogTitle>
          <DialogDescription>
            Tokens below are available on this chain. If you need something
            custom, paste its contract address.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by symbol, name, or address"
            value={query}
          />
          <div className="thin-scrollbar max-h-80 space-y-1 overflow-y-auto rounded-md border p-1">
            {loading && (
              <div className="flex items-center justify-center py-6">
                <Spinner className="h-5 w-5" />
              </div>
            )}
            {!loading && filtered.length === 0 && (
              <div className="py-6 text-center text-muted-foreground text-xs">
                No matching tokens. Use Paste custom address below.
              </div>
            )}
            {!loading &&
              filtered.map((t) => (
                <button
                  className="flex w-full items-center gap-3 rounded px-2 py-2 text-left text-sm hover:bg-muted/40"
                  key={t.tokenAddress}
                  onClick={() => handlePickExisting(t)}
                  type="button"
                >
                  {t.logoUrl ? (
                    <Image
                      alt={t.tokenSymbol}
                      className="h-8 w-8 shrink-0 rounded-full bg-muted"
                      height={32}
                      src={t.logoUrl}
                      width={32}
                    />
                  ) : (
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted font-medium text-xs">
                      {t.tokenSymbol.slice(0, 3)}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{t.tokenSymbol}</span>
                      {t.name && (
                        <span className="truncate text-muted-foreground text-xs">
                          {t.name}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-muted-foreground text-xs">
                      <span className="font-mono">
                        {truncateAddress(t.tokenAddress)}
                      </span>
                      {t.explorerUrl && (
                        <a
                          className="inline-flex items-center gap-1 hover:text-foreground"
                          href={t.explorerUrl}
                          onClick={(e) => e.stopPropagation()}
                          rel="noopener noreferrer"
                          target="_blank"
                        >
                          <ExternalLinkIcon className="h-3 w-3" />
                          Verify
                        </a>
                      )}
                    </div>
                  </div>
                </button>
              ))}
          </div>

          {showCustomForm ? (
            <div className="space-y-2 rounded-md border bg-muted/20 p-3">
              <div className="text-xs">
                Paste an ERC20 contract address for this chain. We will read the
                symbol, name, and decimals on-chain and save it to your org.
              </div>
              <Input
                onChange={(e) => setCustomAddress(e.target.value)}
                placeholder="0x..."
                value={customAddress}
              />
              <div className="flex justify-end gap-2">
                <Button
                  disabled={submittingCustom}
                  onClick={() => {
                    setShowCustomForm(false);
                    setCustomAddress("");
                  }}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Cancel
                </Button>
                <Button
                  disabled={submittingCustom}
                  onClick={handleAddCustom}
                  size="sm"
                  type="button"
                >
                  {submittingCustom ? (
                    <Spinner className="h-4 w-4" />
                  ) : (
                    "Add token"
                  )}
                </Button>
              </div>
            </div>
          ) : (
            <Button
              onClick={() => setShowCustomForm(true)}
              type="button"
              variant="outline"
            >
              Paste custom address
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
