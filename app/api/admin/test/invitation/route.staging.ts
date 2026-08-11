import { and, desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { authenticateAdmin, validateTestEmail } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import { invitation } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";

export async function GET(request: Request): Promise<NextResponse> {
  const auth = authenticateAdmin(request);
  if (!auth.authenticated) {
    return NextResponse.json(
      { error: auth.error || "Unauthorized" },
      { status: 401 }
    );
  }

  const url = new URL(request.url);
  const email = url.searchParams.get("email");
  if (!email) {
    return NextResponse.json(
      { error: "Missing email query parameter" },
      { status: 400 }
    );
  }

  const emailError = validateTestEmail(email);
  if (emailError) {
    return NextResponse.json({ error: emailError }, { status: 403 });
  }

  try {
    const result = await db
      .select({ id: invitation.id })
      .from(invitation)
      .where(and(eq(invitation.email, email), eq(invitation.status, "pending")))
      .orderBy(desc(invitation.expiresAt))
      .limit(1);

    if (result.length === 0) {
      return NextResponse.json(
        { error: `No pending invitation found for ${email}` },
        { status: 404 }
      );
    }

    return NextResponse.json({ invitationId: result[0].id });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "Admin invitation lookup failed",
      error,
      { endpoint: "/api/admin/test/invitation", operation: "get" }
    );
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
