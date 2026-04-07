import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { organizationWallets } from "@/lib/db/schema";
import { encryptUserShare } from "@/lib/encryption";
import { getActiveOrgId } from "@/lib/middleware/org-context";

const MAX_SESSION_LENGTH = 500_000;

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const activeOrgId = getActiveOrgId(session);
    if (!activeOrgId) {
      return NextResponse.json(
        { error: "No active organization" },
        { status: 400 }
      );
    }

    const activeMember = await auth.api.getActiveMember({
      headers: await headers(),
    });

    if (!activeMember) {
      return NextResponse.json(
        { error: "You are not a member of the active organization" },
        { status: 403 }
      );
    }

    if (activeMember.role !== "admin" && activeMember.role !== "owner") {
      return NextResponse.json(
        { error: "Only admins and owners can import wallet sessions" },
        { status: 403 }
      );
    }

    const body: { sessionString?: string } = await request.json();
    const { sessionString } = body;

    if (
      !sessionString ||
      typeof sessionString !== "string" ||
      sessionString.length > MAX_SESSION_LENGTH
    ) {
      return NextResponse.json(
        { error: "Invalid session string" },
        { status: 400 }
      );
    }

    // Store the encrypted session directly -- this is the signing credential
    // for post-claim wallets. The server will importSession() before signing.
    const encryptedSession = encryptUserShare(sessionString);

    const updated = await db
      .update(organizationWallets)
      .set({ paraSession: encryptedSession })
      .where(eq(organizationWallets.organizationId, activeOrgId))
      .returning({ id: organizationWallets.id });

    if (updated.length === 0) {
      return NextResponse.json(
        { error: "No wallet found for this organization" },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return apiError(error, "Failed to import wallet session");
  }
}
