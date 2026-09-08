"use client";

import { ethers } from "ethers";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  Loader2,
  ShieldAlert,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { ChangeEvent, ChangeEventHandler, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { DualFactorSteps } from "@/components/auth/dual-factor-steps";
import { Overlay } from "@/components/overlays/overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { SettingsOverlay } from "@/components/overlays/settings-overlay";
import { EmailOtpField } from "@/components/auth/email-otp-field";
import { isWalletEmail } from "@/lib/auth/wallet-constants";
import { useSession } from "@/lib/auth-client";
import { handleGuardError } from "@/lib/client/handle-guard-error";
import {
  type EnrolledFactors,
  resolveRequiredFactors,
  type StepUpFactor,
} from "@/lib/mfa/step-up-policy";
import { useDualFactorState } from "@/lib/mfa/use-dual-factor-state";
import { runWalletStepUp } from "@/lib/wallet/step-up-client";
import { useActiveMember } from "@/lib/hooks/use-organization";
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
import { joinExplorerUrl } from "@/lib/build-explorer-url";
import type { WithdrawableAsset } from "@/lib/wallet/build-withdrawable-assets";

export type { WithdrawableAsset };

const COPIED_FOR_MS = 1500;

/**
 * The wallet whose funds the withdraw moves. Default = the org's Turnkey
 * EOA (no extra param sent to the API). For a Safe, the modal POSTs
 * `safeId` so the server routes through `safe.execTransaction` instead of
 * the EOA's direct transfer.
 */
export type WithdrawSource =
  | { kind: "turnkey" }
  | {
      kind: "safe";
      safeId: string;
      /** Display-only Safe address, used in the "Sending from" line. */
      safeAddress: string;
      /** Display-only chain name, e.g. "Base". */
      chainName?: string;
    };

type WithdrawModalProps = {
  overlayId: string;
  assets: WithdrawableAsset[];
  walletAddress: string;
  initialAssetIndex?: number;
  source?: WithdrawSource;
};

type WithdrawState =
  | "input"
  | "mfa-code"
  | "needs-mfa"
  | "confirming"
  | "success"
  | "error";

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
  source = { kind: "turnkey" },
}: WithdrawModalProps) {
  const { closeAll, open: openOverlay, pop } = useOverlay();
  const router = useRouter();

  // Client-side hardening: only owners with MFA enrolled can use this
  // modal. Server still enforces the same rules via requireOwnerWithMfa
  // + auth.api.verifyTOTP at submission time; these checks just gate
  // what the user sees.
  const { role, isLoading: memberLoading } = useActiveMember();
  const session = useSession();
  const sessionUser = session.data?.user as
    | { twoFactorEnabled?: boolean | null }
    | undefined;
  const isOwner = role === "owner";
  const mfaEnrolled = sessionUser?.twoFactorEnabled === true;
  // Wallet accounts confirm by signing; they don't enroll TOTP.
  const isWallet = isWalletEmail(session.data?.user?.email);

  const [selectedAssetIndex, setSelectedAssetIndex] =
    useState(initialAssetIndex);
  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState("");
  const dual = useDualFactorState();
  const [state, setState] = useState<WithdrawState>("input");
  const [txHash, setTxHash] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [gasEstimate, setGasEstimate] = useState<GasEstimate | null>(null);
  const [gasEstimateLoading, setGasEstimateLoading] = useState(false);
  const [gasEstimateError, setGasEstimateError] = useState<string | null>(null);
  const [maxReserveApplied, setMaxReserveApplied] = useState(false);
  const [maxLoading, setMaxLoading] = useState(false);
  // What the server says this account must present for a withdraw. Wallet
  // accounts always sign; TOTP and the step-up email are added only when the
  // user enrolled them, so the confirm step asks for exactly those.
  const [walletFactors, setWalletFactors] = useState<StepUpFactor[] | null>(
    null
  );
  // The chain's explorer base, so a finished transaction can be opened rather
  // than only read off the screen.
  const [explorerBase, setExplorerBase] = useState<string | null>(null);
  const [hashCopied, setHashCopied] = useState(false);
  const lastEstimateKeyRef = useRef<string | null>(null);
  const factorsProbedRef = useRef(false);

  const selectedAsset = assets[selectedAssetIndex];

  useEffect(() => {
    if (!selectedAsset) {
      return;
    }
    // Safe-routed withdraws wrap the inner transfer in safe.execTransaction,
    // which has a different gas profile than a direct EOA transfer. The
    // server estimates and signs internally; we skip the client preview
    // rather than show a misleading EOA-direct figure.
    if (source.kind === "safe") {
      setGasEstimate(null);
      setGasEstimateError(null);
      setGasEstimateLoading(false);
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

  // The chains feed carries the explorer base; the withdraw response carries
  // only the hash. Fetched on success so a page that never sends pays nothing.
  useEffect(() => {
    if (state !== "success" || !selectedAsset) {
      return;
    }
    let cancelled = false;
    const loadExplorer = async (): Promise<void> => {
      try {
        const response = await fetch("/api/chains");
        if (!response.ok) {
          return;
        }
        const rows = (await response.json()) as {
          chainId: number;
          explorerUrl: string | null;
        }[];
        if (cancelled) {
          return;
        }
        const match = rows.find((row) => row.chainId === selectedAsset.chainId);
        setExplorerBase(match?.explorerUrl ?? null);
      } catch {
        // No link, but the hash itself is still on screen and copyable.
      }
    };
    void loadExplorer();
    return () => {
      cancelled = true;
    };
  }, [selectedAsset, state]);

  // An empty-codes POST. The server reads it as the opening move of the
  // challenge: it mints the wallet nonce and emails the confirmation code,
  // and moves no funds because no factor is present yet.
  const withdrawEmptyCodes = (): Promise<Response> =>
    fetch("/api/user/wallet/withdraw", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chainId: selectedAsset?.chainId,
        tokenAddress: selectedAsset?.tokenAddress,
        amount:
          maxReserveApplied && selectedAsset?.type === "native"
            ? undefined
            : amount,
        recipient,
        fromMax: maxReserveApplied && selectedAsset?.type === "native",
        safeId: source.kind === "safe" ? source.safeId : undefined,
      }),
    });

  // Wallet accounts: resolve the factor set before asking for a signature, so
  // a user who enrolled an authenticator or a step-up email is shown those
  // fields and signs once instead of being bounced by the server. Enrollment
  // is read from the step-up policy, which costs nothing and mints nothing;
  // only the email code needs a withdraw POST to be sent.
  useEffect(() => {
    if (!(state === "mfa-code" && isWallet) || factorsProbedRef.current) {
      return;
    }
    factorsProbedRef.current = true;
    const resolveFactors = async (): Promise<void> => {
      try {
        const response = await fetch("/api/user/step-up/policy");
        if (!response.ok) {
          return;
        }
        const data = (await response.json()) as {
          enrolled?: EnrolledFactors;
        };
        if (!data.enrolled) {
          return;
        }
        const required = resolveRequiredFactors({
          isWalletUser: true,
          enrolled: data.enrolled,
        });
        setWalletFactors(required);
        if (!required.includes("email")) {
          return;
        }
        // The OTP is minted by the withdraw endpoint, not by reading policy,
        // so ask for one now and let it land while the user is on this step.
        const seeded = await withdrawEmptyCodes();
        if (seeded.status === 401) {
          dual.setAwaitingEmailOtp(true);
          toast.success("We just emailed you a confirmation code");
        }
      } catch {
        // Signature-only is the safe fallback: a submit still surfaces any
        // factor the server turns out to want.
      }
    };
    void resolveFactors();
  }, [isWallet, state]);

  // Click handler for the input-step "Withdraw" button. Validates
  // local form state, then routes to the MFA step (owner with MFA
  // enrolled) or the enroll-MFA prompt (owner without MFA). The
  // earlier non-owner branch is handled by the early-exit render at
  // the top of the component; reaching this function implies isOwner.
  const handleProceedToMfa = (): void => {
    const validationError = validateWithdrawal();
    if (validationError || !selectedAsset) {
      if (validationError) {
        toast.error(validationError);
      }
      return;
    }
    if (!(mfaEnrolled || isWallet)) {
      setState("needs-mfa");
      return;
    }
    dual.reset();
    factorsProbedRef.current = false;
    setWalletFactors(null);
    setErrorMessage(null);
    setState("mfa-code");
  };

  const handleSubmit = async (): Promise<void> => {
    const validationError = validateWithdrawal();
    if (validationError || !selectedAsset) {
      if (validationError) {
        toast.error(validationError);
      }
      return;
    }
    const needsTotp = isWallet
      ? walletFactors?.includes("totp") === true
      : true;
    const needsEmail = isWallet
      ? walletFactors?.includes("email") === true
      : dual.awaitingEmailOtp;
    if (needsTotp && dual.totpCode.trim().length !== 6) {
      toast.error("Enter the 6-digit code from your authenticator");
      return;
    }
    if (needsEmail && dual.emailOtp.trim().length !== 6) {
      toast.error("Enter the 6-digit code we emailed to you");
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
      const baseBody = {
        chainId: selectedAsset.chainId,
        tokenAddress: selectedAsset.tokenAddress,
        amount: useServerMax ? undefined : amount,
        recipient,
        fromMax: useServerMax,
        safeId: source.kind === "safe" ? source.safeId : undefined,
      };
      const withdrawFetch = (
        extra: Record<string, unknown>
      ): Promise<Response> =>
        fetch("/api/user/wallet/withdraw", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...baseBody, ...extra }),
        });
      // Wallet users sign the step-up challenge, and carry any factor they
      // enrolled on top of it: the server wants every required factor in the
      // same request the signature rides in.
      const response = isWallet
        ? await runWalletStepUp((extra) =>
            withdrawFetch({
              ...extra,
              code: dual.totpCode.trim() || undefined,
              emailOtp: dual.emailOtp.trim() || undefined,
            })
          )
        : await withdrawFetch({
            code: dual.totpCode.trim(),
            emailOtp: dual.emailOtp.trim() || undefined,
          });

      if (!response.ok) {
        const guarded = await handleGuardError(response, {
          onEnrollMfa: () => openOverlay(SettingsOverlay),
          onPendingMfa: (next) =>
            router.push(`/verify-mfa?next=${encodeURIComponent(next)}`),
        });
        if (guarded) {
          setState("input");
          return;
        }
        const data = await response.json();
        if (Array.isArray(data.required)) {
          setWalletFactors(data.required as StepUpFactor[]);
        }
        // Dual-factor outcomes (factors_required / *_invalid) bring
        // the user back to the MFA step rather than the red error
        // screen so they can finish the flow.
        if (
          dual.handleResponse(data.code, data.error, (msg) => toast.error(msg))
        ) {
          setState("mfa-code");
          return;
        }
        throw new Error(data.error || "Withdrawal failed");
      }

      const data = await response.json();
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
    const explorerTxUrl = explorerBase
      ? joinExplorerUrl(explorerBase, `/tx/${txHash}`)
      : null;
    const copyHash = (): void => {
      navigator.clipboard.writeText(txHash);
      setHashCopied(true);
      setTimeout(() => setHashCopied(false), COPIED_FOR_MS);
    };
    return (
      <Overlay
        actions={[{ label: "Done", onClick: closeAll }]}
        overlayId={overlayId}
        title="Withdrawal Complete"
      >
        <div className="flex flex-col items-center py-8 text-center">
          <CheckCircle2 className="mb-4 size-12 text-green-500" />
          <p className="mb-2 font-medium">
            {amount} {selectedAsset?.symbol} sent
          </p>
          <p className="mb-4 text-muted-foreground text-sm">
            To: {truncateAddress(recipient)}
          </p>

          {/* The hash is the only handle a person has on the transfer once
              this closes, so it is shown in full, copyable, and linked. */}
          <div className="w-full space-y-2 text-left">
            <p className="text-muted-foreground text-xs">Transaction hash</p>
            <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
              <code className="min-w-0 flex-1 break-all font-mono text-xs">
                {txHash}
              </code>
              <button
                aria-label="Copy transaction hash"
                className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                onClick={copyHash}
                type="button"
              >
                {hashCopied ? (
                  <Check className="size-4" />
                ) : (
                  <Copy className="size-4" />
                )}
              </button>
            </div>
            {explorerTxUrl && (
              <a
                className="inline-flex items-center gap-1.5 text-sm underline underline-offset-4"
                href={explorerTxUrl}
                rel="noopener noreferrer"
                target="_blank"
              >
                View on block explorer
                <ExternalLink className="size-3.5" />
              </a>
            )}
          </div>
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

  // Wait for role + session to resolve so we don't briefly flash the
  // input form to a non-owner.
  if (memberLoading || session.isPending) {
    return (
      <Overlay overlayId={overlayId} title="Withdraw Funds">
        <div className="flex items-center justify-center py-8">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      </Overlay>
    );
  }

  // Non-owner: refuse the action outright. Server still enforces this
  // via requireOwnerWithMfa, so even bypassing the UI gets a 403.
  if (!isOwner) {
    return (
      <Overlay
        actions={[{ label: "Close", onClick: closeAll }]}
        overlayId={overlayId}
        title="Withdraw Funds"
      >
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <ShieldAlert className="mb-4 size-12 text-amber-500" />
          <p className="mb-2 font-medium">Owner only</p>
          <p className="text-muted-foreground text-sm">
            Only an organization owner can withdraw funds. Ask the owner
            to perform the transfer.
          </p>
        </div>
      </Overlay>
    );
  }

  // Owner without MFA enrolled: refuse to proceed until they enable
  // two-factor. Server would also refuse via the mfa_not_enrolled
  // code path; this gives them a clear next step.
  if (state === "needs-mfa") {
    return (
      <Overlay
        actions={[
          { label: "Cancel", variant: "outline", onClick: closeAll },
          {
            label: "Open Settings",
            onClick: () => {
              closeAll();
              openOverlay(SettingsOverlay);
            },
          },
        ]}
        overlayId={overlayId}
        title="Two-factor required"
      >
        <div className="flex items-start gap-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-4">
          <ShieldAlert
            aria-hidden="true"
            className="mt-0.5 size-5 shrink-0 text-amber-500"
          />
          <p className="text-sm">
            Withdrawing funds requires two-factor authentication. Enable
            it in Settings, then come back to finish your withdrawal.
          </p>
        </div>
      </Overlay>
    );
  }

  // MFA code step: dual-factor confirmation. First click sends the
  // TOTP and triggers the server to email a fresh OTP; the email field
  // reveals once that response lands. The second click submits both.
  if (state === "mfa-code") {
    if (isWallet) {
      const needsTotp = walletFactors?.includes("totp") === true;
      const needsEmail = walletFactors?.includes("email") === true;
      const codesReady =
        (!needsTotp || dual.totpCode.trim().length === 6) &&
        (!needsEmail || dual.emailOtp.trim().length === 6);
      return (
        <Overlay
          actions={[
            {
              label: "Back",
              onClick: () => setState("input"),
              variant: "outline",
            },
            {
              label: "Sign to withdraw",
              onClick: handleSubmit,
              variant: "destructive",
              disabled: !codesReady,
            },
          ]}
          overlayId={overlayId}
          title="Confirm withdrawal"
        >
          <div className="space-y-4">
            <p className="text-muted-foreground text-sm">
              Confirm sending{" "}
              <span className="font-medium text-foreground">
                {amount} {selectedAsset?.symbol}
              </span>{" "}
              to{" "}
              <span className="font-mono text-foreground">
                {truncateAddress(recipient)}
              </span>
              . Sign with your wallet to continue.
            </p>

            {needsTotp && (
              <div className="space-y-2">
                <Label htmlFor="withdraw-wallet-totp">Authenticator code</Label>
                <Input
                  autoComplete="one-time-code"
                  className="text-center font-mono text-lg tracking-[0.3em]"
                  id="withdraw-wallet-totp"
                  inputMode="numeric"
                  maxLength={6}
                  onChange={(event) =>
                    dual.setTotpCode(event.target.value.replace(/\D/g, ""))
                  }
                  placeholder="000000"
                  value={dual.totpCode}
                />
              </div>
            )}

            {needsEmail && (
              <div className="space-y-2">
                <EmailOtpField
                  id="withdraw-wallet-email-otp"
                  label="Email code"
                  onChange={dual.setEmailOtp}
                  value={dual.emailOtp}
                />
                <p className="text-muted-foreground text-xs">
                  We emailed a 6-digit code to your step-up address. It expires
                  in 5 minutes.
                </p>
              </div>
            )}
          </div>
        </Overlay>
      );
    }
    return (
      <Overlay overlayId={overlayId} title="Confirm withdrawal">
        <DualFactorSteps
          context={
            <>
              Confirm sending{" "}
              <span className="font-medium text-foreground">
                {amount} {selectedAsset?.symbol}
              </span>{" "}
              to{" "}
              <span className="font-mono text-foreground">
                {truncateAddress(recipient)}
              </span>
              .
            </>
          }
          dual={dual}
          onBack={() => {
            dual.reset();
            closeAll();
          }}
          onPrefetchEmail={() => dual.prefetchEmail(withdrawEmptyCodes)}
          onResendEmail={() => dual.resendEmail(withdrawEmptyCodes)}
          onSubmit={handleSubmit}
          submitLabel="Confirm withdraw"
          submitVariant="destructive"
        />
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
          onClick: handleProceedToMfa,
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
        Send funds from your wallet to another address
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
              onChange={
                // SaveAddressBookmark calls child onChange with a string when a
                // bookmark is picked; keep the DOM event path for direct typing.
                ((e: ChangeEvent<HTMLInputElement> | string) => {
                  const value = typeof e === "string" ? e : e.target.value;
                  setRecipient(value);
                }) as ChangeEventHandler<HTMLInputElement>
              }
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
