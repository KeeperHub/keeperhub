"use client";

import { LogOut, Trash2 } from "lucide-react";
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
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useLeaveOrg } from "../hooks/use-leave-org";
import type { OrgMember } from "../hooks/use-org-members";
import { SettingsCard } from "../section";

export function LeaveOrgCard({
  organizationId,
  organizationName,
  isOwner,
  members,
}: {
  organizationId: string | null;
  organizationName: string;
  isOwner: boolean;
  members: OrgMember[];
}): React.ReactElement {
  const state = useLeaveOrg(organizationId, organizationName, isOwner, members);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [successorId, setSuccessorId] = useState<string | null>(null);

  // The organization drops out of the list the moment it is gone, taking its
  // name with it, so the dialogs fall back rather than reading "Delete ?".
  const label = organizationName || "this organization";

  const openLeave = (): void => {
    setSuccessorId(state.otherMembers[0]?.id ?? null);
    setConfirmLeave(true);
  };

  const doLeave = async (): Promise<void> => {
    await state.leave(
      state.needsSuccessor ? (successorId ?? undefined) : undefined
    );
    setConfirmLeave(false);
  };

  const doDelete = async (): Promise<void> => {
    await state.remove();
    setConfirmDelete(false);
  };

  return (
    <SettingsCard
      description={
        isOwner
          ? "Leaving hands your access back. Deleting removes the organization and everything in it for everyone."
          : "Leaving hands your access back."
      }
      title={isOwner ? "Leave or delete" : "Leave"}
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col">
            <span className="font-medium text-sm">Leave this organization</span>
            <span className="text-muted-foreground text-xs">
              {state.canLeave
                ? "You lose access to its workflows and wallet."
                : "You are the only owner and the only member, so there is nobody to hand it to. Delete it instead."}
            </span>
          </div>
          <Button
            className="shrink-0"
            disabled={!state.canLeave || state.working}
            onClick={openLeave}
            variant="outline"
          >
            <LogOut className="size-4" />
            Leave
          </Button>
        </div>

        {isOwner && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
            <div className="flex min-w-0 flex-col">
              <span className="font-medium text-sm">
                Delete this organization
              </span>
              <span className="text-muted-foreground text-xs">
                Its workflows, members and wallet go with it. This cannot be
                undone.
              </span>
            </div>
            <Button
              className="shrink-0"
              disabled={state.working}
              onClick={() => setConfirmDelete(true)}
              variant="destructive"
            >
              <Trash2 className="size-4" />
              Delete
            </Button>
          </div>
        )}
      </div>

      <AlertDialog onOpenChange={setConfirmLeave} open={confirmLeave}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave {label}?</AlertDialogTitle>
            <AlertDialogDescription>
              {state.needsSuccessor
                ? "You are its only owner, so choose who takes over before you go."
                : "You will lose access to this organization's workflows and wallet."}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {state.needsSuccessor && (
            <Select
              onValueChange={setSuccessorId}
              value={successorId ?? undefined}
            >
              <SelectTrigger>
                <SelectValue placeholder="Choose the new owner" />
              </SelectTrigger>
              <SelectContent>
                {state.otherMembers.map((member) => (
                  <SelectItem key={member.id} value={member.id}>
                    {member.user.name || member.user.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={state.working || (state.needsSuccessor && !successorId)}
              onClick={doLeave}
            >
              Leave
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog onOpenChange={setConfirmDelete} open={confirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {label}?</AlertDialogTitle>
            <AlertDialogDescription>
              Every workflow, member and wallet in this organization is removed
              permanently. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={state.working}
              onClick={doDelete}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsCard>
  );
}
