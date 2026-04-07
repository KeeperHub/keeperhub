"use client";

import type ParaWeb from "@getpara/react-sdk-lite";
import {
  Environment,
  ParaProvider,
  useClient,
  useModal,
} from "@getpara/react-sdk-lite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import {
  type MutableRefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import "@getpara/react-sdk-lite/styles.css";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";

const PARA_API_KEY = process.env.NEXT_PUBLIC_PARA_API_KEY ?? "";
const PARA_ENV_STR = process.env.NEXT_PUBLIC_PARA_ENVIRONMENT ?? "beta";
const PARA_ENVIRONMENT =
  PARA_ENV_STR === "prod" ? Environment.PROD : Environment.BETA;

type ExportStep =
  | "idle"
  | "authenticating"
  | "refreshing-share"
  | "exporting"
  | "done"
  | "error";

async function persistRotatedShare(para: ParaWeb): Promise<void> {
  // biome-ignore lint/suspicious/noExplicitAny: getUserShare is on ParaCore but not in SDK types
  const newShare: string = await (para as any).getUserShare();

  if (!newShare) {
    throw new Error("Failed to get rotated user share from Para");
  }

  const res = await fetch("/api/user/wallet/refresh-share", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userShare: newShare }),
  });

  if (!res.ok) {
    const data: { error?: string } = await res.json();
    throw new Error(data.error ?? "Failed to persist rotated share");
  }
}

/**
 * Parse an exported Para session (base64 JSON) and verify every wallet
 * has a non-null `signer` field.  A missing signer means the MPC share
 * rotation hasn't finished persisting in the SDK yet.
 */
