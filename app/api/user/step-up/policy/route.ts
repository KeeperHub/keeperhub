import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isWalletEmail } from "@/lib/auth/wallet-constants";
import { db } from "@/lib/db";
import { users, walletAddress } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";

type EnrolledFactors = { wallet: boolean; totp: boolean; email: boolean };

async function loadEnrolled(
  userId: string,
  stepUpEmail: string | null
): Promise<EnrolledFactors> {
  const [[wallet], [user]] = await Promise.all([
    db
      .select({ id: walletAddress.id })
      .from(walletAddress)
      .where(eq(walletAddress.userId, userId))
      .limit(1),
    db
      .select({ twoFactorEnabled: users.twoFactorEnabled })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1),
  ]);
  return {
    wallet: Boolean(wallet),
    // TOTP counts as enrolled only once confirmed (twoFactorEnabled), not when
    // a setup row exists but the code was never verified.
    totp: user?.twoFactorEnabled === true,
    email: Boolean(stepUpEmail),
  };
}

// GET: which extra factors the wallet user has enrolled, so the settings UI can
// render the toggles. Enabling a factor is the only control -- once on, it is
// required on every sensitive action; there is no per-action configuration.
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const [row] = await db
      .select({ stepUpEmail: users.stepUpEmail })
      .from(users)
      .where(eq(users.id, session.user.id))
      .limit(1);
    const enrolled = await loadEnrolled(
      session.user.id,
      row?.stepUpEmail ?? null
    );
    return NextResponse.json({
      walletUser: isWalletEmail(session.user.email),
      enrolled,
    });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to load step-up enrollment",
      error,
      { endpoint: "/api/user/step-up/policy" }
    );
    return NextResponse.json(
      { error: "Failed to load step-up enrollment." },
      { status: 500 }
    );
  }
}
