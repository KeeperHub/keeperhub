"use client";

import { useSetAtom } from "jotai";
import { Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { toChecksumAddress } from "@/lib/address-utils";
import { useSession } from "@/lib/auth-client";
import { integrationsVersionAtom } from "@/lib/integrations-store";

type Web3WalletSectionProps = {
  onSuccess?: (integrationId: string) => void;
  closeAll?: () => void;
  showDelete?: boolean;
};

export function Web3WalletSection({
  onSuccess,
  closeAll,
  showDelete = true,
}: Web3WalletSectionProps) {
  const setIntegrationsVersion = useSetAtom(integrationsVersionAtom);
  const { data: session } = useSession();
  const [hasWallet, setHasWallet] = useState(false);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  // Derive anonymous state from session reactively
  const isAnonymous =
    !session?.user ||
    session.user.name === "Anonymous" ||
    session.user.email?.includes("@http://") ||
    session.user.email?.includes("@https://") ||
    session.user.email?.startsWith("temp-");

  // Get user email from session
  const userEmail = isAnonymous ? null : session?.user?.email;

  // Check wallet status when session changes (user signs in)
  const sessionUserId = session?.user?.id;

  useEffect(() => {
    async function checkWallet() {
      // Reset state when checking
      setLoading(true);
      setHasWallet(false);
      setWalletAddress(null);

      try {
        // Only check for wallet if not anonymous
        if (!isAnonymous && sessionUserId) {
          const response = await fetch("/api/user/wallet");
          const data = await response.json();

          if (data.hasWallet) {
            setHasWallet(true);
            setWalletAddress(data.walletAddress);
          }
        }
      } catch (error) {
        console.error("Failed to check wallet:", error);
      } finally {
        setLoading(false);
      }
    }

    checkWallet();
  }, [isAnonymous, sessionUserId]);

  async function handleCreateWallet() {
    if (!userEmail) {
      toast.error("Unable to get your email. Please refresh and try again.");
      return;
    }

    setCreating(true);
    try {
      const response = await fetch("/api/user/wallet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: userEmail }),
      });

      const data = await response.json();

      if (!response.ok) {
        const errorMsg = data.error || "Failed to create wallet";
        // Show user-friendly error for anonymous users
        if (errorMsg.includes("Anonymous users")) {
          throw new Error(
            "Please sign in with a real account (email, GitHub, or Google) to create a wallet."
          );
        }
        throw new Error(errorMsg);
      }

      setHasWallet(true);
      setWalletAddress(data.wallet.address);
      toast.success("Wallet created successfully!");

      // Trigger re-fetch of integrations so UI syncs and auto-selects the new wallet
      setIntegrationsVersion((v) => v + 1);

      // Close overlay and return to sidepanel with wallet selected
      if (onSuccess) {
        onSuccess(data.integration?.id || "web3-wallet");
      }
      if (closeAll) {
        closeAll();
      }
    } catch (error) {
      console.error("Wallet creation failed:", error);
      toast.error(
        error instanceof Error ? error.message : "Failed to create wallet"
      );
    } finally {
      setCreating(false);
    }
  }

  async function handleDeleteWallet() {
    // biome-ignore lint/suspicious/noAlert: Simple confirmation for destructive action
    if (!confirm("Are you sure? This cannot be undone.")) {
      return;
    }

    try {
      const response = await fetch("/api/user/wallet", {
        method: "DELETE",
      });

      if (!response.ok) {
        throw new Error("Failed to delete wallet");
      }

      setHasWallet(false);
      setWalletAddress(null);
      toast.success("Wallet deleted");
      // Trigger re-fetch of integrations so UI syncs
      setIntegrationsVersion((v) => v + 1);
    } catch {
      toast.error("Failed to delete wallet");
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-4">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="font-medium text-sm">Organization Wallet</h3>
        <p className="text-muted-foreground text-sm">
          Create a secure wallet for Web3 automations.
        </p>
      </div>

      {(() => {
        if (isAnonymous) {
          return (
            <div className="rounded-lg border bg-muted/50 p-3">
              <p className="text-muted-foreground text-sm">
                Please sign in with a real account to create a wallet.
              </p>
            </div>
          );
        }

        if (hasWallet) {
          const checksummedAddress = walletAddress
            ? toChecksumAddress(walletAddress)
            : null;
          return (
            <div className="space-y-3">
              <div className="rounded-lg border bg-muted/50 p-3">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="text-muted-foreground text-xs">
                    Wallet Address
                  </span>
                  {checksummedAddress && (
                    <button
                      aria-label="Copy wallet address"
                      className="inline-flex items-center gap-1 text-muted-foreground text-xs transition-colors hover:text-foreground"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(
                            checksummedAddress
                          );
                          toast.success("Address copied");
                        } catch {
                          toast.error("Failed to copy address");
                        }
                      }}
                      type="button"
                    >
                      <Copy className="size-3" />
                      Copy
                    </button>
                  )}
                </div>
                <code className="break-all font-mono text-xs">
                  {checksummedAddress}
                </code>
              </div>
              {showDelete && (
                <Button
                  className="w-full"
                  onClick={handleDeleteWallet}
                  size="sm"
                  variant="destructive"
                >
                  Delete Wallet
                </Button>
              )}
            </div>
          );
        }

        return (
          <Button
            className="w-full"
            disabled={creating}
            onClick={handleCreateWallet}
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
        );
      })()}
    </div>
  );
}
