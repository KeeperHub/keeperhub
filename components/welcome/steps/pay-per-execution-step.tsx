"use client";

import { Copy, ExternalLink } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { PayPerExecutionPreview } from "@/components/welcome/previews";
import { WelcomeShell } from "@/components/welcome/welcome-shell";
import { toChecksumAddress } from "@/lib/address-utils";
import { BILLING_API } from "@/lib/billing/constants";
import {
  PAYG_DEFAULT_CHAIN_ID,
  PAYG_DEFAULT_DAILY_CAP_USDC,
  PAYG_DEFAULT_PERIOD_CAP_USDC,
} from "@/lib/billing/payg/constants";

const NEXT_PATH = "/welcome/connect-agent";
const BACK_PATH = "/welcome/invite-members";
const BASE_CHAIN_ID = 8453;

type PaygStatus = {
  priceUsdc: string;
  treasuryConfigured: boolean;
  chainId: number;
};

type TokenBalance = { symbol: string; balance: string };

type ChainBalance = {
  chainId: number;
  supportedTokens: TokenBalance[];
  tokens: TokenBalance[];
};

type BalancesResponse = {
  walletAddress: string;
  balances: ChainBalance[];
};

function formatUsdc(amount: string | undefined): string {
  const value = Number.parseFloat(amount ?? "0");
  if (!Number.isFinite(value)) {
    return "$0.00 USDC";
  }
  return `$${value.toFixed(2)} USDC`;
}

function findUsdcBalance(
  balances: ChainBalance[],
  chainId: number
): string | undefined {
  const chain = balances.find((b) => b.chainId === chainId);
  if (!chain) {
    return undefined;
  }
  const pool =
    chain.supportedTokens.length > 0 ? chain.supportedTokens : chain.tokens;
  return pool.find((t) => t.symbol.toUpperCase() === "USDC")?.balance;
}

/** Highlighted callout for the free-tier execution cap, the headline of this step. */
function FreeCapCallout({
  priceLabel,
}: {
  priceLabel: string;
}): React.ReactElement {
  return (
    <div className="flex items-center gap-4 rounded-lg border border-keeperhub-green/20 bg-keeperhub-green/5 p-4">
      <p className="font-semibold text-4xl text-keeperhub-green tabular-nums">
        5,000
      </p>
      <div className="flex flex-col gap-0.5">
        <p className="font-medium text-foreground text-sm">
          Free executions included every month
        </p>
        <p className="text-muted-foreground text-xs">
          Then {priceLabel} per execution in USDC, gasless.
        </p>
      </div>
    </div>
  );
}

/** Funding wallet card: prominent USDC balance plus the checksummed address. */
function FundingWalletCard({
  balanceLoading,
  usdcBalance,
  checksummedAddress,
  explorerUrl,
  onCopy,
}: {
  balanceLoading: boolean;
  usdcBalance: string | undefined;
  checksummedAddress: string | null;
  explorerUrl: string | null;
  onCopy: () => void;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
      <p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        Funding wallet
      </p>
      <p className="font-semibold text-foreground text-xl">
        {balanceLoading ? "Loading balance..." : formatUsdc(usdcBalance)}
      </p>
      {checksummedAddress ? (
        <div className="flex items-center gap-1.5 text-muted-foreground text-xs">
          <code className="break-all font-mono">{checksummedAddress}</code>
          <button
            aria-label="Copy funding address"
            className="hover:text-foreground"
            onClick={onCopy}
            type="button"
          >
            <Copy className="size-3" />
          </button>
          {explorerUrl ? (
            <a
              aria-label="View on Basescan"
              className="hover:text-foreground"
              href={explorerUrl}
              rel="noopener noreferrer"
              target="_blank"
            >
              <ExternalLink className="size-3" />
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Wizard step 3: introduce the free + pay-as-you-go plan and fund the wallet. */
export function PayPerExecutionStep(): React.ReactElement {
  const router = useRouter();
  const [payg, setPayg] = useState<PaygStatus | null>(null);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [balances, setBalances] = useState<ChainBalance[]>([]);
  const [balanceLoading, setBalanceLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const loadPayg = async (): Promise<void> => {
      try {
        const res = await fetch(BILLING_API.PAYG, { cache: "no-store" });
        if (!res.ok) {
          return;
        }
        const data = (await res.json()) as PaygStatus;
        if (!cancelled) {
          setPayg(data);
        }
      } catch {
        // PAYG status is optional context on this step.
      }
    };
    loadPayg().catch(() => undefined);
    return (): void => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const loadBalances = async (): Promise<void> => {
      try {
        const res = await fetch("/api/user/wallet/balances", {
          cache: "no-store",
        });
        if (!res.ok) {
          return;
        }
        const data = (await res.json()) as BalancesResponse;
        if (!cancelled) {
          setWalletAddress(data.walletAddress);
          setBalances(data.balances);
        }
      } catch {
        // Balance stays unknown; the funding block shows a loading fallback.
      } finally {
        if (!cancelled) {
          setBalanceLoading(false);
        }
      }
    };
    loadBalances().catch(() => undefined);
    return (): void => {
      cancelled = true;
    };
  }, []);

  const chainId = payg?.chainId ?? PAYG_DEFAULT_CHAIN_ID;
  const usdcBalance = findUsdcBalance(balances, chainId);
  const checksummedAddress = walletAddress
    ? toChecksumAddress(walletAddress)
    : null;
  const priceLabel = payg?.priceUsdc
    ? `$${Number.parseFloat(payg.priceUsdc).toFixed(2)}`
    : "$0.01";
  const explorerUrl =
    checksummedAddress && chainId === BASE_CHAIN_ID
      ? `https://basescan.org/address/${checksummedAddress}`
      : null;

  const handleCopy = (): void => {
    if (!checksummedAddress) {
      return;
    }
    navigator.clipboard
      .writeText(checksummedAddress)
      .then(() => toast.success("Address copied"))
      .catch(() => undefined);
  };

  return (
    <WelcomeShell
      description="Every organization gets 5,000 free executions a month. Pay-as-you-go keeps your workflows running past the free tier."
      nextLabel="Continue"
      onBack={() => router.push(BACK_PATH)}
      onNext={() => router.push(NEXT_PATH)}
      preview={
        <PayPerExecutionPreview
          dailyCap={`$${PAYG_DEFAULT_DAILY_CAP_USDC}`}
          periodCap={`$${PAYG_DEFAULT_PERIOD_CAP_USDC}`}
          priceLabel={priceLabel}
        />
      }
      stepIndex={2}
      title="Pay per execution"
    >
      <div className="flex flex-col gap-5">
        <FreeCapCallout priceLabel={priceLabel} />

        <ul className="list-disc space-y-1 pl-4 text-muted-foreground text-sm">
          <li>
            Charges are gasless USDC pulled straight from your organization
            wallet. No credit card required.
          </li>
          <li>
            You start with a $5 daily and $50 monthly spending cap. Change or
            remove them anytime in Billing.
          </li>
        </ul>

        <FundingWalletCard
          balanceLoading={balanceLoading}
          checksummedAddress={checksummedAddress}
          explorerUrl={explorerUrl}
          onCopy={handleCopy}
          usdcBalance={usdcBalance}
        />

        <p className="text-muted-foreground text-xs">
          You can fund the wallet later. Workflows run on the free tier until
          you do.
        </p>
      </div>
    </WelcomeShell>
  );
}
