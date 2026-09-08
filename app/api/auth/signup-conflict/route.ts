import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { OAUTH_PROVIDERS } from "@/lib/auth/account-kind";
import { db } from "@/lib/db";
import { accounts, users } from "@/lib/db/schema";
import { ApiErrorCodes, apiError } from "@/lib/errors/api-envelope";
import { HttpStatus } from "@/lib/http-status";
import { resolveClientIpFromHeaders } from "@/lib/security/login-risk";
import { checkSignupConflictRateLimit } from "../_lib/signup-conflict-rate-limit";

/**
 * Resolves how an already-registered address is supposed to sign in, so the
 * signup dialog can route a duplicate-email failure somewhere recoverable.
 *
 * An OAuth-only account has no `credential` row in `accounts`, so the email
 * verification flow the dialog used to start can never complete: the user
 * verifies an OTP, then /api/auth/finish-credential-signup finds no credential
 * password and rejects them. Proving control of the address cannot unblock
 * them; only signing in with their original provider can.
 *
 * Disclosure posture. The response collapses "no account" and "has a credential
 * account" into the same `oauthOnly: false` answer, so this endpoint never
 * reveals that an ordinary email/password address is registered. It discloses
 * exactly one thing: that a given address is an OAuth-only account, and which
 * provider(s) it uses. That is the minimum needed to tell the user where to go,
 * and it is a deliberate trade rather than an accident. Bounded by a dedicated
 * per-email and per-IP limiter, kept separate from the credential-password
 * limiter so a caller who supplies no password cannot spend a victim's
 * sign-in budget.
 */

type Body = {
  email?: string;
};

const SUPPORTED_OAUTH: ReadonlySet<string> = new Set(OAUTH_PROVIDERS);

export async function POST(request: Request): Promise<NextResponse> {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return apiError({
      status: HttpStatus.BAD_REQUEST,
      code: "bad_body",
      detail: "Invalid JSON body",
      requestHeaders: request.headers,
    });
  }

  const email = body.email?.trim().toLowerCase() ?? "";
  if (!email) {
    return apiError({
      status: HttpStatus.BAD_REQUEST,
      code: ApiErrorCodes.INVALID_INPUT,
      detail: "Email is required",
      requestHeaders: request.headers,
    });
  }

  const clientIp = resolveClientIpFromHeaders(request.headers) ?? "unknown";
  const rateLimit = checkSignupConflictRateLimit(email, clientIp);
  if (!rateLimit.allowed) {
    return apiError({
      status: HttpStatus.TOO_MANY_REQUESTS,
      code: ApiErrorCodes.RATE_LIMITED,
      detail: "Too many attempts. Wait and try again.",
      requestHeaders: request.headers,
      headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
    });
  }

  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (!user) {
    return NextResponse.json({ oauthOnly: false });
  }

  const rows = await db
    .select({ providerId: accounts.providerId })
    .from(accounts)
    .where(eq(accounts.userId, user.id));

  const hasCredential = rows.some((row) => row.providerId === "credential");
  if (hasCredential) {
    return NextResponse.json({ oauthOnly: false });
  }

  const providers = [
    ...new Set(
      rows
        .map((row) => row.providerId)
        .filter((providerId) => SUPPORTED_OAUTH.has(providerId))
    ),
  ];
  // No credential row and no provider we can name: nothing actionable to send
  // the user to, so answer as for any other address. Wallet (SIWE) accounts
  // carry a synthetic @wallet.keeperhub.com address and cannot be reached by
  // an email typed into the signup form, so this is effectively unreachable.
  if (providers.length === 0) {
    return NextResponse.json({ oauthOnly: false });
  }

  return NextResponse.json({ oauthOnly: true, providers });
}
