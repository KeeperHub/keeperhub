import { and, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { isWalletEmail } from "@/lib/auth/wallet-constants";
import { db } from "@/lib/db";
import { member, users, walletAddress } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getDualAuthContext } from "@/lib/middleware/auth-helpers";

type ManagerOk = { ok: true; userId: string };
type ManagerErr = { ok: false; status: number; error: string };

// Resolving an address to an account is enumeration-sensitive, so restrict it
// to people who can already invite: owners and admins of the target org.
async function requireOrgManager(
  request: Request,
  organizationId: string
): Promise<ManagerOk | ManagerErr> {
  const authContext = await getDualAuthContext(request);
  if ("error" in authContext) {
    return { ok: false, status: authContext.status, error: authContext.error };
  }
  const { userId, organizationId: callerOrgId, authMethod } = authContext;
  if (!userId) {
    return { ok: false, status: 400, error: "Auth context missing user" };
  }
  if (authMethod === "api-key" && callerOrgId !== organizationId) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  const [membership] = await db
    .select({ role: member.role })
    .from(member)
    .where(
      and(eq(member.organizationId, organizationId), eq(member.userId, userId))
    )
    .limit(1);
  if (!(membership?.role === "owner" || membership?.role === "admin")) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  return { ok: true, userId };
}

export async function GET(
  request: Request,
  context: { params: Promise<{ organizationId: string }> }
): Promise<NextResponse> {
  try {
    const { organizationId } = await context.params;
    const manager = await requireOrgManager(request, organizationId);
    if (!manager.ok) {
      return NextResponse.json(
        { error: manager.error },
        { status: manager.status }
      );
    }

    const address = new URL(request.url).searchParams.get("address")?.trim();
    if (!(address && isAddress(address))) {
      return NextResponse.json(
        { error: "Invalid wallet address", code: "invalid_address" },
        { status: 400 }
      );
    }

    const [wallet] = await db
      .select({
        userId: walletAddress.userId,
        email: users.email,
        name: users.name,
      })
      .from(walletAddress)
      .innerJoin(users, eq(users.id, walletAddress.userId))
      .where(sql`lower(${walletAddress.address}) = ${address.toLowerCase()}`)
      .limit(1);

    if (!(wallet && isWalletEmail(wallet.email))) {
      return NextResponse.json({ found: false });
    }

    const [existing] = await db
      .select({ id: member.id })
      .from(member)
      .where(
        and(
          eq(member.organizationId, organizationId),
          eq(member.userId, wallet.userId)
        )
      )
      .limit(1);

    return NextResponse.json({
      found: true,
      email: wallet.email,
      name: wallet.name,
      alreadyMember: Boolean(existing),
    });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to look up wallet address for invite",
      error,
      { endpoint: "/api/organizations/[organizationId]/wallet-lookup" }
    );
    return NextResponse.json({ error: "Lookup failed" }, { status: 500 });
  }
}
