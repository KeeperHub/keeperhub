"use client";

import {
  Copy,
  Eye,
  EyeOff,
  ExternalLink,
  Info,
  KeyRound,
  Plus,
  RefreshCw,
  SendHorizontal,
  Shield,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import Image from "next/image";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Overlay } from "@/components/overlays/overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { toChecksumAddress, truncateAddress } from "@/lib/address-utils";
import { useSession } from "@/lib/auth-client";
import { useActiveMember } from "@/lib/hooks/use-organization";
import { fetchAllSupportedTokenBalances } from "@/lib/wallet/fetch-balances";
import type {
  ChainBalance,
  ChainData,
  SupportedToken,
  SupportedTokenBalance,
  TokenBalance,
  TokenData,
  WalletData,
} from "@/lib/wallet/types";
import { useWalletBalances } from "@/lib/wallet/use-wallet-balances";
import { ParaExportKeyButton } from "@/components/wallet/para-export-key-dynamic";
import type { WalletProvider } from "@/lib/wallet/types";
import { type WithdrawableAsset, WithdrawModal } from "./withdraw-modal";

type WalletOverlayProps = {
  overlayId: string;
};

// TEMPO uses stablecoins for gas, so we display stablecoins only (no native token)
const TEMPO_CHAIN_IDS = new Set([42_429, 4217]);
const isTempoChain = (chainId: number): boolean => TEMPO_CHAIN_IDS.has(chainId);
const MAINNET_CHAIN_ID = 1;

// ============================================================================
// Balance Display Components
// ============================================================================

function ChainBalanceDisplay({ balance }: { balance: ChainBalance }) {
  if (balance.loading) {
    return <div className="mt-1 text-muted-foreground text-xs">Loading...</div>;
  }
  if (balance.error) {
    return <div className="mt-1 text-destructive text-xs">{balance.error}</div>;
  }
  return (
    <div className="mt-1 text-muted-foreground text-xs">
      {balance.balance} {balance.symbol}
    </div>
  );
}

