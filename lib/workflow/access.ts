import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { member, users } from "@/lib/db/schema";
import { isViewerRole } from "@/lib/organization/role-label";

type WorkflowAccessSubject = {
  userId: string | null;
  organizationId: string | null;
  authMethod?: "api-key" | "internal" | "oauth" | "session" | "webhook";
};

type WorkflowAccessWorkflow = {
  id?: string;
  userId: string;
  organizationId: string | null;
  isAnonymous: boolean;
  // KEEP-440: present on full workflow rows; absent on the trimmed shapes some
  // callers pass. Treated as not-deleted when absent.
  deletedAt?: Date | null;
};

export type WorkflowAccess = {
  isCreatorWithCurrentAccess: boolean;
  isSameOrg: boolean;
  hasFullAccess: boolean;
  // Full read access plus permission to change, run or delete the workflow.
  // False for org viewers, who read everything but change nothing.
  canEdit: boolean;
  // KEEP-440: true when the workflow has been soft-deleted. Mutation, execution
  // and export routes must reject deleted workflows; only the owner-facing read
  // paths keep serving them so the UI can render a deleted marker.
  isDeleted: boolean;
};

/**
 * The user's role in the organization, or null when they are not a member or
 * their account is deactivated.
 */
export async function getActiveMemberRole(
  userId: string,
  organizationId: string
): Promise<string | null> {
  const [membership] = await db
    .select({ id: member.id, role: member.role })
    .from(member)
    .innerJoin(users, eq(member.userId, users.id))
    .where(
      and(
        eq(member.userId, userId),
        eq(member.organizationId, organizationId),
        isNull(users.deactivatedAt)
      )
    )
    .limit(1);

  if (!membership) {
    return null;
  }
  return membership.role;
}

export async function isUserMemberOfOrganization(
  userId: string,
  organizationId: string
): Promise<boolean> {
  return (await getActiveMemberRole(userId, organizationId)) !== null;
}

export async function getWorkflowAccess(
  workflow: WorkflowAccessWorkflow,
  subject: WorkflowAccessSubject
): Promise<WorkflowAccess> {
  const userId = subject.userId;
  // workflow.userId is createdBy (audit only) and confers NO authority on its
  // own. The organization owns the workflow: full access requires the caller
  // to be acting in the workflow's org AND be a current member of it. The
  // isAnonymous provenance flag no longer gates access - every workflow has an
  // org now, so org membership is the single rule.
  const isCreator = userId !== null && userId === workflow.userId;

  const hasSameOrgContext =
    workflow.organizationId !== null &&
    subject.organizationId === workflow.organizationId;

  const currentRole =
    hasSameOrgContext && userId !== null && workflow.organizationId !== null
      ? await getActiveMemberRole(userId, workflow.organizationId)
      : null;

  const isSameOrg = currentRole !== null;

  return {
    // Retained for callers that distinguish "the creator, acting in-org" from
    // a non-creator org member (e.g. the duplicate route's retire-original
    // branch). Not an authority signal - hasFullAccess is org-based.
    isCreatorWithCurrentAccess: isCreator && isSameOrg,
    isSameOrg,
    hasFullAccess: isSameOrg,
    canEdit: isSameOrg && !isViewerRole(currentRole),
    isDeleted: (workflow.deletedAt ?? null) !== null,
  };
}
