"use client";

import {
  ArrowLeft,
  Check,
  Copy,
  LogOut,
  Mail,
  Pencil,
  Plus,
  RotateCw,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { isAddress } from "viem";
import { ExecutionDigestSection } from "@/components/organization/execution-digest-section";
import { MemberSessionsDialog } from "@/components/organization/member-sessions-dialog";
import { MfaEnforcementSection } from "@/components/organization/mfa-enforcement-section";
import { SpendCapSection } from "@/components/organization/spend-cap-section";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
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
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ApiError, api } from "@/lib/api-client";
import { isWalletEmail } from "@/lib/auth/wallet-constants";
import { authClient } from "@/lib/auth-client";
import {
  useActiveMember,
  useOrganization,
  useOrganizations,
} from "@/lib/hooks/use-organization";
import { refetchOrganizations } from "@/lib/refetch-organizations";
import type { MemberRole } from "@/lib/types/organization";
import { acceptWalletInvite } from "@/lib/wallet/invite-accept-client";

// Helper function to get status badge classes
function getStatusBadgeClasses(status: string): string {
  switch (status) {
    case "accepted":
      return "bg-green-100 text-green-700";
    case "rejected":
    case "cancelled":
      return "bg-red-100 text-red-700";
    case "expired":
      return "bg-orange-100 text-orange-700";
    default:
      return "bg-muted text-muted-foreground";
  }
}

// Component to render a received invitation item
type ReceivedInvitationItemProps = {
  invitation: {
    id: string;
    organizationId?: string;
    organizationName?: string;
    organization?: { name?: string };
    role?: string;
    status?: string;
    expiresAt?: Date | string;
    inviterId?: string;
    inviter?: { user?: { name?: string } };
  };
  processingInvite: string | null;
  onAccept: (invitationId: string) => void;
  onReject: (invitationId: string) => void;
};

function ReceivedInvitationItem({
  invitation,
  processingInvite,
  onAccept,
  onReject,
}: ReceivedInvitationItemProps) {
  const isExpired = invitation.expiresAt
    ? new Date(invitation.expiresAt) < new Date()
    : false;
  const isPending =
    (!invitation.status || invitation.status === "pending") && !isExpired;
  const displayStatus = isExpired ? "expired" : invitation.status || "pending";

  // Use organization name from enriched data or fallback
  const organizationName =
    invitation.organizationName ||
    invitation.organization?.name ||
    "Organization";

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div>
        <h3 className="font-semibold">{organizationName}</h3>
        <p className="text-muted-foreground text-sm">Role: {invitation.role}</p>
        {invitation.inviter?.user?.name && (
          <p className="text-muted-foreground text-sm">
            Invited by: {invitation.inviter.user.name}
          </p>
        )}
      </div>
      {isPending ? (
        <div className="flex gap-2">
          <Button
            className="flex-1"
            disabled={processingInvite === invitation.id}
            onClick={() => onAccept(invitation.id)}
          >
            {processingInvite === invitation.id ? "Accepting..." : "Accept"}
          </Button>
          <Button
            className="flex-1"
            disabled={processingInvite === invitation.id}
            onClick={() => onReject(invitation.id)}
            variant="outline"
          >
            {processingInvite === invitation.id ? "Rejecting..." : "Reject"}
          </Button>
        </div>
      ) : (
        <div
          className={`rounded-md px-3 py-2 text-center font-medium text-sm ${getStatusBadgeClasses(displayStatus)}`}
        >
          {displayStatus.charAt(0).toUpperCase() + displayStatus.slice(1)}
        </div>
      )}
    </div>
  );
}

// Component to render the members list with loading state
type MembersListContentProps = {
  loadingMembers: boolean;
  loadingSentInvitations: boolean;
  members: {
    id: string;
    userId: string;
    role: string;
    user: { email?: string };
  }[];
  sentInvitations: {
    id: string;
    email: string;
    role?: string;
    status: string;
    expiresAt?: Date | string;
  }[];
  canInvite: boolean;
  currentUserRole?: MemberRole;
  cancellingInvite: string | null;
  onCancelInvitation: (invitationId: string) => Promise<void>;
  onResendInvitation: (
    invitationId: string,
    email: string,
    role: string
  ) => Promise<void>;
  removingMember: string | null;
  onRemoveMember: (memberId: string, email: string) => Promise<void>;
  currentUserId?: string;
  onUpdateMemberRole?: (memberId: string, role: string) => Promise<void>;
  updatingRoleMemberId?: string | null;
  organizationId?: string | null;
  /** 2FA enrollment per member user id. Only populated for owners/admins. */
  twoFactorStatuses?: Record<string, boolean>;
};

