import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";

/**
 * Marks the /welcome onboarding wizard as completed for the signed-in user, so
 * it is not shown again on any device or browser. Idempotent.
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    await db
      .update(users)
      .set({ onboardingCompleted: true, updatedAt: new Date() })
      .where(eq(users.id, session.user.id));

    return NextResponse.json({ success: true });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to mark onboarding complete",
      error,
      { endpoint: "/api/user/onboarding/complete" }
    );
    return NextResponse.json(
      { error: "Failed to update onboarding status." },
      { status: 500 }
    );
  }
}
