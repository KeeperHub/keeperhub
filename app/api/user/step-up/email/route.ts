import { randomInt, timingSafeEqual } from "node:crypto";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { and, eq, gt, ne } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isWalletEmail } from "@/lib/auth/wallet-constants";
import { isDisposableEmailDomain } from "@/lib/auth-disposable-emails";
import { db } from "@/lib/db";
import { users, verifications } from "@/lib/db/schema";
import { sendVerificationOTP } from "@/lib/email";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { checkDualFactorRateLimit } from "@/lib/mfa/dual-factor-rate-limit";
import { STEP_UP_ACTIONS } from "@/lib/mfa/step-up-policy";
import { requireStepUp, stepUpErrorResponse } from "@/lib/mfa/wallet-step-up";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";
import { generateId } from "@/lib/utils/id";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_TTL_MINUTES = 10;

function identifierFor(userId: string): string {
  return `stepupemail:${userId}`;
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Adds a verified step-up email for a wallet account. Adding a factor is a
 * "free" strengthening action, so it needs no step-up -- but the email itself
 * must be proven by a code before it's stored. Two phases:
 *   1. POST { email }        -> emails a 6-digit code
 *   2. POST { email, code }  -> verifies and stores users.step_up_email
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!isWalletEmail(session.user.email)) {
      return NextResponse.json(
        { error: "Only wallet accounts add a step-up email." },
        { status: 403 }
      );
    }
    const serverSecret = process.env.BETTER_AUTH_SECRET;
    if (!serverSecret) {
      return NextResponse.json(
        { error: "Server misconfigured" },
        { status: 500 }
      );
    }

    const rateLimit = checkDualFactorRateLimit(
      session.user.id,
      STEP_UP_ACTIONS.stepUpEmailEnroll
    );
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: "Too many attempts. Wait and try again." },
        {
          status: 429,
          headers: { "Retry-After": String(rateLimit.retryAfter ?? 60) },
        }
      );
    }

    const body = (await request.json().catch(() => ({}))) as {
      email?: unknown;
      code?: unknown;
    };
    const email =
      typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const code = typeof body.code === "string" ? body.code.trim() : "";
    if (
      !EMAIL_RE.test(email) ||
      isWalletEmail(email) ||
      isDisposableEmailDomain(email)
    ) {
      return NextResponse.json(
        { error: "Enter a valid, non-disposable email." },
        { status: 400 }
      );
    }

    // Reject if the email is already the primary login address for any other
    // account. Step-up emails must be distinct from login identities: sharing
    // an inbox between a login account and a wallet step-up address would
    // route security OTPs to a third-party inbox and create confusing audit
    // state. The check is on users.email (the login email column), not
    // stepUpEmail, so two wallet users sharing a step-up inbox remains
    // possible but is blocked from colliding with a real login identity.
    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.email, email), ne(users.id, session.user.id)))
      .limit(1);
    if (existing) {
      return NextResponse.json(
        { error: "This email is already registered with another account." },
        { status: 409 }
      );
    }

    const identifier = identifierFor(session.user.id);

    // Phase 1: request a code.
    if (!code) {
      const otp = randomInt(100_000, 999_999).toString();
      const encrypted = await symmetricEncrypt({
        key: serverSecret,
        data: `${email}:${otp}`,
      });
      await db
        .delete(verifications)
        .where(eq(verifications.identifier, identifier));
      await db.insert(verifications).values({
        id: generateId(),
        identifier,
        value: encrypted,
        expiresAt: new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const sent = await sendVerificationOTP({
        email,
        otp,
        type: "email-verification",
      });
      if (!sent) {
        return NextResponse.json(
          { error: "Failed to send verification email." },
          { status: 503 }
        );
      }
      return NextResponse.json({ ok: true, sent: true });
    }

    // Phase 2: verify the code and store the email.
    const [row] = await db
      .select({ id: verifications.id, value: verifications.value })
      .from(verifications)
      .where(
        and(
          eq(verifications.identifier, identifier),
          gt(verifications.expiresAt, new Date())
        )
      )
      .limit(1);
    if (!row) {
      return NextResponse.json(
        { error: "Code expired. Request a new one." },
        { status: 400 }
      );
    }
    let stored: string;
    try {
      stored = await symmetricDecrypt({ key: serverSecret, data: row.value });
    } catch (err) {
      logSystemError(
        ErrorCategory.AUTH,
        "[StepUpEmail] Failed to decrypt code",
        err,
        { endpoint: "/api/user/step-up/email" }
      );
      return NextResponse.json(
        { error: "Server misconfigured" },
        { status: 500 }
      );
    }
    const separator = stored.lastIndexOf(":");
    const storedEmail = stored.slice(0, separator);
    const storedCode = stored.slice(separator + 1);
    if (storedEmail !== email || !constantTimeEquals(storedCode, code)) {
      return NextResponse.json({ error: "Invalid code." }, { status: 400 });
    }

    await db.delete(verifications).where(eq(verifications.id, row.id));
    await db
      .update(users)
      .set({ stepUpEmail: email, updatedAt: new Date() })
      .where(eq(users.id, session.user.id));
    await recordAuditEvent({
      actor: {
        userId: session.user.id,
        organizationId: null,
        authMethod: "session",
      },
      action: "step_up_email.added",
      resourceType: "user",
      resourceId: session.user.id,
      metadata: buildAuditMetadata(request),
    });
    return NextResponse.json({ ok: true, email });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to enroll step-up email",
      error,
      { endpoint: "/api/user/step-up/email" }
    );
    return NextResponse.json(
      { error: "Failed to add step-up email." },
      { status: 500 }
    );
  }
}

/**
 * Removes the step-up email. Removing a factor is a weakening action, so it
 * requires passing step-up first.
 */
export async function DELETE(request: Request): Promise<NextResponse> {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!isWalletEmail(session.user.email)) {
      return NextResponse.json(
        { error: "Only wallet accounts manage a step-up email." },
        { status: 403 }
      );
    }

    const body = (await request.json().catch(() => ({}))) as {
      signature?: string;
      code?: string;
      emailOtp?: string;
    };
    const stepUp = await requireStepUp({
      userId: session.user.id,
      email: session.user.email,
      action: STEP_UP_ACTIONS.stepUpEmailRemove,
      signature: body.signature,
      code: body.code,
      emailOtp: body.emailOtp,
      headers: request.headers,
    });
    if (!stepUp.ok) {
      return stepUpErrorResponse(stepUp);
    }

    await db
      .update(users)
      .set({ stepUpEmail: null, updatedAt: new Date() })
      .where(eq(users.id, session.user.id));
    await recordAuditEvent({
      actor: {
        userId: session.user.id,
        organizationId: null,
        authMethod: "session",
      },
      action: "step_up_email.removed",
      resourceType: "user",
      resourceId: session.user.id,
      metadata: buildAuditMetadata(request),
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to remove step-up email",
      error,
      { endpoint: "/api/user/step-up/email" }
    );
    return NextResponse.json(
      { error: "Failed to remove step-up email." },
      { status: 500 }
    );
  }
}
