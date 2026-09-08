"use client";

import { Plus, X } from "lucide-react";
import { nanoid } from "nanoid";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { isAddress } from "viem";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { InvitePreview } from "@/components/welcome/previews";
import { WelcomeShell } from "@/components/welcome/welcome-shell";
import { isWalletEmail } from "@/lib/auth/wallet-constants";
import { authClient, useSession } from "@/lib/auth-client";
import { useOrganization } from "@/lib/hooks/use-organization";
import {
  findDuplicateKeys,
  inviteKey,
  isSelfInvite,
  isValidInvite,
} from "@/lib/onboarding/invite-validation";
import { cn } from "@/lib/utils";

const NEXT_PATH = "/welcome/pay-per-execution";
const BACK_PATH = "/welcome/create-org";

type InviteRole = "member" | "admin";
type InviteRow = { id: string; value: string; role: InviteRole };

function newRow(): InviteRow {
  return { id: nanoid(), value: "", role: "member" };
}

/** Wizard step 2: invite teammates by email or wallet address. */
export function InviteMembersStep(): React.ReactElement {
  const router = useRouter();
  const { organization } = useOrganization();
  const { data: session } = useSession();
  const [rows, setRows] = useState<InviteRow[]>([newRow()]);
  const [sending, setSending] = useState(false);
  // Validation only surfaces after the user tries to continue, not while typing.
  const [showErrors, setShowErrors] = useState(false);

  const user = session?.user;
  const ownerLabel =
    user?.email && !isWalletEmail(user.email)
      ? user.email
      : (user?.name ?? "You");

  // The signed-in user is already in the org and can't be re-invited. Works for
  // every account kind: match their email (email/social) or, for wallet
  // accounts, the address in their synthetic email.
  const selfEmail = user?.email?.trim().toLowerCase();
  const selfAddress =
    selfEmail && isWalletEmail(selfEmail)
      ? (selfEmail.split("@")[0] ?? "")
      : "";

  const dupKeys = findDuplicateKeys(rows.map((row) => row.value));
  const isDuplicate = (row: InviteRow): boolean =>
    dupKeys.has(inviteKey(row.value));
  // Per-row reason, shown inline and used to gate Next. Empty rows are neutral.
  const rowError = (row: InviteRow): string | null => {
    const v = row.value.trim();
    if (!v) {
      return null;
    }
    if (isSelfInvite(v, selfEmail, selfAddress)) {
      return "You're already in this organization.";
    }
    if (isDuplicate(row)) {
      return "This invite is duplicated.";
    }
    if (!isValidInvite(v)) {
      return "Enter a valid email or wallet address.";
    }
    return null;
  };

  const updateRow = (id: string, patch: Partial<InviteRow>): void => {
    setRows((current) =>
      current.map((row) => (row.id === id ? { ...row, ...patch } : row))
    );
  };

  // Wallet invitees have no inbox; resolve the sign-in address to that account's
  // synthetic email, then invite by email so the existing flow is reused.
  const resolveWalletEmail = async (
    address: string
  ): Promise<string | null> => {
    if (!organization?.id) {
      return null;
    }
    const res = await fetch(
      `/api/organizations/${organization.id}/wallet-lookup?address=${address}`,
      { cache: "no-store" }
    );
    const data = (await res.json().catch(() => ({}))) as {
      found?: boolean;
      email?: string;
      alreadyMember?: boolean;
      error?: string;
    };
    if (!(res.ok && data.found && data.email)) {
      toast.error(data.error ?? `No account signs in with ${address} yet.`);
      return null;
    }
    if (data.alreadyMember) {
      toast.error(`${address} is already a member.`);
      return null;
    }
    return data.email;
  };

  const sendInvite = async (row: InviteRow): Promise<boolean> => {
    const value = row.value.trim();
    const email = isAddress(value) ? await resolveWalletEmail(value) : value;
    if (!email) {
      return false;
    }
    const { error } = await authClient.organization.inviteMember({
      email,
      role: row.role,
      ...(organization?.id ? { organizationId: organization.id } : {}),
    });
    if (error) {
      toast.error(error.message || `Could not invite ${value}`);
      return false;
    }
    return true;
  };

  // Validation happens here, on Next, not while typing. Empty rows are ignored;
  // to continue without inviting anyone, use Skip.
  const handleNext = async (): Promise<void> => {
    const filled = rows.filter((row) => row.value.trim());
    if (filled.length === 0) {
      setShowErrors(true);
      toast.error("Add a teammate, or skip this step.");
      return;
    }
    if (filled.some((row) => rowError(row) !== null)) {
      setShowErrors(true);
      toast.error("Fix the highlighted invites.");
      return;
    }
    setShowErrors(false);
    setSending(true);
    try {
      let sent = 0;
      for (const row of filled) {
        if (await sendInvite(row)) {
          sent += 1;
        }
      }
      if (sent > 0) {
        toast.success(`Sent ${sent} invitation${sent === 1 ? "" : "s"}`);
      }
      router.push(NEXT_PATH);
    } finally {
      setSending(false);
    }
  };

  return (
    <WelcomeShell
      busy={sending}
      description="Add teammates by email or wallet address. They can also be invited later from settings."
      onBack={() => router.push(BACK_PATH)}
      onNext={handleNext}
      onSkip={() => router.push(NEXT_PATH)}
      preview={
        <InvitePreview
          invitees={rows
            .filter((row) => row.value.trim().length > 0)
            .map((row) => ({ label: row.value.trim(), role: row.role }))}
          orgName={organization?.name ?? "Your Organization"}
          ownerLabel={ownerLabel}
        />
      }
      stepIndex={1}
      title="Invite your team"
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 text-muted-foreground text-xs">
            <span className="flex-1">Email or wallet address</span>
            <span className="w-28 shrink-0">Role</span>
            <span className="size-9 shrink-0" />
          </div>
          {rows.map((row) => {
            const error = showErrors ? rowError(row) : null;
            return (
              <div className="flex flex-col gap-1" key={row.id}>
                <div className="flex items-center gap-2">
                  <Input
                    className={cn(
                      "flex-1",
                      error &&
                        "border-destructive focus-visible:ring-destructive"
                    )}
                    onChange={(e) =>
                      updateRow(row.id, { value: e.target.value })
                    }
                    placeholder="Email or wallet address"
                    value={row.value}
                  />
                  <Select
                    onValueChange={(v) =>
                      updateRow(row.id, { role: v as InviteRole })
                    }
                    value={row.role}
                  >
                    <SelectTrigger className="w-28 shrink-0">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="member">Member</SelectItem>
                      <SelectItem value="admin">Admin</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button
                    aria-label="Remove"
                    className={rows.length > 1 ? "" : "invisible"}
                    onClick={() =>
                      setRows((current) =>
                        current.filter((r) => r.id !== row.id)
                      )
                    }
                    size="icon"
                    type="button"
                    variant="ghost"
                  >
                    <X className="size-4" />
                  </Button>
                </div>
                {error ? (
                  <p className="text-destructive text-xs">{error}</p>
                ) : null}
              </div>
            );
          })}
        </div>
        <Button
          className="w-fit"
          disabled={rows.some((row) => !row.value.trim())}
          onClick={() => setRows((current) => [...current, newRow()])}
          size="sm"
          type="button"
          variant="outline"
        >
          <Plus className="size-4" />
          Add another
        </Button>
      </div>
    </WelcomeShell>
  );
}