function validateSessionSigners(sessionString: string): boolean {
  try {
    const decoded: { wallets?: Record<string, { signer?: unknown }> } =
      JSON.parse(atob(sessionString));
    const wallets = decoded?.wallets ?? {};
    const ids = Object.keys(wallets);
    if (ids.length === 0) {
      return false;
    }
    for (const id of ids) {
      if (!wallets[id]?.signer) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

const SESSION_EXPORT_MAX_ATTEMPTS = 5;
const SESSION_EXPORT_RETRY_DELAY_MS = 500;

async function transferSessionToServer(para: ParaWeb): Promise<void> {
  for (let attempt = 1; attempt <= SESSION_EXPORT_MAX_ATTEMPTS; attempt++) {
    // biome-ignore lint/suspicious/noExplicitAny: exportSession is on ParaCore but not in SDK types
    const sessionString: string = await (para as any).exportSession();

    if (!sessionString) {
      throw new Error("Para returned an empty session");
    }

    if (validateSessionSigners(sessionString)) {
      const res = await fetch("/api/user/wallet/import-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionString }),
      });

      if (!res.ok) {
        const data: { error?: string } = await res.json();
        throw new Error(data.error ?? "Failed to persist session");
      }
      return;
    }

    if (attempt < SESSION_EXPORT_MAX_ATTEMPTS) {
      await new Promise((resolve) =>
        setTimeout(resolve, SESSION_EXPORT_RETRY_DELAY_MS)
      );
    }
  }

  throw new Error(
    "Exported session has missing wallet signers after multiple attempts. The MPC key rotation may not have completed -- please try again."
  );
}

async function openExportPortal(para: ParaWeb): Promise<void> {
  // biome-ignore lint/suspicious/noExplicitAny: exportPrivateKey is on ParaCore but not in SDK types
  const result: { url?: string } = await (para as any).exportPrivateKey();

  if (result?.url) {
    window.open(result.url, "_blank", "noopener,noreferrer");
  } else {
    toast(
      "Para did not return an export URL. Your wallet has been claimed -- contact support if you need the private key."
    );
  }
}

async function runPostAuthFlow(
  para: ParaWeb,
  setStep: (step: ExportStep) => void,
  setError: (error: string | null) => void
): Promise<void> {
  setStep("refreshing-share");
  setError(null);

  // PRIMARY: Export and store the Para session -- required for post-claim signing
  try {
    await transferSessionToServer(para);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to persist session";
    setStep("error");
    setError(message);
    return;
  }

  // SECONDARY: Also try to persist the rotated share as backup
  try {
    await persistRotatedShare(para);
  } catch {
    // Non-fatal: session transfer is the primary signing credential
  }

  setStep("exporting");
  try {
    await openExportPortal(para);
    setStep("done");
  } catch (err) {
    setStep("done");
    toast.error(
      err instanceof Error ? err.message : "Failed to open export portal"
    );
  }
}

function ParaExportKeyInner({
  onCloseRef,
}: {
  onCloseRef: MutableRefObject<(() => void) | null>;
}): React.ReactElement {
  const para = useClient();
  const { openModal } = useModal();
  const [step, setStep] = useState<ExportStep>("idle");
  const [error, setError] = useState<string | null>(null);
  const [statusDialogOpen, setStatusDialogOpen] = useState(false);
  const stepRef = useRef<ExportStep>("idle");
  stepRef.current = step;

  // Register the modal close handler so ParaProvider's onClose can call it
  useEffect(() => {
    onCloseRef.current = async () => {
      if (stepRef.current !== "authenticating" || !para) {
        if (stepRef.current === "authenticating") {
          setStep("idle");
        }
        return;
      }

      // biome-ignore lint/suspicious/noExplicitAny: isSessionActive is on ParaCore but not in SDK types
      const isActive: boolean = await (para as any).isSessionActive();

      if (!isActive) {
        setStep("idle");
        return;
      }

      setStatusDialogOpen(true);
      await runPostAuthFlow(para, setStep, setError);
    };
  }, [para, onCloseRef]);

  const handleRetry = useCallback(async () => {
    if (!para) {
      return;
    }
    await runPostAuthFlow(para, setStep, setError);
  }, [para]);

  const handleStart = useCallback(async () => {
    if (!para) {
      toast.error("Para client not initialized");
      return;
    }

    setStep("authenticating");
    setError(null);

    // Clear any stale Para session first
    try {
      // biome-ignore lint/suspicious/noExplicitAny: logout is on ParaCore but not in SDK types
      await (para as any).logout();
    } catch {
      // No session to clear
    }

    // Fetch wallet info and user share from our API
    // The share MUST be set AFTER logout so it isn't cleared,
    // and BEFORE auth so the SDK claims the pregen wallet
    let walletEmail: string | undefined;
    try {
      const [walletRes, shareRes] = await Promise.all([
        fetch("/api/user/wallet"),
        fetch("/api/user/wallet/share"),
      ]);

      if (walletRes.ok) {
        const walletData: { email?: string } = await walletRes.json();
        walletEmail = walletData.email ?? undefined;
      }

      if (shareRes.ok) {
        const shareData: { userShare?: string } = await shareRes.json();
        if (shareData.userShare) {
          // biome-ignore lint/suspicious/noExplicitAny: setUserShare is on ParaCore but not in SDK types
          await (para as any).setUserShare(shareData.userShare);
        }
      }
    } catch {
      // Non-fatal: modal will still open but may not claim the right wallet
    }

    openModal({ defaultAuthIdentifier: walletEmail });
  }, [openModal, para]);

  const handleStatusDialogClose = useCallback(() => {
    if (step === "error" || step === "done") {
      setStatusDialogOpen(false);
      setStep("idle");
    }
  }, [step]);

  return (
    <>
      <Button
        className="w-full"
        disabled={step !== "idle" && step !== "done" && step !== "error"}
        onClick={handleStart}
        size="sm"
        variant="outline"
      >
        <KeyRound className="mr-2 h-3 w-3" />
        Export Private Key
      </Button>

      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            handleStatusDialogClose();
          }
        }}
        open={statusDialogOpen}
      >
        <DialogContent
          className="sm:max-w-md"
          onPointerDownOutside={(e) => {
            if (step === "refreshing-share" || step === "exporting") {
              e.preventDefault();
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>Export Private Key</DialogTitle>
            <DialogDescription>
              {step === "refreshing-share" &&
                "Securing your wallet share... Do not close this window."}
              {step === "exporting" && "Opening Para export portal..."}
              {step === "done" &&
                "Export complete. Your private key is available in the Para portal tab."}
              {step === "error" &&
                "Failed to persist wallet share. Your automated signing may break if you close without retrying."}
            </DialogDescription>
          </DialogHeader>

          {(step === "refreshing-share" || step === "exporting") && (
            <div className="flex items-center justify-center py-8">
              <Spinner className="h-6 w-6" />
            </div>
          )}

          {step === "error" && (
            <div className="space-y-4 py-2">
              <p className="text-destructive text-sm">{error}</p>
              <Button className="w-full" onClick={handleRetry} size="sm">
                Retry Share Persistence
              </Button>
            </div>
          )}

          {step === "done" && (
            <div className="py-2">
              <Button
                className="w-full"
                onClick={() => {
                  setStatusDialogOpen(false);
                  setStep("idle");
                }}
                size="sm"
                variant="outline"
              >
                Close
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

const queryClient = new QueryClient();

export function ParaExportKeyButton(): React.ReactElement {
  const onCloseRef = useRef<(() => void) | null>(null);

  return (
    <QueryClientProvider client={queryClient}>
      <ParaProvider
        config={{
          appName: "KeeperHub",
          disableAutoSessionKeepAlive: true,
        }}
        paraClientConfig={{
          env: PARA_ENVIRONMENT,
          apiKey: PARA_API_KEY,
        }}
        paraModalConfig={{
          disablePhoneLogin: true,
          hideWallets: true,
          recoverySecretStepEnabled: false,
          twoFactorAuthEnabled: false,
          oAuthMethods: [],
          onClose: () => {
            onCloseRef.current?.();
          },
        }}
      >
        <ParaExportKeyInner onCloseRef={onCloseRef} />
      </ParaProvider>
    </QueryClientProvider>
  );
}
