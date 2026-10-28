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
import type { loginIdentifier } from "@/lib/auth/login-identifier";
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

const SKELETON_ROWS = ["a", "b"] as const;

const BADGE = "rounded-full border px-2 py-0.5 text-[0.6875rem]";

// Just past the narrow layout a long identifier would push Joined and the
// actions out of the card, so there the member column takes whatever the
// others leave and the identifier truncates. Wider columns fit it as it is.
const MEMBER_CELL =
  "@xl/settings:@max-4xl/settings:w-full @xl/settings:@max-4xl/settings:max-w-0";

export function MembersTable({
  members,
  loading,
  currentMemberId,
  identifiers,
  canManage,
  updatingId,
  onRoleChange,
  onRemove,
}: {
  members: OrgMember[];
  /** Draws the same rows blanked, so the card keeps its height. */
  loading: boolean;
  currentMemberId: string | null;
  /** Each member's login identifier, by member id. */
  identifiers: Map<string, ReturnType<typeof loginIdentifier>>;
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
            SKELETON_ROWS.map((key, index) => {
              // Rows load most privileged first, so the first is the owner,
              // whose role nobody can change. Without the rights to change
              // roles every role is fixed. A fixed role in a narrow column
              // sits on the identifier's line, so the blank row draws it there
              // too and the row keeps its height once loaded.
              const roleFixed = index === 0 || !canManage;
              return (
                <TableRow className={SETTINGS_ROW} key={key} role="row">
                  <TableCell className={MEMBER_CELL} role="cell">
                    <div className="flex items-center gap-3">
                      <Skeleton className="size-8 shrink-0 rounded-full" />
                      <div className="flex min-w-0 flex-col">
                        {/* Each bar sits inside the line box of the text it
                            stands for, so loading rows are as tall as loaded
                            ones. */}
                        <Skeleton className="my-0.5 h-4 w-36 max-w-full" />
                        <div className="flex min-w-0 items-center gap-2">
                          <Skeleton className="my-0.5 h-3 w-52 min-w-0" />
                          {roleFixed && (
                            <Skeleton
                              className={cn(
                                BADGE,
                                "shrink-0 border-transparent text-transparent",
                                NARROW_ONLY
                              )}
                            >
                              Member
                            </Skeleton>
                          )}
                        </div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell
                    className={cn(
                      NARROW_UNDER_NAME,
                      roleFixed && NARROW_HIDDEN
                    )}
                    role="cell"
                  >
                    <Skeleton className="h-9 w-[120px]" />
                  </TableCell>
                  <TableCell className={NARROW_UNDER_NAME} role="cell">
                    <Skeleton className="my-0.5 h-3 w-24 @xl/settings:h-4" />
                  </TableCell>
                  <TableCell role="cell" />
                </TableRow>
              );
            })}
          {!loading &&
            members.map((member) => {
              const isSelf = member.id === currentMemberId;
              // One owner per org (DB-enforced); transferring ownership happens in
              // the leave flow, so the picker only offers the two editable roles.
              const roleEditable =
                canManage && !isSelf && member.role !== "owner";
              const identifier = identifiers.get(member.id) ?? {
                shown: member.user.email,
                full: member.user.email,
              };
              return (
                <TableRow className={SETTINGS_ROW} key={member.id} role="row">
                  <TableCell className={MEMBER_CELL} role="cell">
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
                        <span className="flex min-w-0 items-center gap-2 font-medium">
                          <span className="min-w-0 truncate">
                            {member.user.name}
                          </span>
                          {isSelf && (
                            <span className={cn(BADGE, "shrink-0")}>You</span>
                          )}
                        </span>
                        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                          <span
                            className="max-w-full truncate text-muted-foreground text-xs"
                            data-testid="member-identifier"
                            title={identifier.full}
                          >
                            {identifier.shown}
                          </span>
                          {/* In a narrow column a fixed role sits on the
                              identifier's line, or just under it when the
                              identifier needs the whole line. An editable one
                              keeps a line of its own: its picker would leave
                              the identifier no room on a phone. */}
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