function MembersListContent({
  loadingMembers,
  loadingSentInvitations,
  members,
  sentInvitations,
  canInvite,
  currentUserRole,
  cancellingInvite,
  onCancelInvitation,
  onResendInvitation,
  removingMember,
  onRemoveMember,
  currentUserId,
  onUpdateMemberRole,
  updatingRoleMemberId,
  organizationId,
  twoFactorStatuses,
}: MembersListContentProps) {
  const [pendingAction, setPendingAction] = useState<{
    type: "revoke" | "remove" | "resend" | "remove-member";
    id: string;
    email: string;
    role: string;
  } | null>(null);
  const [confirming, setConfirming] = useState(false);

  if (loadingMembers || loadingSentInvitations) {
    return (
      <div className="flex items-center justify-center py-8">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  const pendingInvitations = sentInvitations.filter(
    (inv) => inv.status === "pending"
  );

  if (members.length === 0 && pendingInvitations.length === 0) {
    return null;
  }

  const entries = [
    ...members.map((m) => ({
      kind: "member" as const,
      email: m.user?.email || "Unknown",
      role: m.role,
      id: m.id,
      userId: m.userId,
      expired: false,
    })),
    ...pendingInvitations.map((inv) => ({
      kind: "invite" as const,
      email: inv.email,
      role: inv.role || "member",
      id: inv.id,
      userId: undefined as string | undefined,
      expired: inv.expiresAt ? new Date(inv.expiresAt) < new Date() : false,
    })),
  ].sort((a, b) =>
    a.email.localeCompare(b.email, undefined, { sensitivity: "base" })
  );

  const canChangeRole =
    canInvite && onUpdateMemberRole && currentUserRole === "owner";
  const canChangeRoleToMemberOrAdminOnly =
    canInvite && onUpdateMemberRole && currentUserRole === "admin";

  return (
    <div className="space-y-2">
      {entries.map((entry) => (
        <div
          className="flex items-center justify-between gap-2 rounded-lg border p-3"
          key={entry.id}
        >
          <div className="min-w-0 flex-1">
            <p
              className={`truncate font-medium text-sm ${entry.kind === "invite" ? "text-muted-foreground" : ""}`}
              title={entry.email}
            >
              {entry.email}
            </p>
            <div className="flex items-center gap-2">
              <p className="text-muted-foreground text-xs">
                {entry.role}
                {entry.kind === "invite" &&
                  (entry.expired ? " - expired" : " - invited")}
              </p>
              {entry.kind === "member" &&
                entry.userId &&
                twoFactorStatuses?.[entry.userId] !== undefined &&
                (twoFactorStatuses[entry.userId] ? (
                  <Badge
                    className="gap-1 border-keeperhub-green/30 bg-keeperhub-green/10 text-keeperhub-green"
                    variant="outline"
                  >
                    <ShieldCheck />
                    2FA on
                  </Badge>
                ) : (
                  <Badge className="gap-1" variant="destructive">
                    <ShieldAlert />
                    No 2FA
                  </Badge>
                ))}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {entry.kind === "member" && canInvite && organizationId && (
              <MemberSessionsDialog
                email={entry.email}
                memberId={entry.id}
                organizationId={organizationId}
              />
            )}
            {entry.kind === "member" &&
              entry.userId !== currentUserId &&
              (canChangeRole ||
                (canChangeRoleToMemberOrAdminOnly &&
                  entry.role !== "owner")) && (
                <Select
                  disabled={updatingRoleMemberId === entry.id}
                  onValueChange={(role) => onUpdateMemberRole(entry.id, role)}
                  value={entry.role}
                >
                  <SelectTrigger className="h-8 w-[120px]">
                    <SelectValue />
                  </SelectTrigger>
                  {/* One owner per org (DB-enforced), so becoming owner is a transfer, handled in the Leave Organization flow. */}
                  <SelectContent>
                    <SelectItem value={"member"}>Member</SelectItem>
                    <SelectItem value={"admin"}>Admin</SelectItem>
                  </SelectContent>
                </Select>
              )}
            {entry.kind === "invite" && canInvite && entry.expired && (
              <>
                <Button
                  disabled={cancellingInvite === entry.id}
                  onClick={() =>
                    setPendingAction({
                      type: "resend",
                      id: entry.id,
                      email: entry.email,
                      role: entry.role,
                    })
                  }
                  size="sm"
                  variant="ghost"
                >
                  <RotateCw className="mr-1 h-4 w-4" />
                  Resend
                </Button>
                <Button
                  disabled={cancellingInvite === entry.id}
                  onClick={() =>
                    setPendingAction({
                      type: "remove",
                      id: entry.id,
                      email: entry.email,
                      role: entry.role,
                    })
                  }
                  size="sm"
                  variant="ghost"
                >
                  <X className="mr-1 h-4 w-4" />
                  Remove
                </Button>
              </>
            )}
            {entry.kind === "invite" && canInvite && !entry.expired && (
              <>
                <Button
                  onClick={async () => {
                    const link = `${window.location.origin}/accept-invite/${entry.id}`;
                    try {
                      await navigator.clipboard.writeText(link);
                      toast.success("Invite link copied");
                    } catch {
                      toast.error("Could not copy the invite link");
                    }
                  }}
                  size="sm"
                  variant="ghost"
                >
                  <Copy className="mr-1 h-4 w-4" />
                  Copy link
                </Button>
                <Button
                  disabled={cancellingInvite === entry.id}
                  onClick={() =>
                    setPendingAction({
                      type: "revoke",
                      id: entry.id,
                      email: entry.email,
                      role: entry.role,
                    })
                  }
                  size="sm"
                  variant="ghost"
                >
                  <X className="mr-1 h-4 w-4" />
                  Revoke Invitation
                </Button>
              </>
            )}
            {entry.kind === "member" &&
              canInvite &&
              entry.userId !== currentUserId &&
              (currentUserRole === "owner" || entry.role === "member") && (
                <Button
                  aria-label={`Remove ${entry.email}`}
                  disabled={removingMember === entry.id}
                  onClick={() =>
                    setPendingAction({
                      type: "remove-member",
                      id: entry.id,
                      email: entry.email,
                      role: entry.role,
                    })
                  }
                  size="icon"
                  title="Remove member"
                  variant="ghost"
                >
                  <X className="h-4 w-4" />
                </Button>
              )}
          </div>
        </div>
      ))}

      <AlertDialog
        onOpenChange={(isOpen) => {
          if (!(isOpen || confirming)) {
            setPendingAction(null);
          }
        }}
        open={pendingAction !== null}
      >
        {pendingAction && (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {
                  {
                    resend: "Resend Invitation",
                    remove: "Remove Invitation",
                    revoke: "Revoke Invitation",
                    "remove-member": "Remove Member",
                  }[pendingAction.type]
                }
              </AlertDialogTitle>
              <AlertDialogDescription>
                {
                  {
                    resend: `Cancel the expired invitation and send a new one to ${pendingAction.email}?`,
                    remove: `Remove the expired invitation for ${pendingAction.email}?`,
                    revoke: `Revoke the pending invitation for ${pendingAction.email}?`,
                    "remove-member": `Remove ${pendingAction.email} from the organization?`,
                  }[pendingAction.type]
                }
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={confirming}>
                Cancel
              </AlertDialogCancel>
              <Button
                disabled={confirming}
                onClick={async () => {
                  setConfirming(true);
                  try {
                    if (pendingAction.type === "resend") {
                      await onResendInvitation(
                        pendingAction.id,
                        pendingAction.email,
                        pendingAction.role
                      );
                    } else if (pendingAction.type === "remove-member") {
                      await onRemoveMember(
                        pendingAction.id,
                        pendingAction.email
                      );
                    } else {
                      await onCancelInvitation(pendingAction.id);
                    }
                  } finally {
                    setConfirming(false);
                    setPendingAction(null);
                  }
                }}
              >
                {confirming && <Spinner className="mr-2 h-4 w-4" />}
                {pendingAction.type === "resend" ? "Resend" : "Confirm"}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>
    </div>
  );
}

type ManageOrgsModalProps = {
  triggerText?: string;
  defaultShowCreateForm?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  // When set, this instance consumes the `?digestSettings=<orgId>` deep link
  // from digest emails: it opens the modal on the Notifications tab for that
  // org. Enable on exactly one always-mounted instance to avoid double-opens.
  consumeDeepLink?: boolean;
};

export function ManageOrgsModal({
  triggerText,
  defaultShowCreateForm = false,
  open: externalOpen,
  onOpenChange: externalOnOpenChange,
  consumeDeepLink = false,
}: ManageOrgsModalProps = {}) {
  const [internalOpen, setInternalOpen] = useState(false);

  // Use external state if provided, otherwise use internal state
  const open = externalOpen === undefined ? internalOpen : externalOpen;
  const setOpen = externalOnOpenChange || setInternalOpen;
  const [activeTab, setActiveTab] = useState("organizations");
  const [showCreateForm, setShowCreateForm] = useState(defaultShowCreateForm);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showLeaveDialog, setShowLeaveDialog] = useState(false);
  const [showAssignOwnerDialog, setShowAssignOwnerDialog] = useState(false);
  const [assignOwnerSelectedMemberId, setAssignOwnerSelectedMemberId] =
    useState<string | null>(null);

  // Track which org is being managed (null = list view, string = detail view)
  const [managedOrgId, setManagedOrgIdRaw] = useState<string | null>(null);
  const managedOrgIdRef = useRef<string | null>(managedOrgId);
  managedOrgIdRef.current = managedOrgId;

  // Loading states for org-specific data (declared early for setManagedOrgId wrapper)
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [loadingSentInvitations, setLoadingSentInvitations] = useState(false);

  // Wrapper to set loading states immediately when switching orgs
  const setManagedOrgId = useCallback((orgId: string | null) => {
    if (orgId !== null) {
      setLoadingMembers(true);
      setLoadingSentInvitations(true);
    }
    setManagedOrgIdRaw(orgId);
  }, []);

  const { organization, switchOrganization } = useOrganization();
  const { organizations } = useOrganizations();
  const {
    isOwner: isActiveOrgOwner,
    isAdmin: isActiveOrgAdmin,
    role: activeOrgRole,
  } = useActiveMember();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session } = authClient.useSession();

  // Arrive from a digest email's "manage emails" link
  // (`?digestSettings=<orgId>`): switch to that org so the whole context (org
  // dropdown, role, plan) matches, then open the modal on the Notifications tab
  // once the switch settles so it's correct on first paint. Runs once; the param
  // is stripped via history so it can't re-trigger.
  const deepLinkConsumedRef = useRef(false);
  useEffect(() => {
    if (!consumeDeepLink) {
      return;
    }
    const deepLinkOrgId = searchParams.get("digestSettings");
    if (!deepLinkOrgId) {
      deepLinkConsumedRef.current = false;
      return;
    }
    if (deepLinkConsumedRef.current) {
      return;
    }
    deepLinkConsumedRef.current = true;
    const url = new URL(window.location.href);
    url.searchParams.delete("digestSettings");
    window.history.replaceState(null, "", url.toString());
    setActiveTab("notifications");
    if (organization?.id === deepLinkOrgId) {
      setOpen(true);
      return;
    }
    switchOrganization(deepLinkOrgId).finally(() => setOpen(true));
  }, [
    consumeDeepLink,
    searchParams,
    organization?.id,
    switchOrganization,
    setOpen,
  ]);

  // Reset to the default tab when the modal closes so reopening it manually
  // doesn't land on the deep-linked Notifications tab.
  const handleDialogOpenChange = useCallback(
    (next: boolean): void => {
      setOpen(next);
      if (!next) {
        setActiveTab("organizations");
      }
    },
    [setOpen]
  );

  // Get the managed organization object (for detail view)
  const managedOrg = managedOrgId
    ? organizations.find((org) => org.id === managedOrgId)
    : null;
  const managedOrgName = managedOrg?.name ?? "";

  // Determine if the managed org is the active session org
  const isManagedOrgActive = managedOrgId === organization?.id;

  // Create organization state
  const [orgName, setOrgName] = useState("");
  const [orgSlug, setOrgSlug] = useState("");
  const [orgSlugManuallyEdited, setOrgSlugManuallyEdited] = useState(false);
  const [createLoading, setCreateLoading] = useState(false);

  // Organization name editing state (managed org detail view)
  const [isEditingOrgName, setIsEditingOrgName] = useState(false);
  const [editingOrgName, setEditingOrgName] = useState("");
  const [updatingOrgName, setUpdatingOrgName] = useState(false);

  // Invite state
  const [inviteMode, setInviteMode] = useState<"email" | "wallet">("email");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteAddress, setInviteAddress] = useState("");
  const [inviteRole, setInviteRole] = useState<MemberRole>("member");
  const [inviteLoading, setInviteLoading] = useState(false);
  const [inviteId, setInviteId] = useState<string | null>(null);

  // Invitations state (received by current user)
  type Invitation = {
    id: string;
    email?: string;
    organizationId?: string;
    organizationName?: string;
    organization?: { name?: string };
    role?: string;
    status?: string;
    expiresAt?: Date | string;
    inviterId?: string;
    inviter?: { user?: { name?: string } };
  };
  const [userInvitations, setUserInvitations] = useState<Invitation[]>([]);
  const [, setLoadingInvitations] = useState(false);
  const [processingInvite, setProcessingInvite] = useState<string | null>(null);

  // Sent invitations state (invitations sent by org admins)
  type SentInvitation = {
    id: string;
    email: string;
    role?: string;
    status: string;
    expiresAt?: Date | string;
  };
  const [sentInvitations, setSentInvitations] = useState<SentInvitation[]>([]);
  const [cancellingInvite, setCancellingInvite] = useState<string | null>(null);
  const [removingMember, setRemovingMember] = useState<string | null>(null);
  const [updatingRoleMemberId, setUpdatingRoleMemberId] = useState<
    string | null
  >(null);

  // Organization members state
  type Member = {
    id: string;
    userId: string;
    role: string;
    createdAt?: Date;
    user: {
      name?: string;
      email?: string;
      image?: string;
    };
  };
  const [members, setMembers] = useState<Member[]>([]);
  // 2FA enrollment per member user id, fetched for owners/admins only.
  const [twoFactorStatuses, setTwoFactorStatuses] = useState<
    Record<string, boolean>
  >({});

  // Compute user's role in the managed org from fetched members
  const currentUserMember = members.find((m) => m.userId === session?.user?.id);
  const managedOrgRole = currentUserMember?.role as MemberRole | undefined;
  const isOwner = isManagedOrgActive
    ? isActiveOrgOwner
    : managedOrgRole === "owner";
  const canInvite = isManagedOrgActive
    ? isActiveOrgOwner || isActiveOrgAdmin
    : managedOrgRole === "owner" || managedOrgRole === "admin";
  const currentUserRole = isManagedOrgActive ? activeOrgRole : managedOrgRole;

  const ownerCount = members.filter((m) => m.role === "owner").length;
  // Only accepted members (from listMembers); pending invitations are not included
  const otherMembers = members.filter((m) => m.userId !== session?.user?.id);
  const isOnlyOwner = isOwner && ownerCount === 1;
  const canLeaveAsOwner = !isOnlyOwner || otherMembers.length > 0;

  const fetchInvitations = useCallback(async () => {
    setLoadingInvitations(true);
    try {
      const result = await authClient.organization.listUserInvitations();
      if (result.data) {
        const invitations = Array.isArray(result.data) ? result.data : [];

        // Fetch organization names for each invitation using our custom API
        const enrichedInvitations = await Promise.all(
          invitations.map(async (inv: Invitation) => {
            try {
              const response = await fetch(`/api/invitations/${inv.id}`);
              const data = await response.json();
              // Extract organization name from response (works for both OK and 410 responses)
              const extractedOrgName =
                data.invitation?.organizationName || data.organizationName;
              if (extractedOrgName) {
                return {
                  ...inv,
                  organizationName: extractedOrgName,
                };
              }
            } catch {
              // Ignore errors, just use the original invitation
            }
            return inv;
          })
        );

        setUserInvitations(enrichedInvitations);
      }
    } catch (error) {
      console.error("Failed to fetch invitations:", error);
    } finally {
      setLoadingInvitations(false);
    }
  }, []);

  // Fetch sent invitations for the managed organization (for admins)
  const organizationId = managedOrgId;
  const isStaleRequest = useCallback(
    (orgIdAtStart: string) => managedOrgIdRef.current !== orgIdAtStart,
    []
  );

  const fetchSentInvitations = useCallback(async () => {
    if (!organizationId) {
      return;
    }

    const orgIdAtStart = organizationId;
    setLoadingSentInvitations(true);

    try {
      const result = await authClient.organization.listInvitations({
        query: { organizationId },
      });
      if (isStaleRequest(orgIdAtStart)) {
        return;
      }

      const invitations = Array.isArray(result.data)
        ? result.data
        : [result.data].filter(Boolean);
      setSentInvitations(invitations.filter(Boolean) as SentInvitation[]);
    } catch (error) {
      console.error("Failed to fetch sent invitations:", error);
      if (!isStaleRequest(orgIdAtStart)) {
        setSentInvitations([]);
      }
    } finally {
      if (!isStaleRequest(orgIdAtStart)) {
        setLoadingSentInvitations(false);
      }
    }
  }, [organizationId, isStaleRequest]);

  // Fetch organization members
  const fetchMembers = useCallback(async () => {
    if (!organizationId) {
      return;
    }

    const orgIdAtStart = organizationId;
    setLoadingMembers(true);

    try {
      const result = await authClient.organization.listMembers({
        query: { organizationId },
      });
      if (isStaleRequest(orgIdAtStart)) {
        return;
      }

      // API returns { members: [...], total: number } or Member[]
      const data = result.data as { members?: Member[] } | Member[];
      const membersList = Array.isArray(data) ? data : (data.members ?? []);
      setMembers(membersList.filter(Boolean) as Member[]);
    } catch (error) {
      console.error("Failed to fetch members:", error);
      if (!isStaleRequest(orgIdAtStart)) {
        setMembers([]);
      }
    } finally {
      if (!isStaleRequest(orgIdAtStart)) {
        setLoadingMembers(false);
      }
    }
  }, [organizationId, isStaleRequest]);

  // Fetch per-member 2FA status. Owner/admin-gated on the server; we only
  // call it when the caller can manage the org to avoid a guaranteed 403.
  const fetchTwoFactorStatuses = useCallback(async () => {
    if (!organizationId) {
      return;
    }

    const orgIdAtStart = organizationId;
    try {
      const result =
        await api.organization.memberTwoFactorStatus(organizationId);
      if (isStaleRequest(orgIdAtStart)) {
        return;
      }
      setTwoFactorStatuses(result.statuses);
    } catch (error) {
      console.error("Failed to fetch member 2FA status:", error);
      if (!isStaleRequest(orgIdAtStart)) {
        setTwoFactorStatuses({});
      }
    }
  }, [organizationId, isStaleRequest]);

  // Fetch invitations when modal opens
  useEffect(() => {
    if (open) {
      fetchInvitations();
    }
  }, [open, fetchInvitations]);

  // Fetch org-specific data when managed org changes
  useEffect(() => {
    if (open && managedOrgId) {
      setMembers([]);
      setSentInvitations([]);
      setTwoFactorStatuses({});
      fetchSentInvitations();
      fetchMembers();
    }
  }, [open, managedOrgId, fetchSentInvitations, fetchMembers]);

  // Load 2FA status once we know the caller manages the org. canInvite is
  // derived from the fetched members, so this runs after fetchMembers settles.
  useEffect(() => {
    if (open && managedOrgId && canInvite) {
      fetchTwoFactorStatuses();
    }
  }, [open, managedOrgId, canInvite, fetchTwoFactorStatuses]);

  // Keep edit input in sync when switching orgs / name updates
  const lastManagedOrgIdForNameEditRef = useRef<string | null>(null);

  useEffect(() => {
    if (lastManagedOrgIdForNameEditRef.current !== managedOrgId) {
      lastManagedOrgIdForNameEditRef.current = managedOrgId;
      setIsEditingOrgName(false);
    }

    if (!managedOrgId) {
      setEditingOrgName("");
      return;
    }

    if (isEditingOrgName) {
      return;
    }

    setEditingOrgName(managedOrgName);
  }, [managedOrgId, managedOrgName, isEditingOrgName]);

  // Reset managed org when modal closes
  useEffect(() => {
    if (!open) {
      setManagedOrgId(null);
      setInviteId(null);
    }
  }, [open, setManagedOrgId]);

  const handleOrgNameChange = (value: string) => {
    setOrgName(value);
    if (!orgSlugManuallyEdited) {
      setOrgSlug(value.toLowerCase().replace(/[^a-z0-9]+/g, "-"));
    }
  };

  const handleOrgSlugChange = (value: string) => {
    setOrgSlug(value);
    setOrgSlugManuallyEdited(true);
  };

  const handleCreateOrg = async () => {
    if (!(orgName && orgSlug)) {
      return;
    }

    setCreateLoading(true);
    try {
      const { data, error } = await authClient.organization.create({
        name: orgName,
        slug: orgSlug,
      });

      if (error) {
        toast.error(error.message || "Failed to create organization");
        return;
      }

      const orgId = (data as { id: string } | null)?.id;
      if (orgId) {
        await authClient.organization.setActive({ organizationId: orgId });
        toast.success(`Organization "${orgName}" created`);
        setOrgName("");
        setOrgSlug("");
        setOrgSlugManuallyEdited(false);
        setShowCreateForm(false);
        refetchOrganizations();
        router.refresh();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setCreateLoading(false);
    }
  };

  // Wallet invitees have no inbox; resolve the sign-in address to that account's
  // synthetic email so the existing email-keyed invite flow is reused.
  const resolveInviteWalletEmail = async (): Promise<string | null> => {
    if (!managedOrgId) {
      return null;
    }
    if (!isAddress(inviteAddress.trim())) {
      toast.error("Enter a valid wallet address.");
      return null;
    }
    const res = await fetch(
      `/api/organizations/${managedOrgId}/wallet-lookup?address=${inviteAddress.trim()}`,
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

  const handleInviteMember = async () => {
    if (!managedOrgId) {
      return;
    }
    if (inviteMode === "email" && !inviteEmail) {
      return;
    }

    setInviteLoading(true);
    try {
      const targetEmail =
        inviteMode === "wallet"
          ? await resolveInviteWalletEmail()
          : inviteEmail;
      if (!targetEmail) {
        return;
      }

      const { data, error } = await authClient.organization.inviteMember({
        email: targetEmail,
        role: inviteRole,
        organizationId: managedOrgId,
      });

      if (error) {
        toast.error(error.message || "Failed to send invitation");
        return;
      }

      const invitationData = data as {
        id?: string;
        invitation?: { id?: string };
      } | null;
      const invitationId = invitationData?.id || invitationData?.invitation?.id;
      if (invitationId) {
        setInviteId(invitationId);
        toast.success(
          inviteMode === "wallet"
            ? "Invitation created. Share the link so they can sign to join."
            : `Invitation sent to ${targetEmail}`
        );
        setInviteEmail("");
        setInviteAddress("");
        // Refresh sent invitations list
        fetchSentInvitations();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setInviteLoading(false);
    }
  };

  const handleCancelInvitation = async (invitationId: string) => {
    setCancellingInvite(invitationId);
    try {
      const { error } = await authClient.organization.cancelInvitation({
        invitationId,
      });

      if (error) {
        toast.error(error.message || "Failed to revoke invitation");
        fetchSentInvitations();
        return;
      }

      toast.success("Invitation removed");
      fetchSentInvitations();
      fetchMembers();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setCancellingInvite(null);
    }
  };

  const handleResendInvitation = async (
    invitationId: string,
    email: string,
    role: string
  ): Promise<void> => {
    if (!managedOrgId) {
      return;
    }

    setCancellingInvite(invitationId);
    try {
      const { error: cancelError } =
        await authClient.organization.cancelInvitation({ invitationId });

      if (cancelError) {
        toast.error(
          cancelError.message || "Failed to cancel expired invitation"
        );
        fetchSentInvitations();
        return;
      }

      const { error: inviteError } = await authClient.organization.inviteMember(
        {
          email,
          role: role as "member" | "admin" | "owner",
          organizationId: managedOrgId,
        }
      );

      if (inviteError) {
        toast.error(inviteError.message || "Failed to resend invitation");
        fetchSentInvitations();
        return;
      }

      toast.success(`Invitation resent to ${email}`);
      fetchSentInvitations();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "An error occurred");
      fetchSentInvitations();
    } finally {
      setCancellingInvite(null);
    }
  };

  const handleRemoveMember = async (_memberId: string, email: string) => {
    setRemovingMember(_memberId);
    try {
      const { error } = await authClient.organization.removeMember({
        memberIdOrEmail: email,
      });

      if (error) {
        toast.error(error.message || "Failed to remove member");
        return;
      }

      toast.success("Member removed from organization");
      fetchMembers();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setRemovingMember(null);
    }
  };

  const handleUpdateMemberRole = useCallback(
    async (memberId: string, role: string) => {
      if (!managedOrgId) {
        return;
      }
      setUpdatingRoleMemberId(memberId);
      try {
        const { error } = await authClient.organization.updateMemberRole({
          memberId,
          role,
          organizationId: managedOrgId,
        });

        if (error) {
          toast.error(error.message || "Failed to update role");
          return;
        }

        toast.success("Role updated");
        fetchMembers();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "An error occurred");
      } finally {
        setUpdatingRoleMemberId(null);
      }
    },
    [managedOrgId, fetchMembers]
  );

  const handleAcceptInvitation = async (invitationId: string) => {
    setProcessingInvite(invitationId);
    try {
      // Route by the invitation's target email: wallet invites (sent to a
      // synthetic wallet email) require a signed challenge, not email-match.
      const invitation = userInvitations.find((inv) => inv.id === invitationId);
      if (isWalletEmail(invitation?.email)) {
        await acceptWalletInvite(invitationId);
      } else {
        const result = await authClient.organization.acceptInvitation({
          invitationId,
        });
        if (result.error) {
          toast.error(
            result.error.message ||
              result.error.code ||
              "Failed to accept invitation"
          );
          return;
        }
      }

      toast.success("Invitation accepted! You are now a member.");
      // Remove accepted invitation from list immediately
      setUserInvitations((prev) =>
        prev.filter((inv) => inv.id !== invitationId)
      );
      // Refresh the organizations list so the new org appears in the dropdown
      refetchOrganizations();
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setProcessingInvite(null);
    }
  };

  const handleRejectInvitation = async (invitationId: string) => {
    setProcessingInvite(invitationId);
    try {
      const { error } = await authClient.organization.rejectInvitation({
        invitationId,
      });

      if (error) {
        toast.error(error.message || "Failed to reject invitation");
        return;
      }

      toast.success("Invitation rejected");
      fetchInvitations();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setProcessingInvite(null);
    }
  };

  const handleLeaveOrg = useCallback(async () => {
    if (!managedOrg) {
      return;
    }

    try {
      await api.organization.leave(managedOrg.id, {});

      toast.success(`Left ${managedOrg.name}`);
      setShowLeaveDialog(false);
      setShowAssignOwnerDialog(false);
      setManagedOrgId(null);

      if (isManagedOrgActive) {
        const otherOrg = organizations.find((org) => org.id !== managedOrg.id);
        if (otherOrg) {
          await switchOrganization(otherOrg.id);
        }
      }

      refetchOrganizations();
      router.refresh();
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : "Failed to leave organization";
      toast.error(message);
    }
  }, [
    managedOrg,
    isManagedOrgActive,
    organizations,
    setManagedOrgId,
    switchOrganization,
    router,
  ]);

  const handleLeaveClick = useCallback(() => {
    if (!isOwner) {
      setShowLeaveDialog(true);
      return;
    }
    if (!canLeaveAsOwner) {
      return;
    }
    if (isOnlyOwner && otherMembers.length > 0) {
      setAssignOwnerSelectedMemberId(otherMembers[0]?.id ?? null);
      setShowAssignOwnerDialog(true);
    } else {
      setShowLeaveDialog(true);
    }
  }, [isOwner, canLeaveAsOwner, isOnlyOwner, otherMembers]);

  const handleAssignOwnerAndLeave = useCallback(async () => {
    if (!(managedOrgId && assignOwnerSelectedMemberId && managedOrg)) {
      return;
    }
    const isAcceptedMember = otherMembers.some(
      (m) => m.id === assignOwnerSelectedMemberId
    );
    if (!isAcceptedMember) {
      toast.error(
        "Selected user must be an accepted member of this organization. Only members who have accepted their invitation can be assigned as owner."
      );
      return;
    }
    try {
      await api.organization.leave(managedOrgId, {
        newOwnerMemberId: assignOwnerSelectedMemberId,
      });

      toast.success(`Left ${managedOrg.name}`);
      setShowAssignOwnerDialog(false);
      setManagedOrgId(null);

      if (isManagedOrgActive) {
        const otherOrg = organizations.find((org) => org.id !== managedOrg.id);
        if (otherOrg) {
          await switchOrganization(otherOrg.id);
        }
      }

      refetchOrganizations();
      router.refresh();
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : "An error occurred";
      toast.error(message);
    }
  }, [
    managedOrgId,
    assignOwnerSelectedMemberId,
    managedOrg,
    otherMembers,
    isManagedOrgActive,
    organizations,
    setManagedOrgId,
    switchOrganization,
    router,
  ]);

  const handleDeleteOrg = async () => {
    if (!managedOrg) {
      return;
    }

    try {
      const { error } = await authClient.organization.delete({
        organizationId: managedOrg.id,
      });

      if (error) {
        toast.error(error.message || "Failed to delete organization");
        return;
      }

      toast.success(`Deleted ${managedOrg.name}`);
      setShowDeleteDialog(false);
      setManagedOrgId(null);

      // If we deleted the active org, switch to another org if available
      if (isManagedOrgActive) {
        const otherOrg = organizations.find((org) => org.id !== managedOrg.id);
        if (otherOrg) {
          await switchOrganization(otherOrg.id);
        }
      }

      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "An error occurred");
    }
  };

  const handleUpdateOrgName = async () => {
    if (!(managedOrgId && managedOrg)) {
      return;
    }

    const nextName = editingOrgName.trim();

    if (!nextName) {
      toast.error("Organization name is required");
      return;
    }

    if (nextName === managedOrg.name) {
      setIsEditingOrgName(false);
      return;
    }

    setUpdatingOrgName(true);
    try {
      await api.organization.updateName(managedOrgId, { name: nextName });
      toast.success("Organization name updated");
      setIsEditingOrgName(false);
      refetchOrganizations();
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update name");
    } finally {
      setUpdatingOrgName(false);
    }
  };

  return (
    <>
      <Dialog onOpenChange={handleDialogOpenChange} open={open}>
        {/* Only show trigger when not controlled externally */}
        {externalOpen === undefined && (
          <DialogTrigger asChild>
            {triggerText ? (
              <Button size="sm" variant="default">
                {triggerText}
              </Button>
            ) : (
              <Button size="sm" variant="ghost">
                <Settings className="h-4 w-4" />
              </Button>
            )}
          </DialogTrigger>
        )}
        <DialogContent className="h-[600px] max-h-[85vh] max-w-2xl content-start overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Manage Organizations</DialogTitle>
            <DialogDescription>
              Create organizations, manage invitations, and organize your team.
            </DialogDescription>
          </DialogHeader>

          <Tabs
            className="w-full"
            onValueChange={setActiveTab}
            value={activeTab}
          >
            <TabsList className="grid w-full grid-cols-5">
              <TabsTrigger value="organizations">Organizations</TabsTrigger>
              <TabsTrigger value="invitations">
                Invitations
                {userInvitations && userInvitations.length > 0 && (
                  <span className="ml-2 rounded-full bg-primary px-2 py-0.5 text-primary-foreground text-xs">
                    {userInvitations.length}
                  </span>
                )}
              </TabsTrigger>
              <TabsTrigger value="notifications">Notifications</TabsTrigger>
              <TabsTrigger value="security">Security</TabsTrigger>
              <TabsTrigger value="limits">Limits</TabsTrigger>
            </TabsList>

            <TabsContent className="space-y-4" value="organizations">
              {/* LIST VIEW - Show when no org is being managed */}
              {!managedOrgId && (
                <>
                  {/* Create Organization Section */}
                  <div className="space-y-3 rounded-lg border p-4">
                    {showCreateForm ? (
                      <div className="space-y-3">
                        <div className="space-y-2">
                          <Label htmlFor="org-name">Organization Name</Label>
                          <Input
                            disabled={createLoading}
                            id="org-name"
                            onChange={(e) =>
                              handleOrgNameChange(e.target.value)
                            }
                            placeholder="Acme Inc."
                            value={orgName}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="org-slug">
                            Slug (URL identifier)
                          </Label>
                          <Input
                            disabled={createLoading}
                            id="org-slug"
                            onChange={(e) =>
                              handleOrgSlugChange(e.target.value)
                            }
                            placeholder="acme-inc"
                            value={orgSlug}
                          />
                        </div>
                        <div className="flex gap-2">
                          <Button
                            className="flex-1"
                            disabled={createLoading}
                            onClick={() => {
                              setShowCreateForm(false);
                              setOrgName("");
                              setOrgSlug("");
                              setOrgSlugManuallyEdited(false);
                            }}
                            variant="outline"
                          >
                            Cancel
                          </Button>
                          <Button
                            className="flex-1"
                            disabled={createLoading || !orgName || !orgSlug}
                            onClick={handleCreateOrg}
                          >
                            {createLoading ? "Creating..." : "Create"}
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <Button
                        className="w-full"
                        onClick={() => setShowCreateForm(true)}
                        variant="outline"
                      >
                        <Plus className="mr-2 h-4 w-4" />
                        Create New Organization
                      </Button>
                    )}
                  </div>

                  {/* Organizations List */}
                  {organizations.length > 0 ? (
                    <div className="space-y-2">
                      {organizations.map((org) => {
                        const isActive = org.id === organization?.id;
                        return (
                          <div
                            className="flex items-center justify-between rounded-lg border p-3"
                            key={org.id}
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <p className="truncate font-medium text-sm">
                                  {org.name}
                                </p>
                                {isActive && (
                                  <span className="rounded-full bg-green-100 px-2 py-0.5 text-green-700 text-xs">
                                    Active
                                  </span>
                                )}
                              </div>
                              <p className="text-muted-foreground text-xs capitalize">
                                {org.role || "member"}
                              </p>
                            </div>
                            <Button
                              onClick={() => setManagedOrgId(org.id)}
                              size="sm"
                              variant="outline"
                            >
                              <Settings className="mr-2 h-3 w-3" />
                              Manage
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="py-4 text-center text-muted-foreground text-sm">
                      No organizations yet. Create one to get started.
                    </div>
                  )}
                </>
              )}

              {/* DETAIL VIEW - Show when managing a specific org */}
              {managedOrgId && managedOrg && (
                <div className="space-y-4">
                  {/* Back Button */}
                  <Button
                    className="gap-2"
                    onClick={() => {
                      setManagedOrgId(null);
                      setInviteId(null);
                    }}
                    size="sm"
                    variant="ghost"
                  >
                    <ArrowLeft className="h-4 w-4" />
                    Back to organizations
                  </Button>

                  <div className="space-y-4 rounded-lg border p-4">
                    <div>
                      <div className="flex items-center gap-2">
                        {isEditingOrgName ? (
                          <>
                            <Input
                              aria-label="Organization name"
                              className="h-8 max-w-xs"
                              disabled={updatingOrgName}
                              onChange={(e) =>
                                setEditingOrgName(e.target.value)
                              }
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  handleUpdateOrgName();
                                }
                                if (e.key === "Escape") {
                                  setIsEditingOrgName(false);
                                  setEditingOrgName(managedOrg.name);
                                }
                              }}
                              value={editingOrgName}
                            />
                            <Button
                              aria-label="Save organization name"
                              disabled={
                                updatingOrgName || !editingOrgName.trim()
                              }
                              onClick={handleUpdateOrgName}
                              size="icon"
                              variant="ghost"
                            >
                              <Check className="h-4 w-4" />
                            </Button>
                            <Button
                              aria-label="Cancel editing organization name"
                              disabled={updatingOrgName}
                              onClick={() => {
                                setIsEditingOrgName(false);
                                setEditingOrgName(managedOrg.name);
                              }}
                              size="icon"
                              variant="ghost"
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          </>
                        ) : (
                          <>
                            <h3 className="font-semibold text-lg">
                              {managedOrg.name}
                            </h3>
                            {isOwner && (
                              <Button
                                aria-label="Edit organization name"
                                disabled={updatingOrgName}
                                onClick={() => {
                                  setIsEditingOrgName(true);
                                  setEditingOrgName(managedOrg.name);
                                }}
                                size="icon"
                                variant="ghost"
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                            )}
                          </>
                        )}
                        {isManagedOrgActive && (
                          <span className="min-w-11 rounded-full bg-green-100 px-2 py-0.5 text-green-700 text-xs">
                            Active
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Invite Members - Inline Form */}
                    {canInvite && (
                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          <Button
                            onClick={() => setInviteMode("email")}
                            size="sm"
                            type="button"
                            variant={
                              inviteMode === "email" ? "default" : "outline"
                            }
                          >
                            Email
                          </Button>
                          <Button
                            onClick={() => setInviteMode("wallet")}
                            size="sm"
                            type="button"
                            variant={
                              inviteMode === "wallet" ? "default" : "outline"
                            }
                          >
                            Wallet
                          </Button>
                        </div>
                        <div className="flex items-center gap-2">
                          {inviteMode === "email" ? (
                            <Input
                              className="flex-1"
                              disabled={inviteLoading}
                              onChange={(e) => {
                                setInviteEmail(e.target.value);
                                if (inviteId) {
                                  setInviteId(null);
                                }
                              }}
                              placeholder="colleague@example.com"
                              type="email"
                              value={inviteEmail}
                            />
                          ) : (
                            <Input
                              className="flex-1"
                              disabled={inviteLoading}
                              onChange={(e) => {
                                setInviteAddress(e.target.value);
                                if (inviteId) {
                                  setInviteId(null);
                                }
                              }}
                              placeholder="0x... (their sign-in wallet)"
                              value={inviteAddress}
                            />
                          )}
                          <Select
                            onValueChange={(v) =>
                              setInviteRole(v as MemberRole)
                            }
                            value={inviteRole}
                          >
                            <SelectTrigger className="w-[130px]">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={"member"}>Member</SelectItem>
                              <SelectItem value={"admin"}>Admin</SelectItem>
                              {isOwner && (
                                <SelectItem value={"owner"}>Owner</SelectItem>
                              )}
                            </SelectContent>
                          </Select>
                          <Button
                            disabled={
                              inviteLoading ||
                              (inviteMode === "email"
                                ? !inviteEmail
                                : !inviteAddress)
                            }
                            onClick={handleInviteMember}
                            size="default"
                          >
                            <Mail className="mr-2 h-4 w-4" />
                            {inviteLoading ? "Sending..." : "Invite"}
                          </Button>
                        </div>
                      </div>
                    )}

                    {/* Members & Pending Invitations (merged) */}
                    <div className="space-y-3">
                      <h4 className="font-medium text-muted-foreground text-sm">
                        Members
                      </h4>
                      <MembersListContent
                        cancellingInvite={cancellingInvite}
                        canInvite={canInvite}
                        currentUserId={session?.user?.id}
                        currentUserRole={currentUserRole}
                        loadingMembers={loadingMembers}
                        loadingSentInvitations={loadingSentInvitations}
                        members={members}
                        onCancelInvitation={handleCancelInvitation}
                        onRemoveMember={handleRemoveMember}
                        onResendInvitation={handleResendInvitation}
                        onUpdateMemberRole={handleUpdateMemberRole}
                        organizationId={managedOrgId}
                        removingMember={removingMember}
                        sentInvitations={sentInvitations}
                        twoFactorStatuses={twoFactorStatuses}
                        updatingRoleMemberId={updatingRoleMemberId}
                      />
                    </div>

                    {/* Leave/Delete Organization */}
                    <div className="space-y-2 border-t pt-3">
                      {isOwner ? (
                        <>
                          {canLeaveAsOwner ? (
                            <Button
                              className="w-full text-orange-600 hover:text-orange-700"
                              onClick={handleLeaveClick}
                              variant="outline"
                            >
                              <LogOut className="mr-2 h-4 w-4" />
                              Leave Organization
                            </Button>
                          ) : (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="inline-block w-full">
                                  <Button
                                    className="w-full text-orange-600 hover:text-orange-700"
                                    disabled
                                    variant="outline"
                                  >
                                    <LogOut className="mr-2 h-4 w-4" />
                                    Leave Organization
                                  </Button>
                                </span>
                              </TooltipTrigger>
                              <TooltipContent>
                                Add another member and assign them as owner
                                first, or delete the organization.
                              </TooltipContent>
                            </Tooltip>
                          )}
                          <Button
                            className="w-full text-destructive hover:text-destructive"
                            onClick={() => setShowDeleteDialog(true)}
                            variant="outline"
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            Delete Organization
                          </Button>
                        </>
                      ) : (
                        <Button
                          className="w-full text-orange-600 hover:text-orange-700"
                          onClick={() => setShowLeaveDialog(true)}
                          variant="outline"
                        >
                          <LogOut className="mr-2 h-4 w-4" />
                          Leave Organization
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </TabsContent>

            <TabsContent className="space-y-4" value="invitations">
              {!userInvitations || userInvitations.length === 0 ? (
                <div className="py-8 text-center text-muted-foreground">
                  No invitations
                </div>
              ) : (
                <div className="space-y-3">
                  {userInvitations.map((invitation) => (
                    <ReceivedInvitationItem
                      invitation={invitation}
                      key={invitation.id}
                      onAccept={handleAcceptInvitation}
                      onReject={handleRejectInvitation}
                      processingInvite={processingInvite}
                    />
                  ))}
                </div>
              )}
            </TabsContent>

            <TabsContent className="space-y-4" value="notifications">
              {organization && (isActiveOrgOwner || isActiveOrgAdmin) ? (
                <>
                  <p className="text-muted-foreground text-sm">
                    Settings for{" "}
                    <span className="font-medium text-foreground">
                      {organization.name}
                    </span>
                  </p>
                  <ExecutionDigestSection
                    canManageBilling={isActiveOrgOwner}
                    key={organization.id}
                    organizationId={organization.id}
                  />
                </>
              ) : (
                <div className="py-8 text-center text-muted-foreground">
                  Only organization owners and admins can manage notifications.
                </div>
              )}
            </TabsContent>

            <TabsContent className="space-y-4" value="security">
              {organization && (isActiveOrgOwner || isActiveOrgAdmin) ? (
                <>
                  <p className="text-muted-foreground text-sm">
                    Security for{" "}
                    <span className="font-medium text-foreground">
                      {organization.name}
                    </span>
                  </p>
                  <MfaEnforcementSection
                    canEdit={isActiveOrgOwner}
                    key={organization.id}
                    organizationId={organization.id}
                  />
                </>
              ) : (
                <div className="py-8 text-center text-muted-foreground">
                  Only organization admins and owners can view security
                  settings.
                </div>
              )}
            </TabsContent>

            <TabsContent className="space-y-4" value="limits">
              {organization && (isActiveOrgOwner || isActiveOrgAdmin) ? (
                <>
                  <p className="text-muted-foreground text-sm">
                    Settings for{" "}
                    <span className="font-medium text-foreground">
                      {organization.name}
                    </span>
                  </p>
                  <SpendCapSection key={organization.id} />
                </>
              ) : (
                <div className="py-8 text-center text-muted-foreground">
                  Only organization owners and admins can manage spending
                  limits.
                </div>
              )}
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>

      {/* Leave Organization Dialog */}
      <AlertDialog onOpenChange={setShowLeaveDialog} open={showLeaveDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave Organization</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to leave {managedOrg?.name}? You will need a
              new invitation to rejoin.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-orange-600 hover:bg-orange-700"
              onClick={handleLeaveOrg}
            >
              Leave Organization
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Assign new owner and leave Dialog */}
      <AlertDialog
        onOpenChange={(isOpen) => {
          setShowAssignOwnerDialog(isOpen);
          if (!isOpen) {
            setAssignOwnerSelectedMemberId(null);
          }
        }}
        open={showAssignOwnerDialog}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Assign new owner</AlertDialogTitle>
            <AlertDialogDescription>
              You must assign another member as owner before leaving. Select an
              accepted member (someone who has already joined the organization).
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="py-2">
            <Label className="text-muted-foreground text-sm">New owner</Label>
            <Select
              onValueChange={setAssignOwnerSelectedMemberId}
              value={assignOwnerSelectedMemberId ?? undefined}
            >
              <SelectTrigger className="mt-1.5">
                <SelectValue placeholder="Select a member" />
              </SelectTrigger>
              <SelectContent>
                {otherMembers.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.user?.email ?? "Unknown"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-orange-600 hover:bg-orange-700"
              disabled={!assignOwnerSelectedMemberId}
              onClick={handleAssignOwnerAndLeave}
            >
              Assign and leave
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Organization Dialog */}
      <AlertDialog onOpenChange={setShowDeleteDialog} open={showDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Organization</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete {managedOrg?.name}? This action
              cannot be undone. All workflows, credentials, and data will be
              permanently deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleDeleteOrg}
            >
              Delete Organization
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
