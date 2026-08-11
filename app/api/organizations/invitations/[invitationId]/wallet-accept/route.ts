import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { auth } from "@/lib/auth";
import { isWalletEmail } from "@/lib/auth/wallet-constants";
import { db } from "@/lib/db";
import { invitation, member } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  getInviteChallengeMessage,
  verifyInviteChallenge,
} from "@/lib/org/wallet-invite-challenge";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";
import { generateId } from "@/lib/utils/id";

type InvitationRow = {
  id: string;
  email: string;
  role: string | null;
  status: string;
  organizationId: string;
  expiresAt: Date;
};

type Loaded =
  | { ok: true; userId: string; invite: InvitationRow; address: string }
  | { ok: false; status: number; error: string; code?: string };

// Shared guard for both GET (fetch challenge) and POST (accept): the caller must
// hold a SIWE session that IS the invited wallet account, and the invitation
// must be a live, wallet-typed, pending invite.
async function loadContext(
  request: Request,
  invitationId: string
): Promise<Loaded> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) {
    return {
      ok: false,
      status: 401,
      error: "Sign in with your wallet first.",
      code: "wallet_signin_required",
    };
  }

  const [invite] = await db
    .select({
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      status: invitation.status,
      organizationId: invitation.organizationId,
      expiresAt: invitation.expiresAt,
    })
    .from(invitation)
    .where(eq(invitation.id, invitationId))
    .limit(1);

  if (!invite) {
    return { ok: false, status: 404, error: "Invitation not found" };
  }
  if (!isWalletEmail(invite.email)) {
    return {
      ok: false,
      status: 400,
      error: "This invitation is not for a wallet account.",
      code: "not_wallet_invite",
    };
  }
  if (invite.status !== "pending") {
    return {
      ok: false,
      status: 409,
      error: "This invitation is no longer pending.",
      code: "not_pending",
    };
  }
  if (invite.expiresAt.getTime() < Date.now()) {
    return {
      ok: false,
      status: 410,
      error: "This invitation has expired.",
      code: "expired",
    };
  }
  // The session user must be the invited account.
  if (session.user.email.toLowerCase() !== invite.email.toLowerCase()) {
    return {
      ok: false,
      status: 403,
      error: "Sign in with the invited wallet to accept.",
      code: "wrong_account",
    };
  }

  const address = invite.email.split("@")[0];
  if (!(address && isAddress(address))) {
    return {
      ok: false,
      status: 400,
      error: "Invitation address is invalid.",
      code: "invalid_address",
    };
  }

  return { ok: true, userId: session.user.id, invite, address };
}

export async function GET(
  request: Request,
  context: { params: Promise<{ invitationId: string }> }
): Promise<NextResponse> {
  try {
    const { invitationId } = await context.params;
    const loaded = await loadContext(request, invitationId);
    if (!loaded.ok) {
      return NextResponse.json(
        { error: loaded.error, code: loaded.code },
        { status: loaded.status }
      );
    }
    const message = await getInviteChallengeMessage(invitationId);
    return NextResponse.json({ message });
  } catch (error) {
    logSystemError(
      ErrorCategory.AUTH,
      "Failed to build wallet invite challenge",
      error,
      {
        endpoint: "/api/organizations/invitations/[invitationId]/wallet-accept",
      }
    );
    return NextResponse.json(
      { error: "Failed to start acceptance" },
      { status: 500 }
    );
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ invitationId: string }> }
): Promise<NextResponse> {
  try {
    const { invitationId } = await context.params;
    const loaded = await loadContext(request, invitationId);
    if (!loaded.ok) {
      return NextResponse.json(
        { error: loaded.error, code: loaded.code },
        { status: loaded.status }
      );
    }

    const body = (await request.json().catch(() => ({}))) as {
      signature?: string;
    };
    const signature =
      typeof body.signature === "string" ? body.signature.trim() : "";
    if (!signature) {
      return NextResponse.json(
        {
          error: "A wallet signature is required.",
          code: "signature_required",
        },
        { status: 400 }
      );
    }

    const verified = await verifyInviteChallenge(
      invitationId,
      loaded.address,
      signature
    );
    if (!verified) {
      return NextResponse.json(
        { error: "Invalid wallet signature.", code: "signature_invalid" },
        { status: 401 }
      );
    }

    // Verified the invited wallet signed the live challenge while signed in as
    // that account; complete the join. Wrapped in a transaction so the existence
    // check, member insert, and invitation update are atomic — concurrent POSTs
    // that both pass signature verification cannot both insert a member row.
    await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: member.id })
        .from(member)
        .where(
          and(
            eq(member.organizationId, loaded.invite.organizationId),
            eq(member.userId, loaded.userId)
          )
        )
        .limit(1);

      if (!existing) {
        await tx.insert(member).values({
          id: generateId(),
          organizationId: loaded.invite.organizationId,
          userId: loaded.userId,
          role: loaded.invite.role ?? "member",
          createdAt: new Date(),
        });
      }
      await tx
        .update(invitation)
        .set({ status: "accepted" })
        .where(eq(invitation.id, invitationId));
    });

    await recordAuditEvent({
      actor: {
        userId: loaded.userId,
        organizationId: loaded.invite.organizationId,
        authMethod: "session",
      },
      action: "member.joined",
      resourceType: "organization",
      resourceId: loaded.invite.organizationId,
      metadata: buildAuditMetadata(request),
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    logSystemError(
      ErrorCategory.AUTH,
      "Failed to accept wallet invitation",
      error,
      {
        endpoint: "/api/organizations/invitations/[invitationId]/wallet-accept",
      }
    );
    return NextResponse.json(
      { error: "Failed to accept invitation" },
      { status: 500 }
    );
  }
}
