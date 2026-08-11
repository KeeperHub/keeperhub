import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { member, users } from "@/lib/db/schema";
import { sendSecurityAlertEmail } from "@/lib/email";
import { describeAuditAction } from "@/lib/security/audit-actions";
import { isHighRiskAuditAction } from "@/lib/security/audit-alerts";

export type OwnerAlertInput = {
  action: string;
  organizationId: string | null;
  actorUserId: string | null;
  actorLabel: string | null;
  resourceType?: string | null;
  when: Date;
};

async function resolveOwnerEmails(organizationId: string): Promise<string[]> {
  const rows = await db
    .select({ email: users.email })
    .from(member)
    .innerJoin(users, eq(users.id, member.userId))
    .where(
      and(eq(member.organizationId, organizationId), eq(member.role, "owner"))
    );
  return rows.map((r) => r.email).filter((e): e is string => Boolean(e));
}

async function resolveActorLabel(
  actorUserId: string | null,
  actorLabel: string | null
): Promise<string> {
  if (actorLabel) {
    return actorLabel;
  }
  if (!actorUserId) {
    return "Someone";
  }
  const [actor] = await db
    .select({ name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, actorUserId))
    .limit(1);
  return actor?.name || actor?.email || "Someone";
}

async function emailOwners(
  orgId: string,
  input: OwnerAlertInput
): Promise<void> {
  const [emails, actorLabel] = await Promise.all([
    resolveOwnerEmails(orgId),
    resolveActorLabel(input.actorUserId, input.actorLabel),
  ]);
  const { phrase } = describeAuditAction(input.action);
  await Promise.all(
    emails.map((email) =>
      sendSecurityAlertEmail({
        email,
        actionPhrase: phrase,
        actorLabel,
        when: input.when,
        resourceType: input.resourceType ?? null,
      })
    )
  );
}

/**
 * Email organization owners when a high-risk action is recorded. Fire-and-
 * forget and fully self-contained: resolves owners + the actor's name, sends
 * one alert each, and swallows all errors so it can never break the audited
 * action. No-op for non-high-risk actions or events with no org context.
 */
export function notifyOwnersOfHighRiskAction(input: OwnerAlertInput): void {
  const orgId = input.organizationId;
  if (!(orgId && isHighRiskAuditAction(input.action))) {
    return;
  }
  emailOwners(orgId, input).catch(() => {
    // best-effort; sendSecurityAlertEmail logs delivery failures itself
  });
}
