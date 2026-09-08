import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { type AccountKind, classifyAccountKind } from "@/lib/auth/account-kind";
import { db } from "@/lib/db";
import { member, users } from "@/lib/db/schema";
import { checkWalletOrgMfaCompliance } from "@/lib/mfa/org-mfa-enforcement";
import { requireStepUp, stepUpErrorResponse } from "@/lib/mfa/wallet-step-up";

/**
 * One authorization guard for every sensitive action. It replaces the scattered
 * requireOwnerWithMfa / requireAdminOrOwnerWithMfa / requireMfaEnrolled /
 * requireDualFactor stacks so the account-type branching lives in exactly one
 * ordered pipeline:
 *
 *   0. classify account kind (wallet / oauth / email / anonymous)
 *   1. reject anonymous
 *   2. role floor (org-scoped actions only)
 *   3. non-wallet enrollment + session step-up (wallet accounts are exempt;
 *      their signature is the factor, proven in stage 5)
 *   4. wallet org-MFA enforcement compliance
 *   5. the action step-up challenge via the unchanged requireStepUp
 *      (wallet -> signature + opted-in factors; email/oauth -> dual factor)
 *
 * Failures return a ready NextResponse reproducing the exact status + `code`
 * the previous guards emitted, so callers stay one-liners and the client
 * challenge handling keeps working byte-for-byte.
 */

export type RoleFloor = "none" | "member" | "admin" | "owner";

export type AuthorizeSession = {
  user: { id: string; email: string | null; name?: string | null };
  session: Record<string, unknown>;
};

type AuthorizeArgs = {
  session: AuthorizeSession;
  action: string;
  roleFloor: RoleFloor;
  organizationId?: string | null;
  body: { code?: string; emailOtp?: string; signature?: string };
  headers: Headers;
};

export type AuthorizeResult =
  | { ok: true; session: AuthorizeSession; accountKind: AccountKind }
  | { ok: false; response: NextResponse };

const ROLE_RANK: Record<string, number> = { member: 1, admin: 2, owner: 3 };

function deny(
  status: number,
  code: string,
  error: string
): { ok: false; response: NextResponse } {
  return {
    ok: false,
    response: NextResponse.json({ error, code }, { status }),
  };
}

async function memberRole(
  userId: string,
  organizationId: string
): Promise<string | undefined> {
  const [row] = await db
    .select({ role: member.role })
    .from(member)
    .where(
      and(eq(member.userId, userId), eq(member.organizationId, organizationId))
    )
    .limit(1);
  return row?.role ?? undefined;
}

async function hasTwoFactor(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ twoFactorEnabled: users.twoFactorEnabled })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.twoFactorEnabled === true;
}

function roleFloorDenial(roleFloor: RoleFloor): {
  ok: false;
  response: NextResponse;
} {
  if (roleFloor === "owner") {
    return deny(
      403,
      "not_owner",
      "Only organization owners can perform this action"
    );
  }
  if (roleFloor === "admin") {
    return deny(
      403,
      "not_admin_or_owner",
      "Only organization admins and owners can perform this action"
    );
  }
  return deny(
    403,
    "insufficient_role",
    "You do not have permission to perform this action"
  );
}

export async function authorizeAction(
  args: AuthorizeArgs
): Promise<AuthorizeResult> {
  const { session, action, roleFloor, body, headers } = args;
  const { user } = session;
  const sess = session.session as {
    requiresMfa?: boolean | null;
    activeOrganizationId?: string | null;
  };

  // Stage 0: account kind.
  const accountKind = classifyAccountKind({
    email: user.email,
    name: user.name,
    isAnonymous: (user as { isAnonymous?: boolean | null }).isAnonymous,
  });

  // Stage 1: anonymous accounts cannot perform gated actions.
  if (accountKind === "anonymous") {
    return deny(
      403,
      "anonymous_forbidden",
      "Anonymous users cannot perform this action"
    );
  }

  // Stage 2: role floor (org-scoped actions only).
  if (roleFloor !== "none") {
    if (!args.organizationId) {
      return deny(400, "no_active_organization", "No active organization");
    }
    const role = await memberRole(user.id, args.organizationId);
    const rank = role ? ROLE_RANK[role] : undefined;
    if (rank === undefined || rank < ROLE_RANK[roleFloor]) {
      return roleFloorDenial(roleFloor);
    }
  }

  // Stage 3: non-wallet enrollment + session step-up. Wallet accounts are
  // exempt -- their signature is the factor, enforced in stage 5.
  if (accountKind !== "wallet") {
    if (sess.requiresMfa === true) {
      return deny(
        403,
        "mfa_pending",
        "Complete step-up verification before this action"
      );
    }
    if (!(await hasTwoFactor(user.id))) {
      return deny(
        403,
        "mfa_not_enrolled",
        "Enable two-factor authentication on your account before this action"
      );
    }
  }

  // Stage 4: wallet org-MFA enforcement compliance.
  if (accountKind === "wallet") {
    const compliance = await checkWalletOrgMfaCompliance({
      userId: user.id,
      activeOrganizationId: args.organizationId ?? sess.activeOrganizationId,
    });
    if (!compliance.compliant) {
      return deny(
        403,
        "org_mfa_enrollment_required",
        "Your organization requires two-factor authentication. Add a second factor to continue."
      );
    }
  }

  // Stage 5: the action step-up challenge, surfaced unchanged.
  const stepUp = await requireStepUp({
    userId: user.id,
    email: user.email ?? "",
    action,
    code: body.code,
    emailOtp: body.emailOtp,
    signature: body.signature,
    headers,
  });
  if (!stepUp.ok) {
    return { ok: false, response: stepUpErrorResponse(stepUp) };
  }

  return { ok: true, session, accountKind };
}
