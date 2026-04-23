"use client";

import { ethers } from "ethers";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
import { SaveAddressBookmark } from "@/components/address-book/save-address-bookmark";
import { toChecksumAddress, truncateAddress } from "@/lib/address-utils";
import type { WithdrawableAsset } from "@/lib/wallet/build-withdrawable-assets";

export type { WithdrawableAsset };

type WithdrawModalProps = {
  overlayId: string;
  assets: WithdrawableAsset[];
  walletAddress: string;
  initialAssetIndex?: number;
};

type WithdrawState = "input" | "confirming" | "success" | "error";

type GasEstimate = {
  costWei: bigint;
  costEth: string;
  nativeSymbol: string;
};

export function WithdrawModal({
  overlayId,
  assets,
  walletAddress,
  initialAssetIndex = 0,
}: WithdrawModalProps) {
  const { closeAll, pop } = useOverlay();

  const [selectedAssetIndex, setSelectedAssetIndex] =
    useState(initialAssetIndex);
  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState("");
  const [state, setState] = useState<WithdrawState>("input");
  const [txHash, setTxHash] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [gasEstimate, setGasEstimate] = useState<GasEstimate | null>(null);
  const [gasEstimateLoading, setGasEstimateLoading] = useState(false);
  const [gasEstimateError, setGasEstimateError] = useState<string | null>(null);
  const [maxReserveApplied, setMaxReserveApplied] = useState(false);
  const [maxLoading, setMaxLoading] = useState(false);
  const lastEstimateKeyRef = useRef<string | null>(null);

  const selectedAsset = assets[selectedAssetIndex];

  useEffect(() => {
    if (!selectedAsset) {
      return;
    }
    const parsedAmount = Number.parseFloat(amount);
    if (!(amount && Number.isFinite(parsedAmount)) || parsedAmount <= 0) {
      setGasEstimate(null);
      setGasEstimateError(null);
      setGasEstimateLoading(false);
      return;
    }
    if (parsedAmount > Number.parseFloat(selectedAsset.balance)) {
      setGasEstimate(null);
      setGasEstimateError(null);
      setGasEstimateLoading(false);
      return;
    }

    const estimationRecipient = ethers.isAddress(recipient)
      ? recipient
      : walletAddress;

    const key = `${selectedAsset.chainId}|${selectedAsset.tokenAddress ?? "native"}|${amount}|${estimationRecipient}`;
    if (lastEstimateKeyRef.current === key) {
      return;
    }

    const controller = new AbortController();
    const runEstimate = async (): Promise<void> => {
      setGasEstimateLoading(true);
      setGasEstimateError(null);
      try {
        const response = await fetch("/api/user/wallet/estimate-gas", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chainId: selectedAsset.chainId,
            tokenAddress: selectedAsset.tokenAddress,
            amount,
            recipient: estimationRecipient,
          }),
          signal: controller.signal,
        });
        const data = (await response.json()) as {
          gasCostWei?: string;
          gasCostEth?: string;
          nativeSymbol?: string;
          error?: string;
        };
        if (
          !(response.ok && data.gasCostWei && data.gasCostEth && data.nativeSymbol)
        ) {
          throw new Error(data.error ?? "Gas estimation failed");
        }
        setGasEstimate({
          costWei: BigInt(data.gasCostWei),
          costEth: data.gasCostEth,
          nativeSymbol: data.nativeSymbol,
        });
        lastEstimateKeyRef.current = key;
        setGasEstimateLoading(false);
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "AbortError") {
          return;
        }
        setGasEstimate(null);
        setGasEstimateError(
          err instanceof Error ? err.message : "Gas estimation failed"
        );
        setGasEstimateLoading(false);
      }
    };
    const timeoutId = setTimeout(() => {
      void runEstimate();
    }, 500);

    return () => {
      controller.abort();
      clearTimeout(timeoutId);
    };
  }, [
    amount,
    recipient,
    selectedAsset,
    walletAddress,
  ]);

  const handleMaxClick = async (): Promise<void> => {
    if (!selectedAsset) {
      return;
    }

    if (selectedAsset.type === "token") {
      setAmount(selectedAsset.balance);
      setMaxReserveApplied(false);
      return;
    }

    setMaxLoading(true);
    try {
      const estimationRecipient = ethers.isAddress(recipient)
        ? recipient
        : walletAddress;

      const response = await fetch("/api/user/wallet/estimate-gas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chainId: selectedAsset.chainId,
          // Native gasUsed is amount-independent, so a tiny placeholder is enough
          // to get the fee estimate. Passing the full balance here would make
          // provider.estimateGas reject with insufficient-funds for this very call.
          amount: "0.000001",
          recipient: estimationRecipient,
        }),
      });
      const data = (await response.json()) as {
        gasCostWei?: string;
        gasCostEth?: string;
        nativeSymbol?: string;
        error?: string;
      };
      if (!(response.ok && data.gasCostWei && data.gasCostEth && data.nativeSymbol)) {
        throw new Error(data.error ?? "Gas estimation failed");
      }

      const balanceWei = ethers.parseEther(selectedAsset.balance);
      const gasCostWei = BigInt(data.gasCostWei);

      if (balanceWei <= gasCostWei) {
        toast.error("Balance is too low to cover network fee");
        return;
      }

      const maxWei = balanceWei - gasCostWei;
      const newAmount = ethers.formatEther(maxWei);

      lastEstimateKeyRef.current = `${selectedAsset.chainId}|native|${newAmount}|${estimationRecipient}`;
      setGasEstimate({
        costWei: gasCostWei,
        costEth: data.gasCostEth,
        nativeSymbol: data.nativeSymbol,
      });
      setGasEstimateError(null);
      setMaxReserveApplied(true);
      setAmount(newAmount);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to calculate max amount"
      );
    } finally {
      setMaxLoading(false);
    }
  };

  const validateWithdrawal = (): string | null => {
    if (!selectedAsset) {
      return "Please select an asset";
    }
    if (!amount || Number.parseFloat(amount) <= 0) {
      return "Please enter a valid amount";
    }
    if (Number.parseFloat(amount) > Number.parseFloat(selectedAsset.balance)) {
      return "Insufficient balance";
    }
    if (!ethers.isAddress(recipient)) {
      return "Please enter a valid recipient address";
    }
    if (recipient.toLowerCase() === walletAddress.toLowerCase()) {
      return "Cannot withdraw to the same address";
    }
    return null;
  };

  const handleSubmit = async () => {
    const validationError = validateWithdrawal();
    if (validationError || !selectedAsset) {
      if (validationError) {
        toast.error(validationError);
      }
      return;
    }

    setState("confirming");
    setErrorMessage(null);

    // When Max was clicked for a native transfer, delegate the balance →
    // reservation subtraction to the server so the final value and the gas
    // reservation come from the same snapshot. This avoids "insufficient
    // funds" when baseFee rises between the client's fee preview and tx
    // submission.
    const useServerMax =
      maxReserveApplied && selectedAsset.type === "native";

    try {
      const response = await fetch("/api/user/wallet/withdraw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chainId: selectedAsset.chainId,
          tokenAddress: selectedAsset.tokenAddress,
          amount: useServerMax ? undefined : amount,
          recipient,
          fromMax: useServerMax,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Withdrawal failed");
      }

      setTxHash(data.txHash);
      setState("success");
      toast.success("Withdrawal successful!");
    } catch (error) {
      console.error("Withdrawal failed:", error);
      setErrorMessage(
        error instanceof Error ? error.message : "Withdrawal failed"
      );
      setState("error");
    }
  };

  // Success state
  if (state === "success" && txHash) {
    return (
      <Overlay
        actions={[{ label: "Done", onClick: closeAll }]}
        overlayId={overlayId}
        title="Withdrawal Complete"
      >
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <CheckCircle2 className="mb-4 size-12 text-green-500" />
          <p className="mb-2 font-medium">
            {amount} {selectedAsset?.symbol} sent
          </p>
          <p className="mb-4 text-muted-foreground text-sm">
            To: {truncateAddress(recipient)}
          </p>
        </div>
      </Overlay>
    );
  }

  // Error state
  if (state === "error") {
    return (
      <Overlay
        actions={[
          { label: "Try Again", onClick: () => setState("input") },
          { label: "Close", variant: "outline", onClick: closeAll },
        ]}
        overlayId={overlayId}
        title="Withdrawal Failed"
      >
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <AlertCircle className="mb-4 size-12 text-destructive" />
          <p className="mb-2 font-medium">Transaction failed</p>
          <p className="text-muted-foreground text-sm">{errorMessage}</p>
        </div>
      </Overlay>
    );
  }

  // Confirming state
  if (state === "confirming") {
    return (
      <Overlay overlayId={overlayId} title="Processing Withdrawal">
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <Loader2 className="mb-4 size-12 animate-spin text-primary" />
          <p className="mb-2 font-medium">Signing and sending transaction...</p>
          <p className="text-muted-foreground text-sm">
            Please wait while we process your withdrawal
          </p>
        </div>
      </Overlay>
    );
  }

  // Input state
  return (
    <Overlay
      actions={[
        { label: "Cancel", variant: "outline", onClick: pop },
        {
          label: "Withdraw",
          onClick: handleSubmit,
          disabled:
            !(amount && recipient && ethers.isAddress(recipient)) ||
            Number.parseFloat(amount) <= 0 ||
            Number.parseFloat(amount) >
              Number.parseFloat(selectedAsset?.balance || "0"),
        },
      ]}
      overlayId={overlayId}
      title="Withdraw Funds"
    >
      <p className="-mt-2 mb-4 text-muted-foreground text-sm">
        Send funds from your Para wallet to another address
      </p>

      <div className="space-y-4">
        {/* Asset Selection */}
        <div className="space-y-2">
          <Label>Asset</Label>
          <Select
            onValueChange={(value) => {
              setSelectedAssetIndex(Number.parseInt(value, 10));
              setAmount("");
              setMaxReserveApplied(false);
            }}
            value={selectedAssetIndex.toString()}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select asset" />
            </SelectTrigger>
            <SelectContent>
              {assets.map((asset, index) => (
                <SelectItem
                  key={`${asset.chainId}-${asset.tokenAddress || "native"}`}
                  value={index.toString()}
                >
                  {asset.symbol} on {asset.chainName} ({asset.balance})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Amount Input */}
        <div className="space-y-2">
          <Label>Amount</Label>
          <div className="flex gap-2">
            <Input
              onChange={(e) => {
                setAmount(e.target.value);
                setMaxReserveApplied(false);
              }}
              placeholder="0.00"
              type="number"
              value={amount}
            />
            <Button
              disabled={maxLoading}
              onClick={handleMaxClick}
              size="sm"
              type="button"
              variant="outline"
            >
              {maxLoading ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                "Max"
              )}
            </Button>
          </div>
          {selectedAsset && (
            <p className="text-muted-foreground text-xs">
              Available: {selectedAsset.balance} {selectedAsset.symbol}
            </p>
          )}
        </div>

        {/* Recipient Address */}
        <div className="space-y-2">
          <Label>Recipient Address</Label>
          <SaveAddressBookmark address={recipient}>
            <Input
              onChange={(e) => setRecipient(e.target.value)}
              placeholder="0x..."
              value={toChecksumAddress(recipient)}
            />
          </SaveAddressBookmark>
          {recipient && !ethers.isAddress(recipient) && (
            <p className="text-destructive text-xs">Invalid address format</p>
          )}
        </div>

        {/* Gas Estimate (informational) */}
        {(gasEstimateLoading || gasEstimate || gasEstimateError) && (
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Network fee</span>
              {gasEstimateLoading && (
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" />
                  Estimating...
                </span>
              )}
              {!gasEstimateLoading && gasEstimate && (
                <span className="font-medium text-foreground">
                  {gasEstimate.costEth} {gasEstimate.nativeSymbol}
                </span>
              )}
              {!gasEstimateLoading && gasEstimateError && (
                <span className="text-destructive">Unable to estimate</span>
              )}
            </div>
            {maxReserveApplied && gasEstimate && (
              <p className="text-muted-foreground text-xs">
                Max amount reduced to reserve {gasEstimate.costEth}{" "}
                {gasEstimate.nativeSymbol} for the network fee.
              </p>
            )}
          </div>
        )}
      </div>
    </Overlay>
  );
}
