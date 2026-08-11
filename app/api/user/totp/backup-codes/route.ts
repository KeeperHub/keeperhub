import { generateRandomString, symmetricEncrypt } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isAnonymousUserShape } from "@/lib/auth-anonymous-guard";
import { db } from "@/lib/db";
import { twoFactor as twoFactorTable, users } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";

type RequestBody = {
  code?: string;
};

type Response = {
  backupCodes: string[];
};

const BACKUP_CODE_COUNT = 10;
const BACKUP_CODE_LENGTH = 10;

/**
 * Generates the 10 backup codes the plugin's verify-backup-code endpoint
 * expects: "XXXXX-XXXXX" strings (a-z/0-9/A-Z), JSON-stringified then
 * symmetric-encrypted with BETTER_AUTH_SECRET. Format mirrors the
 * plugin's own backup-codes/index.mjs:generateBackupCodesFn verbatim so
 * verifyBackupCode decrypts and compares correctly.
 */
function generatePlainBackupCodes(): string[] {
  const codes: string[] = [];
  for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
    const raw = generateRandomString(BACKUP_CODE_LENGTH, "a-z", "0-9", "A-Z");
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return codes;
}

/**
 * POST /api/user/totp/backup-codes
 *
 * Generates a fresh set of backup codes for the signed-in user and
 * overwrites any existing ones. Requires a valid TOTP code as second-
 * factor proof: a stolen session cookie alone must not be able to mint
 * or rotate recovery codes, since either operation invalidates the
 * previous set and produces a fresh viewable copy.
 *
 * The plaintext codes are returned exactly once. Once the dialog is
 * dismissed the user can never re-view them — they must regenerate to
 * see them again, which invalidates the previous set.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (isAnonymousUserShape(session.user)) {
    return NextResponse.json(
      { error: "Sign in with a real account" },
      { status: 403 }
    );
  }

  const userId = session.user.id;

  const [userRow] = await db
    .select({ twoFactorEnabled: users.twoFactorEnabled })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (userRow?.twoFactorEnabled !== true) {
    return NextResponse.json(
      { error: "Two-factor authentication is not enabled" },
      { status: 400 }
    );
  }

  const body = (await request.json().catch(() => ({}))) as RequestBody;
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!code) {
    return NextResponse.json({ error: "Code is required" }, { status: 400 });
  }

  try {
    await auth.api.verifyTOTP({
      body: { code },
      headers: request.headers,
    });
  } catch {
    return NextResponse.json(
      { error: "Invalid verification code" },
      { status: 401 }
    );
  }

  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    logSystemError(
      ErrorCategory.CONFIGURATION,
      "[TOTP Backup Codes] BETTER_AUTH_SECRET is not configured",
      new Error("BETTER_AUTH_SECRET missing"),
      { endpoint: "/api/user/totp/backup-codes" }
    );
    return NextResponse.json(
      { error: "Server misconfigured" },
      { status: 500 }
    );
  }

  try {
    const backupCodes = generatePlainBackupCodes();
    const encryptedBackupCodes = await symmetricEncrypt({
      key: secret,
      data: JSON.stringify(backupCodes),
    });

    await db
      .update(twoFactorTable)
      .set({ backupCodes: encryptedBackupCodes })
      .where(eq(twoFactorTable.userId, userId));

    await recordAuditEvent({
      actor: { userId, organizationId: null, authMethod: "session" },
      action: "backup_codes.regenerated",
      resourceType: "user",
      resourceId: userId,
      metadata: buildAuditMetadata(request),
    });

    const responseBody: Response = { backupCodes };
    return NextResponse.json(responseBody);
  } catch (error) {
    logSystemError(
      ErrorCategory.AUTH,
      "[TOTP Backup Codes] Failed to generate codes",
      error,
      { endpoint: "/api/user/totp/backup-codes", user_id: userId }
    );
    return NextResponse.json(
      { error: "Failed to generate backup codes" },
      { status: 500 }
    );
  }
}
