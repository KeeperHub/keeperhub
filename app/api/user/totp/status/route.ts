import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isAnonymousUserShape } from "@/lib/auth-anonymous-guard";
import { db } from "@/lib/db";
import { twoFactor as twoFactorTable, users } from "@/lib/db/schema";

type StatusResponse = {
  enabled: boolean;
  name: string | null;
  enrolledAt: string | null;
  hasBackupCodes: boolean;
};

/**
 * GET /api/user/totp/status
 *
 * Returns the caller's TOTP enrollment state for the settings UI. The
 * `enabled` bit comes from users.two_factor_enabled (flipped to true by
 * the plugin's verify-totp endpoint on first successful code). Name +
 * enrolled timestamp come from the two_factor row; both are null until
 * enrollment finishes successfully.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (isAnonymousUserShape(session.user)) {
    // Anonymous sessions can't enroll TOTP — return a stable empty
    // status so the UI hides the section without surfacing a 403.
    return NextResponse.json({
      enabled: false,
      name: null,
      enrolledAt: null,
      hasBackupCodes: false,
      anonymous: true,
    });
  }

  const userId = session.user.id;
  const [userRow] = await db
    .select({ twoFactorEnabled: users.twoFactorEnabled })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const enabled = userRow?.twoFactorEnabled === true;

  if (!enabled) {
    const body: StatusResponse = {
      enabled: false,
      name: null,
      enrolledAt: null,
      hasBackupCodes: false,
    };
    return NextResponse.json(body);
  }

  const [factorRow] = await db
    .select({
      name: twoFactorTable.name,
      enrolledAt: twoFactorTable.enrolledAt,
      backupCodes: twoFactorTable.backupCodes,
    })
    .from(twoFactorTable)
    .where(eq(twoFactorTable.userId, userId))
    .limit(1);

  const body: StatusResponse = {
    enabled: true,
    name: factorRow?.name ?? null,
    enrolledAt: factorRow?.enrolledAt?.toISOString() ?? null,
    hasBackupCodes: Boolean(factorRow?.backupCodes),
  };
  return NextResponse.json(body);
}