// Token item with withdraw and optional delete button
function TokenItemWithActions({
  token,
  isAdmin,
  isCustom,
  customExplorerUrl,
  onDelete,
  onWithdraw,
}: {
  token: SupportedTokenBalance | TokenBalance;
  isAdmin: boolean;
  isCustom?: boolean;
  customExplorerUrl?: string | null;
  onDelete?: (tokenId: string, symbol: string) => void;
  onWithdraw: (chainId: number, tokenAddress: string) => void;
}) {
  // Type guard to check if it's a SupportedTokenBalance (has logoUrl)
  const isSupportedToken = (
    t: SupportedTokenBalance | TokenBalance
  ): t is SupportedTokenBalance => "logoUrl" in t;

  const supportedToken = isSupportedToken(token) ? token : null;
  const customToken = isSupportedToken(token) ? null : token;

  const isUnavailable = supportedToken?.available === false;
  const numBalance = Number.parseFloat(token.balance);
  const hasBalance = Number.isFinite(numBalance) && numBalance > 0;

  // Both types now have tokenAddress
  const tokenAddress =
    supportedToken?.tokenAddress || customToken?.tokenAddress;

  // Explorer URL: use supported token's URL or custom explorer URL for custom tokens
  const explorerUrl = supportedToken?.explorerUrl || customExplorerUrl;

  const copyTokenAddress = () => {
    if (tokenAddress) {
      navigator.clipboard.writeText(tokenAddress);
      toast.success("Token address copied");
    }
  };

  const renderBalance = () => {
    if (isUnavailable) {
      return <span className="italic">Not available</span>;
    }
    if (token.loading) {
      return <Spinner className="h-3 w-3" />;
    }
    if (token.error) {
      return <span className="text-destructive">{token.error}</span>;
    }
    return `${token.balance} ${token.symbol}`;
  };

  return (
    <div
      className={`flex items-center gap-2 py-1.5 ${isUnavailable ? "opacity-50" : ""}`}
    >
      {/* Logo: supported tokens show logo, custom tokens show $ */}
      {supportedToken?.logoUrl && (
        <Image
          alt={token.symbol}
          className={`h-4 w-4 rounded-full ${isUnavailable ? "grayscale" : ""}`}
          height={16}
          src={supportedToken.logoUrl}
          width={16}
        />
      )}
      {!supportedToken?.logoUrl && (
        <div className="flex h-4 w-4 items-center justify-center rounded-full bg-muted font-medium text-[10px]">
          $
        </div>
      )}
      <span className="font-medium text-xs">{token.symbol}</span>
      {/* Copy + explorer link for all tokens with addresses */}
      {!isUnavailable && tokenAddress && (
        <div className="flex items-center gap-1">
          <button
            aria-label="Copy token address"
            className="text-muted-foreground hover:text-foreground"
            onClick={copyTokenAddress}
            type="button"
          >
            <Copy className="h-3 w-3" />
          </button>
          {explorerUrl && (
            <a
              className="text-muted-foreground hover:text-foreground"
              href={explorerUrl}
              rel="noopener noreferrer"
              target="_blank"
              title="View on explorer"
            >
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      )}
      {/* Delete button for custom tokens - before balance */}
      {isAdmin && isCustom && customToken && onDelete && (
        <Button
          className="ml-auto h-6 w-6"
          onClick={() => onDelete(customToken.tokenId, customToken.symbol)}
          size="icon"
          title="Remove token"
          variant="ghost"
        >
          <Trash2 className="h-3 w-3 text-muted-foreground" />
        </Button>
      )}
      {/* Balance */}
      <span
        className={`text-muted-foreground text-xs ${isAdmin && isCustom ? "" : "ml-auto"}`}
      >
        {renderBalance()}
      </span>
      {/* Withdraw button for tokens with balance */}
      {isAdmin &&
        hasBalance &&
        !token.loading &&
        !isUnavailable &&
        tokenAddress && (
          <Button
            className="h-6 px-2 text-xs"
            onClick={() => onWithdraw(token.chainId, tokenAddress)}
            size="sm"
            variant="ghost"
          >
            <SendHorizontal className="h-3 w-3" />
          </Button>
        )}
    </div>
  );
}

// Helper to build explorer URL for a token address
function buildTokenExplorerUrl(
  chain: ChainData | undefined,
  tokenAddress: string
): string | null {
  if (!chain?.explorerUrl) {
    return null;
  }
  const path = chain.explorerAddressPath || "/address/{address}";
  return `${chain.explorerUrl}${path.replace("{address}", tokenAddress)}`;
}

function ChainBalanceItem({
  balance,
  chain,
  isAdmin,
  onRemoveToken,
  onWithdraw,
  supportedTokenBalances,
  tokenBalances,
}: {
  balance: ChainBalance;
  chain: ChainData | undefined;
  isAdmin: boolean;
  onRemoveToken: (tokenId: string, symbol: string) => void;
  onWithdraw: (chainId: number, tokenAddress?: string) => void;
  supportedTokenBalances: SupportedTokenBalance[];
  tokenBalances: TokenBalance[];
}) {
  const chainCustomTokens = tokenBalances.filter(
    (t) => t.chainId === balance.chainId
  );

  const isTempo = isTempoChain(balance.chainId);
  const isMainnet = balance.chainId === MAINNET_CHAIN_ID;

  // For TEMPO chains, just show their own tokens
  // For other chains, use mainnet tokens as the master list
  const chainSupportedTokens = (() => {
    if (isTempo) {
      return supportedTokenBalances.filter(
        (t) => t.chainId === balance.chainId
      );
    }

    // Get mainnet tokens as master list
    const mainnetTokens = supportedTokenBalances.filter(
      (t) => t.chainId === MAINNET_CHAIN_ID
    );

    // If viewing mainnet, just return mainnet tokens
    if (isMainnet) {
      return mainnetTokens;
    }

    // For other chains, map mainnet tokens with availability
    const chainTokensMap = new Map(
      supportedTokenBalances
        .filter((t) => t.chainId === balance.chainId)
        .map((t) => [t.symbol, t])
    );

    return mainnetTokens.map((mainnetToken) => {
      const chainToken = chainTokensMap.get(mainnetToken.symbol);
      if (chainToken) {
        // Token available on this chain
        return { ...chainToken, available: true };
      }
      // Token not available - show mainnet data with unavailable flag
      return { ...mainnetToken, available: false, balance: "N/A" };
    });
  })();

  // For non-TEMPO chains, check if native balance is withdrawable
  const nativeBalance = Number.parseFloat(balance.balance);
  const hasNativeBalance = Number.isFinite(nativeBalance) && nativeBalance > 0;

  // Determine section label based on whether there are custom tokens
  const tokenSectionLabel =
    chainCustomTokens.length > 0 ? "Tokens" : "Stablecoins";

  // For TEMPO, show tokens only (no native balance display)
  if (isTempo) {
    return (
      <div className="rounded-lg border bg-muted/50 p-3">
        <div className="mb-2 flex items-center gap-1">
          <span className="font-medium text-sm">TEMPO</span>
          {balance.explorerUrl && (
            <a
              className="text-muted-foreground hover:text-foreground"
              href={balance.explorerUrl}
              rel="noopener noreferrer"
              target="_blank"
            >
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
        <div className="mb-1 font-medium text-muted-foreground text-xs">
          {tokenSectionLabel}
        </div>
        {chainSupportedTokens.length > 0 || chainCustomTokens.length > 0 ? (
          <div className="divide-y rounded border bg-background/50 px-2">
            {/* Supported tokens (stablecoins) */}
            {chainSupportedTokens.map((token) => (
              <TokenItemWithActions
                isAdmin={isAdmin}
                key={`supported-${token.chainId}-${token.tokenAddress}`}
                onWithdraw={onWithdraw}
                token={token}
              />
            ))}
            {/* Custom tokens integrated in the same list */}
            {chainCustomTokens.map((token) => (
              <TokenItemWithActions
                customExplorerUrl={buildTokenExplorerUrl(
                  chain,
                  token.tokenAddress
                )}
                isAdmin={isAdmin}
                isCustom
                key={`custom-${token.tokenId}`}
                onDelete={onRemoveToken}
                onWithdraw={onWithdraw}
                token={token}
              />
            ))}
          </div>
        ) : (
          <div className="text-muted-foreground text-xs">Loading tokens...</div>
        )}
      </div>
    );
  }

  // Non-TEMPO chains: show native balance and tokens in same card
  return (
    <div className="rounded-lg border bg-muted/50 p-3">
      {/* Chain header with native balance */}
      <div className="flex items-center justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-1">
            <span className="font-medium text-sm">{balance.name}</span>
            {balance.explorerUrl && (
              <a
                className="text-muted-foreground hover:text-foreground"
                href={balance.explorerUrl}
                rel="noopener noreferrer"
                target="_blank"
              >
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
          <ChainBalanceDisplay balance={balance} />
        </div>
        {isAdmin && hasNativeBalance && (
          <Button
            className="h-7 px-2 text-xs"
            onClick={() => onWithdraw(balance.chainId)}
            size="sm"
            variant="ghost"
          >
            <SendHorizontal className="h-3 w-3" />
            Withdraw
          </Button>
        )}
      </div>
      {/* Tokens section (stablecoins + custom tokens combined) */}
      {(chainSupportedTokens.length > 0 || chainCustomTokens.length > 0) && (
        <div className="mt-3">
          <div className="mb-1 font-medium text-muted-foreground text-xs">
            {tokenSectionLabel}
          </div>
          <div className="divide-y rounded border bg-background/50 px-2">
            {/* Supported tokens (stablecoins) */}
            {chainSupportedTokens.map((token) => (
              <TokenItemWithActions
                isAdmin={isAdmin}
                key={`supported-${token.chainId}-${token.tokenAddress}`}
                onWithdraw={onWithdraw}
                token={token}
              />
            ))}
            {/* Custom tokens integrated in the same list */}
            {chainCustomTokens.map((token) => (
              <TokenItemWithActions
                customExplorerUrl={buildTokenExplorerUrl(
                  chain,
                  token.tokenAddress
                )}
                isAdmin={isAdmin}
                isCustom
                key={`custom-${token.tokenId}`}
                onDelete={onRemoveToken}
                onWithdraw={onWithdraw}
                token={token}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Form Components
// ============================================================================

function AddTokenForm({
  chains,
  onAdd,
  onCancel,
}: {
  chains: ChainData[];
  onAdd: (chainId: number, tokenAddress: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [chainId, setChainId] = useState<number | null>(null);
  const [tokenAddress, setTokenAddress] = useState("");
  const [adding, setAdding] = useState(false);

  const handleAdd = async () => {
    if (!(chainId && tokenAddress)) {
      toast.error("Please select a chain and enter a token address");
      return;
    }
    setAdding(true);
    try {
      await onAdd(chainId, tokenAddress);
      setChainId(null);
      setTokenAddress("");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to add token"
      );
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label>Chain</Label>
        <Select
          onValueChange={(value) => setChainId(Number.parseInt(value, 10))}
          value={chainId?.toString() ?? ""}
        >
          <SelectTrigger>
            <SelectValue placeholder="Select chain" />
          </SelectTrigger>
          <SelectContent>
            {chains.map((chain) => (
              <SelectItem key={chain.chainId} value={chain.chainId.toString()}>
                {chain.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label>Token Address</Label>
        <Input
          disabled={adding}
          onChange={(e) => setTokenAddress(e.target.value)}
          placeholder="0x..."
          value={tokenAddress}
        />
      </div>
      <div className="flex gap-2">
        <Button
          className="flex-1"
          disabled={adding}
          onClick={onCancel}
          variant="outline"
        >
          Cancel
        </Button>
        <Button
          className="flex-1"
          disabled={adding || !chainId || !tokenAddress}
          onClick={handleAdd}
        >
          {adding ? (
            <>
              <Spinner className="mr-2 h-4 w-4" />
              Adding...
            </>
          ) : (
            "Add Token"
          )}
        </Button>
      </div>
    </div>
  );
}

type WalletProviderOption = "para" | "turnkey";

function CreateWalletForm({
  initialEmail,
  onSubmit,
}: {
  initialEmail: string;
  onSubmit: (email: string, provider: WalletProviderOption) => Promise<void>;
}) {
  const [email, setEmail] = useState(initialEmail);
  const [provider, setProvider] = useState<WalletProviderOption>("turnkey");
  const [creating, setCreating] = useState(false);

  const handleCreate = async (): Promise<void> => {
    if (!email) {
      toast.error("Email is required");
      return;
    }
    setCreating(true);
    try {
      await onSubmit(email, provider);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to create wallet"
      );
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-4 rounded-lg border bg-muted/50 p-4">
        <div>
          <h3 className="mb-2 font-medium text-sm">
            Create Organization Wallet
          </h3>
          <p className="mb-4 text-muted-foreground text-xs">
            This wallet will be shared by all members of your organization. Only
            admins and owners can manage it.
          </p>
        </div>

        <div className="space-y-2">
          <Label>Wallet Provider</Label>
          <div className="grid grid-cols-2 gap-2">
            <button
              className={`flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors ${
                provider === "turnkey"
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-border/80"
              }`}
              disabled={creating}
              onClick={() => setProvider("turnkey")}
              type="button"
            >
              <div className="flex items-center gap-1.5">
                <ShieldCheck className="h-3.5 w-3.5 text-primary" />
                <span className="font-medium text-xs">Turnkey</span>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger
                      asChild
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Info className="size-3 text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent className="text-xs" side="top">
                      <a
                        className="underline"
                        href="https://www.turnkey.com"
                        rel="noopener noreferrer"
                        target="_blank"
                      >
                        Website
                      </a>
                      {" · "}
                      <a
                        className="underline"
                        href="https://docs.keeperhub.com/wallet-management/turnkey"
                        rel="noopener noreferrer"
                        target="_blank"
                      >
                        Docs
                      </a>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              <span className="text-muted-foreground text-[10px] leading-tight">
                Secure enclave. Supports private key export.
              </span>
            </button>
            <button
              className={`flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors ${
                provider === "para"
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-border/80"
              }`}
              disabled={creating}
              onClick={() => setProvider("para")}
              type="button"
            >
              <div className="flex items-center gap-1.5">
                <Shield className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="font-medium text-xs">Para</span>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger
                      asChild
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Info className="size-3 text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent className="text-xs" side="top">
                      <a
                        className="underline"
                        href="https://www.getpara.com"
                        rel="noopener noreferrer"
                        target="_blank"
                      >
                        Website
                      </a>
                      {" · "}
                      <a
                        className="underline"
                        href="https://docs.keeperhub.com/wallet-management/para"
                        rel="noopener noreferrer"
                        target="_blank"
                      >
                        Docs
                      </a>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              <span className="text-muted-foreground text-[10px] leading-tight">
                MPC-based signing. No key export.
              </span>
            </button>
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="wallet-email">Email Address</Label>
          <Input
            disabled={creating}
            id="wallet-email"
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            type="email"
            value={email}
          />
          <p className="text-muted-foreground text-xs">
            This email will be associated with the organization's wallet for
            identification purposes.
          </p>
        </div>
      </div>
      <div className="flex gap-2">
        <Button
          className="flex-1"
          disabled={creating || !email}
          onClick={handleCreate}
        >
          {creating ? (
            <>
              <Spinner className="mr-2 h-4 w-4" />
              Creating...
            </>
          ) : (
            "Create Wallet"
          )}
        </Button>
      </div>
    </div>
  );
}

// ============================================================================
// Section Components
// ============================================================================

function BalanceListSection({
  balances,
  chains,
  isAdmin,
  onAddToken,
  onRefresh,
  onRemoveToken,
  onWithdraw,
  refreshing,
  showAddToken,
  setShowAddToken,
  supportedTokenBalances,
  tokenBalances,
}: {
  balances: ChainBalance[];
  chains: ChainData[];
  isAdmin: boolean;
  onAddToken: (chainId: number, tokenAddress: string) => Promise<void>;
  onRefresh: () => void;
  onRemoveToken: (tokenId: string, symbol: string) => void;
  onWithdraw: (chainId: number, tokenAddress?: string) => void;
  refreshing: boolean;
  showAddToken: boolean;
  setShowAddToken: (show: boolean) => void;
  supportedTokenBalances: SupportedTokenBalance[];
  tokenBalances: TokenBalance[];
}) {
  const [showTestnets, setShowTestnets] = useState(false);
  const filteredBalances = balances.filter((b) =>
    showTestnets ? b.isTestnet : !b.isTestnet
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-medium text-sm">Balances</h3>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md border">
            <Button
              className="h-7 rounded-r-none border-0 px-3 text-xs"
              onClick={() => setShowTestnets(false)}
              size="sm"
              variant={showTestnets ? "ghost" : "default"}
            >
              Mainnets
            </Button>
            <Button
              className="h-7 rounded-l-none border-0 px-3 text-xs"
              onClick={() => setShowTestnets(true)}
              size="sm"
              variant={showTestnets ? "default" : "ghost"}
            >
              Testnets
            </Button>
          </div>
          <Button
            aria-label="Refresh balances"
            data-testid="wallet-refresh-button"
            disabled={refreshing}
            onClick={onRefresh}
            size="sm"
            variant="ghost"
          >
            <RefreshCw
              className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`}
            />
          </Button>
        </div>
      </div>

      {balances.length === 0 ? (
        <div className="text-muted-foreground text-sm">Loading chains...</div>
      ) : (
        <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
          {filteredBalances.map((balance) => (
            <ChainBalanceItem
              balance={balance}
              chain={chains.find((c) => c.chainId === balance.chainId)}
              isAdmin={isAdmin}
              key={balance.chainId}
              onRemoveToken={onRemoveToken}
              onWithdraw={onWithdraw}
              supportedTokenBalances={supportedTokenBalances}
              tokenBalances={tokenBalances}
            />
          ))}
          {filteredBalances.length === 0 && (
            <div className="py-4 text-center text-muted-foreground text-sm">
              No {showTestnets ? "testnet" : "mainnet"} chains available
            </div>
          )}
        </div>
      )}

      {isAdmin && (
        <div className="mt-4 border-t pt-4">
          {showAddToken ? (
            <AddTokenForm
              chains={chains}
              onAdd={onAddToken}
              onCancel={() => setShowAddToken(false)}
            />
          ) : (
            <Button
              className="w-full"
              onClick={() => setShowAddToken(true)}
              variant="outline"
            >
              <Plus className="mr-2 h-4 w-4" />
              Add Token
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function NoWalletSection({
  isAdmin,
  initialEmail,
  onCreateWallet,
}: {
  isAdmin: boolean;
  initialEmail: string;
  onCreateWallet: (email: string, provider: WalletProviderOption) => Promise<void>;
}) {
  if (!isAdmin) {
    return (
      <div className="rounded-lg border bg-muted/50 p-4">
        <p className="text-muted-foreground text-sm">
          No wallet found for this organization. Only organization admins and
          owners can create wallets.
        </p>
      </div>
    );
  }

  return (
    <CreateWalletForm
      initialEmail={initialEmail}
      onSubmit={onCreateWallet}
    />
  );
}

// ============================================================================
// Main Component
// ============================================================================

type ExportStep = "idle" | "requesting" | "otp" | "verifying" | "done";

function ExportPrivateKeyButton(): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<ExportStep>("idle");
  const [otpCode, setOtpCode] = useState("");
  const [privateKey, setPrivateKey] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleOpen = async (): Promise<void> => {
    setOpen(true);
    setStep("requesting");
    setError(null);
    setOtpCode("");
    setPrivateKey(null);
    setRevealed(false);
    try {
      const res = await fetch("/api/user/wallet/export-key/request", {
        method: "POST",
      });
      const data: { error?: string } = await res.json();

      if (!res.ok) {
        throw new Error(data.error ?? "Failed to send verification code");
      }

      setStep("otp");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to send code"
      );
      setOpen(false);
      setStep("idle");
    }
  };

  const handleVerify = async (): Promise<void> => {
    if (otpCode.length !== 6) {
      setError("Enter the 6-digit code from your email");
      return;
    }

    setStep("verifying");
    setError(null);
    try {
      const res = await fetch("/api/user/wallet/export-key/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: otpCode }),
      });
      const data: { privateKey?: string; error?: string } = await res.json();

      if (!res.ok) {
        throw new Error(data.error ?? "Verification failed");
      }

      if (!data.privateKey) {
        throw new Error("No private key returned");
      }

      setPrivateKey(data.privateKey);
      setRevealed(false);
      setStep("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
      setStep("otp");
    }
  };

  const handleCopy = (): void => {
    if (!privateKey) {
      return;
    }
    navigator.clipboard.writeText(privateKey);
    toast.success("Private key copied to clipboard");
  };

  const handleClose = (): void => {
    setOpen(false);
    setStep("idle");
    setOtpCode("");
    setPrivateKey(null);
    setRevealed(false);
    setError(null);
  };

  return (
    <>
      <Button
        className="w-full"
        onClick={handleOpen}
        size="sm"
        variant="outline"
      >
        <KeyRound className="mr-2 h-3 w-3" />
        Export Private Key
      </Button>

      <Dialog onOpenChange={(v) => { if (!v) { handleClose(); } }} open={open}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Export Private Key</DialogTitle>
            <DialogDescription>
              {step === "done"
                ? "Your private key is shown below. Copy it and store it securely."
                : "A verification code has been sent to your email."}
            </DialogDescription>
          </DialogHeader>

          {step === "requesting" && (
            <div className="flex items-center justify-center py-8">
              <Spinner className="h-6 w-6" />
            </div>
          )}

          {(step === "otp" || step === "verifying") && (
            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <Label htmlFor="export-otp">Verification Code</Label>
                <Input
                  className="font-mono text-center text-lg tracking-[0.3em]"
                  id="export-otp"
                  maxLength={6}
                  onChange={(e) =>
                    setOtpCode(e.target.value.replace(/\D/g, ""))
                  }
                  placeholder="000000"
                  value={otpCode}
                />
                {error && (
                  <p className="text-destructive text-sm">{error}</p>
                )}
              </div>
              <div className="flex gap-2">
                <Button
                  className="flex-1"
                  disabled={step === "verifying"}
                  onClick={handleClose}
                  variant="outline"
                >
                  Cancel
                </Button>
                <Button
                  className="flex-1"
                  disabled={step === "verifying" || otpCode.length !== 6}
                  onClick={handleVerify}
                >
                  {step === "verifying" ? (
                    <>
                      <Spinner className="mr-2 h-4 w-4" />
                      Verifying...
                    </>
                  ) : (
                    "Verify & Export"
                  )}
                </Button>
              </div>
            </div>
          )}

          {step === "done" && privateKey && (
            <div className="space-y-4 py-2">
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-medium text-destructive text-sm">
                    Private Key
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      aria-label={
                        revealed ? "Hide private key" : "Reveal private key"
                      }
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() => setRevealed(!revealed)}
                      type="button"
                    >
                      {revealed ? (
                        <EyeOff className="h-4 w-4" />
                      ) : (
                        <Eye className="h-4 w-4" />
                      )}
                    </button>
                    <button
                      aria-label="Copy private key"
                      className="text-muted-foreground hover:text-foreground"
                      onClick={handleCopy}
                      type="button"
                    >
                      <Copy className="h-4 w-4" />
                    </button>
                  </div>
                </div>
                <code className="block break-all font-mono text-sm">
                  {revealed
                    ? privateKey
                    : privateKey.replace(/./g, "\u2022")}
                </code>
              </div>
              <Button className="w-full" onClick={handleClose}>
                Done
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function AccountDetailsSection({
  email,
  walletAddress,
  isAdmin,
  canExportKey,
  provider,
  onEmailUpdated,
}: {
  email: string;
  walletAddress: string;
  isAdmin: boolean;
  canExportKey: boolean;
  provider: WalletProvider;
  onEmailUpdated: () => void;
}) {
  const [isEditingEmail, setIsEditingEmail] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [updating, setUpdating] = useState(false);

  const handleUpdateEmail = async () => {
    if (!newEmail) {
      toast.error("Email is required");
      return;
    }

    setUpdating(true);
    try {
      const response = await fetch("/api/user/wallet", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: newEmail }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to update email");
      }

      toast.success("Wallet email updated successfully!");
      setIsEditingEmail(false);
      setNewEmail("");
      onEmailUpdated();
    } catch (error) {
      console.error("Failed to update wallet email:", error);
      toast.error(
        error instanceof Error ? error.message : "Failed to update email"
      );
    } finally {
      setUpdating(false);
    }
  };

  const startEditing = () => {
    setNewEmail(email);
    setIsEditingEmail(true);
  };

  const cancelEditing = () => {
    setIsEditingEmail(false);
    setNewEmail("");
  };

  const copyAddress = () => {
    navigator.clipboard.writeText(toChecksumAddress(walletAddress));
    toast.success("Address copied to clipboard");
  };

  return (
    <div className="rounded-lg border bg-muted/50 p-4">
      <div className="mb-2 text-muted-foreground text-sm">Account details</div>

      {isEditingEmail ? (
        <div className="space-y-2">
          <Input
            className="text-sm"
            disabled={updating}
            onChange={(e) => setNewEmail(e.target.value)}
            placeholder="newemail@example.com"
            type="email"
            value={newEmail}
          />
          <div className="flex gap-2">
            <Button
              disabled={updating}
              onClick={cancelEditing}
              size="sm"
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={updating || !newEmail || newEmail === email}
              onClick={handleUpdateEmail}
              size="sm"
            >
              {updating ? (
                <>
                  <Spinner className="mr-2 h-3 w-3" />
                  Saving...
                </>
              ) : (
                "Save"
              )}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-sm">{email}</span>
            {isAdmin && (
              <Button
                className="h-5 px-1.5 text-xs"
                onClick={startEditing}
                size="sm"
                variant="ghost"
              >
                Edit
              </Button>
            )}
          </div>
          <div className="flex items-center gap-1">
            <code className="font-mono text-muted-foreground text-xs">
              {truncateAddress(walletAddress)}
            </code>
            <button
              aria-label="Copy wallet address"
              className="text-muted-foreground hover:text-foreground"
              data-testid="wallet-copy-address"
              onClick={copyAddress}
              type="button"
            >
              <Copy className="h-3 w-3" />
            </button>
          </div>
        </div>
      )}

      {isAdmin && canExportKey && (
        <div className="mt-3">
          {provider === "para" ? (
            <ParaExportKeyButton />
          ) : (
            <ExportPrivateKeyButton />
          )}
        </div>
      )}
    </div>
  );
}

export function WalletOverlay({ overlayId }: WalletOverlayProps) {
  const { closeAll, push } = useOverlay();
  const { data: session } = useSession();
  const { isAdmin } = useActiveMember();

  const [walletLoading, setWalletLoading] = useState(true);
  const [walletData, setWalletData] = useState<WalletData | null>(null);
  const [chains, setChains] = useState<ChainData[]>([]);
  const [tokens, setTokens] = useState<TokenData[]>([]);
  const [supportedTokens, setSupportedTokens] = useState<SupportedToken[]>([]);
  const [supportedTokenBalances, setSupportedTokenBalances] = useState<
    SupportedTokenBalance[]
  >([]);
  const [refreshing, setRefreshing] = useState(false);
  const [showAddToken, setShowAddToken] = useState(false);

  const { balances, tokenBalances, fetchBalances } = useWalletBalances();

  const fetchChains = useCallback(async (): Promise<ChainData[]> => {
    try {
      const response = await fetch("/api/chains");
      const data: ChainData[] = await response.json();
      const evmChains = data.filter((chain) => chain.chainType === "evm");
      setChains(evmChains);
      return evmChains;
    } catch (error) {
      console.error("Failed to fetch chains:", error);
      return [];
    }
  }, []);

  const fetchTokens = useCallback(async (): Promise<TokenData[]> => {
    try {
      const response = await fetch("/api/user/wallet/tokens");
      const data = await response.json();
      setTokens(data.tokens || []);
      return data.tokens || [];
    } catch (error) {
      console.error("Failed to fetch tokens:", error);
      return [];
    }
  }, []);

  const fetchSupportedTokensData = useCallback(async (): Promise<
    SupportedToken[]
  > => {
    try {
      const response = await fetch("/api/supported-tokens");
      const data = await response.json();
      const tokenList = data.tokens || [];
      setSupportedTokens(tokenList);
      return tokenList;
    } catch (error) {
      console.error("Failed to fetch supported tokens:", error);
      return [];
    }
  }, []);

  const fetchSupportedBalances = useCallback(
    async (
      walletAddress: string,
      chainList: ChainData[],
      tokenList: SupportedToken[]
    ) => {
      if (tokenList.length === 0) {
        setSupportedTokenBalances([]);
        return;
      }

      // Set loading state
      setSupportedTokenBalances(
        tokenList.map((token) => ({
          chainId: token.chainId,
          tokenAddress: token.tokenAddress,
          symbol: token.symbol,
          name: token.name,
          logoUrl: token.logoUrl,
          balance: "0",
          loading: true,
        }))
      );

      // Fetch balances
      const results = await fetchAllSupportedTokenBalances(
        walletAddress,
        tokenList,
        chainList
      );
      setSupportedTokenBalances(results);
    },
    []
  );

  const loadWallet = useCallback(async () => {
    setWalletLoading(true);
    try {
      // Phase 1: Fetch wallet data first (fast - just address + email)
      const walletResponse = await fetch("/api/user/wallet");
      const data = await walletResponse.json();

      if (!data.hasWallet) {
        setWalletData({ hasWallet: false });
        setWalletLoading(false);
        return;
      }

      // Show wallet info immediately
      setWalletData(data);
      setWalletLoading(false);

      // Phase 2: Fetch chains/tokens in background
      const [chainList, tokenList, supportedList] = await Promise.all([
        fetchChains(),
        fetchTokens(),
        fetchSupportedTokensData(),
      ]);

      // Phase 3: Fetch balances (they show loading states internally)
      if (data.walletAddress && chainList.length > 0) {
        fetchBalances(data.walletAddress, chainList, tokenList);
        fetchSupportedBalances(data.walletAddress, chainList, supportedList);
      }
    } catch (error) {
      console.error("Failed to load wallet:", error);
      setWalletData({ hasWallet: false });
      setWalletLoading(false);
    }
  }, [
    fetchChains,
    fetchTokens,
    fetchSupportedTokensData,
    fetchBalances,
    fetchSupportedBalances,
  ]);

  const handleRefresh = useCallback(async () => {
    if (!(walletData?.walletAddress && chains.length > 0)) {
      return;
    }
    setRefreshing(true);
    await Promise.all([
      fetchBalances(walletData.walletAddress, chains, tokens),
      fetchSupportedBalances(walletData.walletAddress, chains, supportedTokens),
    ]);
    setRefreshing(false);
  }, [
    walletData?.walletAddress,
    chains,
    tokens,
    supportedTokens,
    fetchBalances,
    fetchSupportedBalances,
  ]);

  const handleAddToken = async (chainId: number, tokenAddress: string) => {
    const response = await fetch("/api/user/wallet/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chainId, tokenAddress }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Failed to add token");
    }

    toast.success(`Added ${data.token.symbol} to tracked tokens`);
    setShowAddToken(false);
    await loadWallet();
  };

  const handleRemoveToken = async (tokenId: string, symbol: string) => {
    try {
      const response = await fetch("/api/user/wallet/tokens", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tokenId }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to remove token");
      }

      toast.success(`Removed ${symbol} from tracked tokens`);
      await loadWallet(); // Refresh to show updated token list
    } catch (error) {
      console.error("Failed to remove token:", error);
      toast.error(
        error instanceof Error ? error.message : "Failed to remove token"
      );
    }
  };

  const handleCreateWallet = async (
    email: string,
    provider: WalletProviderOption
  ): Promise<void> => {
    const response = await fetch("/api/user/wallet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, provider }),
    });

    const data: { error?: string } = await response.json();
    if (!response.ok) {
      throw new Error(data.error ?? "Failed to create wallet");
    }

    toast.success("Wallet created successfully!");
    await loadWallet();
  };

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Logic is straightforward, two loops with validation
  const buildWithdrawableAssets = useCallback((): WithdrawableAsset[] => {
    const assets: WithdrawableAsset[] = [];

    // Add native balances (skip TEMPO - it uses stablecoins, not native tokens)
    for (const balance of balances) {
      // Skip TEMPO native balance - it uses stablecoins only
      if (isTempoChain(balance.chainId)) {
        continue;
      }
      const chain = chains.find((c) => c.chainId === balance.chainId);
      // Skip if not a valid positive number
      const numBalance = Number.parseFloat(balance.balance);
      if (!(chain && Number.isFinite(numBalance)) || numBalance <= 0) {
        continue;
      }
      assets.push({
        type: "native",
        chainId: balance.chainId,
        chainName: balance.name,
        symbol: balance.symbol,
        balance: balance.balance,
        decimals: 18,
        rpcUrl: chain.defaultPrimaryRpc,
        explorerUrl: balance.explorerUrl,
      });
    }

    // Add supported token balances (stablecoins)
    for (const token of supportedTokenBalances) {
      // Skip if not a valid positive number
      const numBalance = Number.parseFloat(token.balance);
      if (!Number.isFinite(numBalance) || numBalance <= 0) {
        continue;
      }
      const chain = chains.find((c) => c.chainId === token.chainId);
      if (!chain) {
        continue;
      }
      const balance = balances.find((b) => b.chainId === token.chainId);
      assets.push({
        type: "token",
        chainId: token.chainId,
        chainName: chain.name,
        symbol: token.symbol,
        balance: token.balance,
        tokenAddress: token.tokenAddress,
        decimals: 6,
        rpcUrl: chain.defaultPrimaryRpc,
        explorerUrl: balance?.explorerUrl || null,
      });
    }

    return assets;
  }, [balances, chains, supportedTokenBalances]);

  const findAssetIndex = useCallback(
    (assets: WithdrawableAsset[], chainId: number, tokenAddress?: string) => {
      if (tokenAddress) {
        const idx = assets.findIndex(
          (a) => a.chainId === chainId && a.tokenAddress === tokenAddress
        );
        return idx >= 0 ? idx : 0;
      }
      const idx = assets.findIndex(
        (a) => a.chainId === chainId && a.type === "native"
      );
      return idx >= 0 ? idx : 0;
    },
    []
  );

  const handleWithdraw = useCallback(
    (chainId: number, tokenAddress?: string) => {
      if (!walletData?.walletAddress) {
        return;
      }

      const assets = buildWithdrawableAssets();
      if (assets.length === 0) {
        toast.error("No assets available for withdrawal");
        return;
      }

      const initialIndex = findAssetIndex(assets, chainId, tokenAddress);
      push(WithdrawModal, {
        assets,
        walletAddress: walletData.walletAddress,
        initialAssetIndex: initialIndex,
      });
    },
    [walletData?.walletAddress, buildWithdrawableAssets, findAssetIndex, push]
  );

  // Re-fetch wallet when session changes (e.g., user signs in)
  const sessionUserId = session?.user?.id;

  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionUserId is intentionally included to trigger re-fetch on sign-in
  useEffect(() => {
    loadWallet();
  }, [loadWallet, sessionUserId]);

  const description = walletData?.hasWallet
    ? "View your organization's wallet address and balances across different chains"
    : "Create a wallet for your organization to use in workflows";

  return (
    <Overlay
      actions={[{ label: "Done", onClick: closeAll }]}
      overlayId={overlayId}
      title="Organization Wallet"
    >
      <p className="-mt-2 mb-4 text-muted-foreground text-sm">{description}</p>

      {walletLoading && (
        <div className="flex items-center justify-center py-8">
          <Spinner />
        </div>
      )}

      {!walletLoading && walletData?.hasWallet && (
        <div className="space-y-4">
          {walletData.email && walletData.walletAddress && (
            <AccountDetailsSection
              canExportKey={!!walletData.canExportKey}
              email={walletData.email}
              isAdmin={isAdmin}
              onEmailUpdated={loadWallet}
              provider={walletData.provider ?? "turnkey"}
              walletAddress={walletData.walletAddress}
            />
          )}

          <BalanceListSection
            balances={balances}
            chains={chains}
            isAdmin={isAdmin}
            onAddToken={handleAddToken}
            onRefresh={handleRefresh}
            onRemoveToken={handleRemoveToken}
            onWithdraw={handleWithdraw}
            refreshing={refreshing}
            setShowAddToken={setShowAddToken}
            showAddToken={showAddToken}
            supportedTokenBalances={supportedTokenBalances}
            tokenBalances={tokenBalances}
          />
        </div>
      )}

      {!(walletLoading || walletData?.hasWallet) && (
        <NoWalletSection
          initialEmail={session?.user?.email ?? ""}
          isAdmin={isAdmin}
          onCreateWallet={handleCreateWallet}
        />
      )}
    </Overlay>
  );
}
