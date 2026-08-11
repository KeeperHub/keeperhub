"use client";

import { Copy, Mail, UserPlus, Wallet } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { isAddress } from "viem";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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

export function InviteModal() {
  const [open, setOpen] = useState(false);
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

  const copyInviteLink = () => {
    if (!inviteId) {
      return;
    }
    const link = `${window.location.origin}/accept-invite/${inviteId}`;
    navigator.clipboard.writeText(link);
    toast.success("Invite link copied to clipboard");
  };

  const copyInviteCode = () => {
    if (!inviteId) {
      return;
    }
    navigator.clipboard.writeText(inviteId);
    toast.success("Invite code copied to clipboard");
  };

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
        <div className="space-y-4 py-4">
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
                The address they sign in with. They will sign a challenge to
                join.
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
            <div className="space-y-2 rounded-lg border bg-muted p-4">
              <p className="font-medium text-sm">Invitation Created</p>
              <div className="flex gap-2">
                <Button
                  className="flex-1"
                  onClick={copyInviteLink}
                  size="sm"
                  variant="outline"
                >
                  <Copy className="mr-2 h-3 w-3" />
                  Copy Link
                </Button>
                <Button
                  className="flex-1"
                  onClick={copyInviteCode}
                  size="sm"
                  variant="outline"
                >
                  <Copy className="mr-2 h-3 w-3" />
                  Copy Code
                </Button>
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button onClick={() => setOpen(false)} variant="outline">
            Close
          </Button>
          <Button
            disabled={loading || (mode === "email" ? !email : !address)}
            onClick={handleInvite}
          >
            <Mail className="mr-2 h-4 w-4" />
            {loading ? "Sending..." : "Send Invitation"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
