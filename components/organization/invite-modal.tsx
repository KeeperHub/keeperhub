"use client";

import { Copy, Link as LinkIcon, Mail, UserPlus, Wallet } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { isAddress } from "viem";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { authClient } from "@/lib/auth-client";
import { useOrganization } from "@/lib/hooks/use-organization";

type InviteMode = "email" | "wallet";

/**
 * Invite form body. Rendered inline in settings; the dialog below keeps the
 * old trigger working for surfaces that have not moved yet.
 */
export function InviteMemberForm({
  onDone,
  onInvited,
  compact = false,
}: {
  onDone?: () => void;
  /** Fires once an invitation exists, so a pending list can refresh. */
  onInvited?: () => void;
  /** One row rather than a stack, for opening inside a card. */
  compact?: boolean;
}): React.ReactElement {
  const [mode, setMode] = useState<InviteMode>("email");
  const [email, setEmail] = useState("");
  const [address, setAddress] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [loading, setLoading] = useState(false);
  const [inviteId, setInviteId] = useState<string | null>(null);
  const { organization } = useOrganization();

  // Wallet invitees have no inbox; resolve the sign-in address to that account's
  // synthetic email, then invite by email so the existing flow is reused.
  const resolveWalletEmail = async (): Promise<string | null> => {
    if (!organization?.id) {
      toast.error("Select an organization first.");
      return null;
    }
    if (!isAddress(address.trim())) {
      toast.error("Enter a valid wallet address.");
      return null;
    }
    const res = await fetch(
      `/api/organizations/${organization.id}/wallet-lookup?address=${address.trim()}`,
      { cache: "no-store" }
    );
    const data = (await res.json().catch(() => ({}))) as {
      found?: boolean;
      email?: string;
      alreadyMember?: boolean;
      error?: string;
    };
    if (!res.ok) {
      toast.error(data.error ?? "Lookup failed.");
      return null;
    }
    if (!(data.found && data.email)) {
      toast.error("No KeeperHub account signs in with that wallet yet.");
      return null;
    }
    if (data.alreadyMember) {
      toast.error("That wallet is already a member of this organization.");
      return null;
    }
    return data.email;
  };

  const handleInvite = async () => {
    setLoading(true);
    try {
      const targetEmail =
        mode === "wallet" ? await resolveWalletEmail() : email.trim();
      if (!targetEmail) {
        return;
      }

      const { data, error } = await authClient.organization.inviteMember({
        email: targetEmail,
        role,
      });

      if (error) {
        toast.error(error.message || "Failed to send invitation");
        return;
      }

      // Type-safe handling of invitation ID
      const invitationData = data as {
        id?: string;
        invitation?: { id?: string };
      } | null;
      const invitationId = invitationData?.id || invitationData?.invitation?.id;
      if (invitationId) {
        setInviteId(invitationId);
        onInvited?.();
        toast.success(
          mode === "wallet"
            ? "Invitation created. Share the link so they can sign to join."
            : `Invitation sent to ${targetEmail}`
        );
        setEmail("");
        setAddress("");
      } else {
        toast.error("Invitation created but ID not returned");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setLoading(false);
    }
  };

  const submitLabel = (() => {
    if (mode === "wallet") {
      return loading ? "Creating..." : "Create invite link";
    }
    return loading ? "Sending..." : "Send invitation";
  })();

  const inviteLink = inviteId
    ? `${typeof window === "undefined" ? "" : window.location.origin}/accept-invite/${inviteId}`
    : "";

  const copyInviteLink = () => {
    if (!inviteId) {
      return;
    }
    const link = `${window.location.origin}/accept-invite/${inviteId}`;
    navigator.clipboard.writeText(link);
    toast.success("Invite link copied to clipboard");
  };

  if (compact) {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex min-w-56 flex-1 flex-col gap-1.5">
            <Label htmlFor="invite-who">
              {mode === "email" ? "Email address" : "Wallet address"}
            </Label>
            <Input
              disabled={loading}
              id="invite-who"
              onChange={(e) =>
                mode === "email"
                  ? setEmail(e.target.value)
                  : setAddress(e.target.value)
              }
              placeholder={mode === "email" ? "colleague@example.com" : "0x..."}
              type={mode === "email" ? "email" : "text"}
              value={mode === "email" ? email : address}
            />
          </div>

          <div className="flex w-36 flex-col gap-1.5">
            <Label htmlFor="invite-role">Role</Label>
            <Select
              onValueChange={(v) => setRole(v as "member" | "admin")}
              value={role}
            >
              <SelectTrigger id="invite-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="member">Member</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Button
            disabled={loading || (mode === "email" ? !email : !address)}
            onClick={handleInvite}
          >
            {submitLabel}
          </Button>
          {onDone && (
            <Button onClick={onDone} variant="ghost">
              Cancel
            </Button>
          )}
        </div>

        <button
          className="w-fit text-muted-foreground text-xs underline-offset-2 hover:underline"
          onClick={() => setMode(mode === "email" ? "wallet" : "email")}
          type="button"
        >
          {mode === "email"
            ? "Invite by wallet address instead"
            : "Invite by email instead"}
        </button>

        {inviteId && (
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1.5 font-mono text-xs">
              {inviteLink}
            </code>
            <Button onClick={copyInviteLink} size="sm" variant="outline">
              <Copy className="size-3.5" />
              Copy
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2">
          <Button
            onClick={() => setMode("email")}
            size="sm"
            type="button"
            variant={mode === "email" ? "default" : "outline"}
          >
            <Mail className="mr-2 h-3 w-3" />
            Email
          </Button>
          <Button
            onClick={() => setMode("wallet")}
            size="sm"
            type="button"
            variant={mode === "wallet" ? "default" : "outline"}
          >
            <Wallet className="mr-2 h-3 w-3" />
            Wallet
          </Button>
        </div>
        {mode === "email" ? (
          <div className="space-y-2">
            <Label htmlFor="email">Email Address</Label>
            <Input
              disabled={loading}
              id="email"
              onChange={(e) => setEmail(e.target.value)}
              placeholder="colleague@example.com"
              type="email"
              value={email}
            />
          </div>
        ) : (
          <div className="space-y-2">
            <Label htmlFor="wallet-address">Wallet Address</Label>
            <Input
              disabled={loading}
              id="wallet-address"
              onChange={(e) => setAddress(e.target.value)}
              placeholder="0x..."
              value={address}
            />
            <p className="text-muted-foreground text-xs">
              The address they sign in with. They will sign a challenge to join.
            </p>
          </div>
        )}
        <div className="space-y-2">
          <Label htmlFor="role">Role</Label>
          <Select
            onValueChange={(v) => setRole(v as "member" | "admin")}
            value={role}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="member">
                Member - Can create workflows
              </SelectItem>
              <SelectItem value="admin">
                Admin - Can manage members and wallets
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        {inviteId && (
          <div className="space-y-2 rounded-lg border p-3">
            <p className="text-muted-foreground text-xs">
              {mode === "wallet"
                ? "Share this link so they can sign in and join."
                : "Sent by email. Share this link if it does not arrive."}
            </p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1.5 font-mono text-xs">
                {inviteLink}
              </code>
              <Button onClick={copyInviteLink} size="sm" variant="outline">
                <Copy className="size-3.5" />
                Copy
              </Button>
            </div>
          </div>
        )}
      </div>
      <div className="flex justify-end gap-2 pt-4">
        {onDone && (
          <Button onClick={onDone} variant="outline">
            Close
          </Button>
        )}
        <Button
          disabled={loading || (mode === "email" ? !email : !address)}
          onClick={handleInvite}
        >
          {mode === "wallet" ? (
            <LinkIcon className="mr-2 h-4 w-4" />
          ) : (
            <Mail className="mr-2 h-4 w-4" />
          )}
          {submitLabel}
        </Button>
      </div>
    </>
  );
}

export function InviteModal(): React.ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger asChild>
        <Button>
          <UserPlus className="mr-2 h-4 w-4" />
          Invite Member
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite Team Member</DialogTitle>
          <DialogDescription>
            Send an invitation to join this organization.
          </DialogDescription>
        </DialogHeader>
        <InviteMemberForm onDone={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}
