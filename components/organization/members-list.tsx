"use client";

import { Trash2 } from "lucide-react";
import Image from "next/image";
import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { authClient } from "@/lib/auth-client";
import { useActiveMember } from "@/lib/hooks/use-organization";

type Member = {
  id: string;
  user: {
    name: string;
    email: string;
    image?: string;
  };
  role: string;
  createdAt: Date;
};

type MembersListProps = {
  members: Member[];
  onUpdate: () => void;
  /** Override admin status (for managing non-active orgs) */
  canManage?: boolean;
};

export function MembersList({
  members,
  onUpdate,
  canManage,
}: MembersListProps) {
  const { isAdmin: isActiveOrgAdmin, member: currentMember } =
    useActiveMember();
  // Use prop if provided, otherwise fall back to hook result
  const isAdmin = canManage ?? isActiveOrgAdmin;
  const [updating, setUpdating] = useState<string | null>(null);

  const handleRoleChange = async (memberId: string, newRole: string) => {
    setUpdating(memberId);
    try {
      await authClient.organization.updateMemberRole({
        memberId,
        role: newRole,
      });
      onUpdate();
    } catch (error) {
      console.error("Failed to update role:", error);
    } finally {
      setUpdating(null);
    }
  };

  const handleRemove = async (_memberId: string, email: string) => {
    try {
      await authClient.organization.removeMember({
        memberIdOrEmail: email,
      });
      onUpdate();
    } catch (error) {
      console.error("Failed to remove member:", error);
    }
  };

  if (!isAdmin) {
    return (
      <div className="text-muted-foreground text-sm">
        Only admins and owners can manage members.
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>User</TableHead>
          <TableHead>Role</TableHead>
          <TableHead>Joined</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {members.map((member) => (
          <TableRow key={member.id}>
            <TableCell>
              <div className="flex items-center gap-2">
                {member.user.image && (
                  <Image
                    alt={member.user.name}
                    className="h-8 w-8 rounded-full"
                    height={32}
                    src={member.user.image}
                    width={32}
                  />
                )}
                <div>
                  <div className="font-medium">{member.user.name}</div>
                  <div className="text-muted-foreground text-sm">
                    {member.user.email}
                  </div>
                </div>
              </div>
            </TableCell>
            <TableCell>
              <Select
                disabled={
                  !isAdmin ||
                  member.id === currentMember?.id ||
                  updating === member.id
                }
                onValueChange={(role) => handleRoleChange(member.id, role)}
                value={member.role}
              >
                <SelectTrigger className="w-[120px]">
                  <SelectValue />
                </SelectTrigger>
                {/* One owner per org (DB-enforced), so becoming owner is a transfer, handled in the Leave Organization flow. */}
                <SelectContent>
                  <SelectItem value="member">Member</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
            </TableCell>
            <TableCell>
              {new Date(member.createdAt).toLocaleDateString()}
            </TableCell>
            <TableCell className="text-right">
              {member.id !== currentMember?.id && (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button size="icon" variant="ghost">
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Remove Member</AlertDialogTitle>
                      <AlertDialogDescription>
                        Are you sure you want to remove {member.user.name} from
                        this organization? This action cannot be undone.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        className="bg-destructive text-destructive-foreground"
                        onClick={() =>
                          handleRemove(member.id, member.user.email)
                        }
                      >
                        Remove
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
