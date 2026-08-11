"use client";

import { ShieldCheck, Wallet } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";

function CreateWalletForm({
  initialEmail,
  onSubmit,
}: {
  initialEmail: string;
  onSubmit: (email: string) => Promise<void>;
}): React.ReactElement {
  const [email, setEmail] = useState(initialEmail);
  const [creating, setCreating] = useState(false);

  const handleCreate = async (): Promise<void> => {
    if (!email) {
      toast.error("Email is required");
      return;
    }
    setCreating(true);
    try {
      await onSubmit(email);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to create wallet"
      );
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-4" data-tour="create-wallet-form">
      <p className="text-muted-foreground text-xs">
        This wallet will be shared by all members of your organization. Only
        admins and owners can manage it.
      </p>

      <div className="rounded-lg border bg-muted/30 p-3">
        <p className="mb-2 font-medium text-xs">
          Creating this wallet provisions two Turnkey EOAs:
        </p>
        <ul className="space-y-1.5 text-muted-foreground text-xs">
          <li className="flex items-center gap-2">
            <Wallet className="h-3.5 w-3.5 shrink-0" />
            Turnkey EOA (EVM Compatible)
          </li>
          <li className="flex items-center gap-2">
            <Wallet className="h-3.5 w-3.5 shrink-0" />
            Turnkey EOA (SVM Compatible)
          </li>
        </ul>
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
          This email will be associated with the wallet for identification
          purposes.
        </p>
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-muted-foreground text-xs">
          <ShieldCheck className="h-3.5 w-3.5" />
          <span>Secured by Turnkey</span>
        </div>
        <Button disabled={creating || !email} onClick={handleCreate}>
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

export function NoWalletSection({
  initialEmail,
  isAdmin,
  onCreateWallet,
}: {
  initialEmail: string;
  isAdmin: boolean;
  onCreateWallet: (email: string) => Promise<void>;
}): React.ReactElement {
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
    <CreateWalletForm initialEmail={initialEmail} onSubmit={onCreateWallet} />
  );
}
