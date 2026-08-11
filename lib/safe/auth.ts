import "server-only";

import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { type SafeWallet, safeWallets } from "@/lib/db/schema";
import { getActiveOrgId } from "@/lib/middleware/org-context";

export type AdminContext = {
  organizationId: string;
  userId: string;
};

export type AdminError = {
  error: string;
  status: number;
};

/**
 * Authenticate the request, require an active organization, and require the
 * caller to be an admin or owner of that organization. Single source of truth
 * for the admin-gate on every Safe surface: deploy, policy install/update,
 * per-allowance edit/revoke, signing-toggle, and the pre-deploy simulate
 * preview. All Safe mutation endpoints (and the simulate that previews them)
 * MUST go through this gate so non-admin members cannot drive on-chain state
 * or trigger RPC/oracle work from the API.
 */
export async function validateSafeAdmin(
  request: Request
): Promise<AdminContext | AdminError> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) {
    return { error: "Unauthorized", status: 401 };
  }

  const activeOrgId = getActiveOrgId(session);
  if (!activeOrgId) {
    return {
      error: "No active organization. Please select or create an organization.",
      status: 400,
    };
  }

  const activeMember = await auth.api.getActiveMember({
    headers: await headers(),
  });
  if (!activeMember) {
    return {
      error: "You are not a member of the active organization",
      status: 403,
    };
  }

  const role = activeMember.role;
  if (role !== "admin" && role !== "owner") {
    return {
      error: "Only organization admins and owners can manage Safe wallets",
      status: 403,
    };
  }

  return { organizationId: activeOrgId, userId: session.user.id };
}

/**
 * Stricter variant of `validateSafeAdmin` that requires the caller to be
 * the org owner. Used for destructive Safe actions whose UI surfaces are
 * still visible to admins (so they can see what would be deleted) but
 * whose execution is reserved to the owner. Today this gates the
 * per-allowance Revoke endpoint; admins hitting the API directly get a
 * 403 with a clear message so the UI can pair it with a "owner only"
 * tooltip on the disabled control.
 */
export async function validateSafeOwner(
  request: Request
): Promise<AdminContext | AdminError> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) {
    return { error: "Unauthorized", status: 401 };
  }

  const activeOrgId = getActiveOrgId(session);
  if (!activeOrgId) {
    return {
      error: "No active organization. Please select or create an organization.",
      status: 400,
    };
  }

  const activeMember = await auth.api.getActiveMember({
    headers: await headers(),
  });
  if (!activeMember) {
    return {
      error: "You are not a member of the active organization",
      status: 403,
    };
  }

  if (activeMember.role !== "owner") {
    return {
      error:
        "Only the organization owner can perform this destructive Safe action",
      status: 403,
    };
  }

  return { organizationId: activeOrgId, userId: session.user.id };
}

/**
 * Load a Safe by its id and confirm it belongs to the given organization.
 * Returns null if not found or if the Safe belongs to a different org --
 * callers should translate null into a 404 to avoid leaking existence.
 */
export async function getSafeForOrg(options: {
  safeId: string;
  organizationId: string;
}): Promise<SafeWallet | null> {
  const { safeId, organizationId } = options;
  const rows = await db
    .select()
    .from(safeWallets)
    .where(
      and(
        eq(safeWallets.id, safeId),
        eq(safeWallets.organizationId, organizationId)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}
