import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isWalletEmail } from "@/lib/auth/wallet-constants";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";

const MAX_NAME_LENGTH = 50;
const WALLET_ADDRESS_NAME = /^0x/i;

/**
 * Sets the display name for a wallet (SIWE) account and marks it confirmed so
 * the rename modal stops prompting. Restricted to wallet users: email/OAuth
 * users edit their name through /api/user. Rejects raw 0x addresses so the
 * audit trail never falls back to a hex address.
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!isWalletEmail(session.user.email)) {
      return NextResponse.json(
        { error: "Only wallet accounts can set a display name here." },
        { status: 403 }
      );
    }

    const body = (await request.json().catch(() => ({}))) as { name?: unknown };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
      return NextResponse.json(
        { error: `Name must be 1-${MAX_NAME_LENGTH} characters.` },
        { status: 400 }
      );
    }
    if (WALLET_ADDRESS_NAME.test(name)) {
      return NextResponse.json(
        { error: "Please choose a name that is not a wallet address." },
        { status: 400 }
      );
    }

    await db
      .update(users)
      .set({ name, displayNameConfirmed: true, updatedAt: new Date() })
      .where(eq(users.id, session.user.id));

    await recordAuditEvent({
      actor: {
        userId: session.user.id,
        organizationId: null,
        authMethod: "session",
      },
      action: "user.display_name_updated",
      resourceType: "user",
      resourceId: session.user.id,
      metadata: buildAuditMetadata(request),
    });

    return NextResponse.json({ success: true, name });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to set wallet display name",
      error,
      { endpoint: "/api/user/display-name" }
    );
    return NextResponse.json(
      { error: "Failed to update display name." },
      { status: 500 }
    );
  }
}
