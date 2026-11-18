import "server-only";

import { and, eq, inArray, isNull } from "drizzle-orm";
import { isWalletEmail } from "@/lib/auth/wallet-constants";
import { db } from "@/lib/db";
import { member, users } from "@/lib/db/schema";
import { deliverableAddress } from "@/lib/notifications/deliverable-address";

// Which org members can be emailed, shared by quota warnings and failure alerts.

export type OrgMember = {
  userId: string;
  role: string;
  email: string | null;
  name: string | null;
  /** Where mail actually reaches them, or null (wallet-only, unverified). */
  deliverable: string | null;
};

/** Active members of the org (deactivated accounts keep member rows), optionally by role. */
export async function loadOrgMembers(
  organizationId: string,
  roles?: string[]
): Promise<OrgMember[]> {
  const rows = await db
    .select({
      userId: member.userId,
      role: member.role,
      email: users.email,
      emailVerified: users.emailVerified,
      stepUpEmail: users.stepUpEmail,
      name: users.name,
    })
    .from(member)
    .innerJoin(users, eq(users.id, member.userId))
    .where(
      and(
        eq(member.organizationId, organizationId),
        isNull(users.deactivatedAt),
        roles ? inArray(member.role, roles) : undefined
      )
    );
  return rows.map((row) => ({
    userId: row.userId,
    role: row.role,
    email: row.email,
    name: row.name,
    deliverable: deliverableAddress(row),
  }));
}

/** The distinct addresses mail can reach, in member order. */
export function reachableEmails(members: OrgMember[]): string[] {
  return [
    ...new Set(
      members
        .map((m) => m.deliverable)
        .filter((email): email is string => Boolean(email))
    ),
  ];
}

/**
 * A wallet user's step-up inbox is private to them: everyone else sees their
 * wallet login in its place. Without a viewer (shared, cached results) it is
 * masked for everyone.
 */
export async function stepUpMasker(
  addresses: Iterable<string | null>,
  viewerUserId: string | null = null
): Promise<(address: string) => string> {
  const wanted = [
    ...new Set([...addresses].filter((a): a is string => Boolean(a))),
  ];
  if (wanted.length === 0) {
    return (address) => address;
  }
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      stepUpEmail: users.stepUpEmail,
    })
    .from(users)
    .where(inArray(users.stepUpEmail, wanted));
  const masked = new Map<string, string>();
  for (const row of rows) {
    if (
      row.stepUpEmail &&
      row.email &&
      isWalletEmail(row.email) &&
      row.id !== viewerUserId
    ) {
      masked.set(row.stepUpEmail, row.email);
    }
  }
  return (address) => masked.get(address) ?? address;
}

/** Replaces each address found in free text (any case) with what the mask shows. */
export function maskAddressesIn(
  text: string,
  addresses: Iterable<string>,
  mask: (address: string) => string
): string {
  let out = text;
  for (const address of new Set(addresses)) {
    const shown = mask(address);
    if (shown !== address) {
      const escaped = address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      out = out.replace(new RegExp(escaped, "gi"), shown);
    }
  }
  return out;
}
