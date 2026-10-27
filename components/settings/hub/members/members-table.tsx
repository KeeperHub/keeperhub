"use client";

import { Trash2 } from "lucide-react";
import { useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { roleLabel } from "@/lib/organization/role-label";
import { cn } from "@/lib/utils";
import { ConfirmDeleteDialog } from "../confirm-delete-dialog";
import type { OrgMember } from "../hooks/use-org-members";
import {
  NARROW_HIDDEN,
  NARROW_ONLY,
  NARROW_UNDER_NAME,
  SETTINGS_HEAD_ROW,
  SETTINGS_ROW,
} from "../section";
import { loginIdentifier } from "./login-identifier";

const SKELETON_ROWS = ["a", "b"] as const;

const BADGE = "rounded-full border px-2 py-0.5 text-[0.6875rem]";

export function MembersTable({
  members,
  loading,
  currentMemberId,
  canManage,
  updatingId,
  onRoleChange,
  onRemove,
}: {
  members: OrgMember[];
  /** Draws the same rows blanked, so the card keeps its height. */
  loading: boolean;
  currentMemberId: string | null;
  canManage: boolean;
  updatingId: string | null;
  onRoleChange: (member: OrgMember, role: string) => Promise<void>;
  onRemove: (member: OrgMember) => Promise<void>;
}): React.ReactElement {
  const [pending, setPending] = useState<OrgMember | null>(null);

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow className={SETTINGS_HEAD_ROW}>
            <TableHead>Member</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Joined</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading &&
            SKELETON_ROWS.map((key) => (
              <TableRow className={SETTINGS_ROW} key={key} role="row">
                <TableCell role="cell">
                  <div className="flex items-center gap-3">
                    <Skeleton className="size-8 shrink-0 rounded-full" />
                    <div className="flex flex-col gap-1.5">
                      <Skeleton className="h-5 w-36" />
                      <Skeleton className="h-4 w-52" />
                    </div>
                  </div>
                </TableCell>
                {/* Without the rights to change roles every role is fixed,
                    and in a narrow column takes no line of its own. */}
                <TableCell
                  className={cn(NARROW_UNDER_NAME, !canManage && NARROW_HIDDEN)}
                  role="cell"
                >
                  <Skeleton className="h-5 w-20" />
                </TableCell>
                <TableCell className={NARROW_UNDER_NAME} role="cell">
                  <Skeleton className="h-5 w-24" />
                </TableCell>
                <TableCell role="cell" />
              </TableRow>
            ))}
          {!loading &&
            members.map((member) => {
              const isSelf = member.id === currentMemberId;
              // One owner per org (DB-enforced); transferring ownership happens in
              // the leave flow, so the picker only offers the two editable roles.
              const roleEditable =
                canManage && !isSelf && member.role !== "owner";
              const identifier = loginIdentifier(member.user.email);
              return (
                <TableRow className={SETTINGS_ROW} key={member.id} role="row">
                  <TableCell role="cell">
                    <div className="flex items-center gap-3">
                      <Avatar className="size-8">
                        <AvatarImage
                          alt={member.user.name}
                          src={member.user.image ?? ""}
                        />
                        <AvatarFallback className="text-xs">
                          {member.user.name?.slice(0, 2).toUpperCase() ?? "??"}
                        </AvatarFallback>
                      </Avatar>
                      <div className="flex min-w-0 flex-col">
                        <span className="flex items-center gap-2 truncate font-medium">
                          {member.user.name}
                          {isSelf && <span className={BADGE}>You</span>}
                        </span>
                        <span className="flex min-w-0 items-center gap-2">
                          <span
                            className="truncate text-muted-foreground text-xs"
                            data-testid="member-identifier"
                            title={identifier.full}
                          >
                            {identifier.shown}
                          </span>
                          {/* In a narrow column a fixed role sits on the
                              identifier's line. An editable one keeps a line
                              of its own: its picker would leave the
                              identifier no room on a phone. */}
                          {!roleEditable && (
                            <span
                              className={cn(BADGE, "shrink-0", NARROW_ONLY)}
                              data-testid="member-role"
                            >
                              <span className="sr-only">Role </span>
                              {roleLabel(member.role)}
                            </span>
                          )}
                        </span>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell
                    className={cn(
                      NARROW_UNDER_NAME,
                      !roleEditable && NARROW_HIDDEN
                    )}
                    role="cell"
                  >
                    {roleEditable ? (
                      <Select
                        disabled={updatingId === member.id}
                        onValueChange={(role) => onRoleChange(member, role)}
                        value={member.role}
                      >
                        <SelectTrigger
                          aria-label="Role"
                          className="h-8 w-[120px]"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="member">Member</SelectItem>
                          <SelectItem value="admin">Admin</SelectItem>
                        </SelectContent>
                      </Select>
                    ) : (
                      <span className={BADGE}>{roleLabel(member.role)}</span>
                    )}
                  </TableCell>
                  <TableCell
                    className={cn("text-muted-foreground", NARROW_UNDER_NAME)}
                    role="cell"
                  >
                    <span className={NARROW_ONLY}>Joined </span>
                    {new Date(member.createdAt).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-right" role="cell">
                    {canManage && !isSelf && (
                      <Button
                        aria-label={`Remove ${member.user.name}`}
                        onClick={() => setPending(member)}
                        size="icon"
                        variant="ghost"
                      >
                        <Trash2 className="size-4 text-destructive" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
        </TableBody>
      </Table>

      <ConfirmDeleteDialog
        description={`${pending?.user.name ?? "This member"} loses access to this organization straight away. Their workflows stay.`}
        onConfirm={async () => {
          if (pending) {
            await onRemove(pending);
          }
        }}
        onOpenChange={(next) => !next && setPending(null)}
        open={pending !== null}
        title="Remove member"
      />
    </>
  );
}
