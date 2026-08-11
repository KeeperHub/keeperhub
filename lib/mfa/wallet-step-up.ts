import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { and, desc, eq, gt } from "drizzle-orm";
import { NextResponse } from "next/server";
import { isAddressEqual, recoverMessageAddress } from "viem";
import { isWalletEmail } from "@/lib/auth/wallet-constants";
import { db } from "@/lib/db";
import {
  twoFactor as twoFactorTable,
  users,
  verifications,
  walletAddress,
} from "@/lib/db/schema";
import { sendVerificationOTP } from "@/lib/email";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { requireDualFactor } from "@/lib/mfa/dual-factor";
import {
  checkDualFactorRateLimit,
  resetDualFactor,
} from "@/lib/mfa/dual-factor-rate-limit";
import {
  resolveRequiredFactors,
  type StepUpFactor,
} from "@/lib/mfa/step-up-policy";
import { verifyUserTotp } from "@/lib/security/totp-verify";
import { generateId } from "@/lib/utils/id";

/**
 * Multi-factor step-up confirmation for sensitive actions.
 *
 * Email/TOTP users keep the existing dual-factor flow unchanged. Wallet (SIWE)
 * users prove identity with a fresh wallet signature, and per their
 * `step_up_policy` may additionally be required to pass TOTP and/or an email
 * OTP (sent to their verified step-up email). All required factors must be
 * satisfied in one request. Reuses the same security primitives as
 * dual-factor: OTPs encrypted at rest (symmetricEncrypt), constant-time
 * compares, TOTP verified against the encrypted secret, shared rate limiter.
 */

const NONCE_TTL_MINUTES = 5;
const EMAIL_OTP_TTL_MINUTES = 5;

export type StepUpError = {
  ok: false;
  status: 401 | 429 | 500 | 503;
  error: string;
  code:
    | "factors_required"
    | "mfa_code_invalid"
    | "email_code_invalid"
    | "email_send_failed"
    | "server_misconfigured"
    | "rate_limited"
    | "signature_required"
    | "wallet_signature_invalid"
    | "wallet_not_linked";
  retryAfter?: number;
  /** The message the wallet must sign (present when a signature is needed). */
  challenge?: string;
  /** Every factor the client must satisfy for this action. */
  required?: StepUpFactor[];
};
export type StepUpResult = { ok: true } | StepUpError;

// Render a step-up failure as JSON. Mirrors dualFactorErrorResponse, but also
// surfaces the wallet `challenge` and the full `required` factor set.
export function stepUpErrorResponse(error: StepUpError): NextResponse {
  const body: Record<string, unknown> = {
    error: error.error,
    code: error.code,
  };
  if (error.challenge) {
    body.challenge = error.challenge;
  }
  if (error.required) {
    body.required = error.required;
  }
  if (error.status === 429 && error.retryAfter !== undefined) {
    return NextResponse.json(body, {
      status: error.status,
      headers: { "Retry-After": String(error.retryAfter) },
    });
  }
  return NextResponse.json(body, { status: error.status });
}

function nonceIdentifier(userId: string, action: string): string {
  return `walletstepup:${action}:${userId}`;
}

function emailIdentifier(userId: string, action: string): string {
  return `mfa:${action}:${userId}`;
}

/**
 * The exact message the wallet signs. Deterministic from (action, nonce) so
 * the server can rebuild and verify it, and scoped by action so a signature
 * for one action can't be replayed against another.
 */
export function buildStepUpMessage(action: string, nonce: string): string {
  return `KeeperHub action confirmation\n\nAction: ${action}\nNonce: ${nonce}`;
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function generateEmailOtp(): string {
  return randomInt(100_000, 999_999).toString();
}

type WalletContext = {
  walletAddressValue: string | null;
  hasTotp: boolean;
  totpSecret: string | null;
  stepUpEmail: string | null;
};

async function loadWalletContext(userId: string): Promise<WalletContext> {
  const [[wallet], [tf], [user]] = await Promise.all([
    db
      .select({ address: walletAddress.address })
      .from(walletAddress)
      .where(eq(walletAddress.userId, userId))
      .orderBy(desc(walletAddress.isPrimary))
      .limit(1),
    db
      .select({ secret: twoFactorTable.secret })
      .from(twoFactorTable)
      .where(eq(twoFactorTable.userId, userId))
      .limit(1),
    db
      .select({
        stepUpEmail: users.stepUpEmail,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1),
  ]);
  return {
    walletAddressValue: wallet?.address ?? null,
    hasTotp: Boolean(tf),
    totpSecret: tf?.secret ?? null,
    stepUpEmail: user?.stepUpEmail ?? null,
  };
}

async function mintEmailOtp(
  userId: string,
  action: string,
  email: string,
  serverSecret: string
): Promise<boolean> {
  const otp = generateEmailOtp();
  const encrypted = await symmetricEncrypt({ key: serverSecret, data: otp });
  const identifier = emailIdentifier(userId, action);
  await db.transaction(async (tx) => {
    await tx
      .delete(verifications)
      .where(eq(verifications.identifier, identifier));
    await tx.insert(verifications).values({
      id: generateId(),
      identifier,
      value: encrypted,
      expiresAt: new Date(Date.now() + EMAIL_OTP_TTL_MINUTES * 60 * 1000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });
  return await sendVerificationOTP({ email, otp, type: "confirm-action" });
}

async function mintNonce(
  userId: string,
  action: string,
  serverSecret: string
): Promise<string> {
  const nonce = randomBytes(16).toString("hex");
  const encrypted = await symmetricEncrypt({ key: serverSecret, data: nonce });
  const identifier = nonceIdentifier(userId, action);
  await db.transaction(async (tx) => {
    await tx
      .delete(verifications)
      .where(eq(verifications.identifier, identifier));
    await tx.insert(verifications).values({
      id: generateId(),
      identifier,
      value: encrypted,
      expiresAt: new Date(Date.now() + NONCE_TTL_MINUTES * 60 * 1000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });
  return buildStepUpMessage(action, nonce);
}

async function verifyWalletSignature(
  userId: string,
  action: string,
  signature: string,
  walletAddressValue: string,
  serverSecret: string
): Promise<boolean> {
  const identifier = nonceIdentifier(userId, action);
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
    return false;
  }
  let nonce: string;
  try {
    nonce = await symmetricDecrypt({ key: serverSecret, data: row.value });
  } catch (err) {
    logSystemError(
      ErrorCategory.AUTH,
      "[WalletStepUp] Failed to decrypt nonce",
      err,
      { action }
    );
    return false;
  }
  if (!(signature.startsWith("0x") && walletAddressValue.startsWith("0x"))) {
    return false;
  }
  const message = buildStepUpMessage(action, nonce);
  let recovered: `0x${string}`;
  try {
    recovered = await recoverMessageAddress({
      message,
      signature: signature as `0x${string}`,
    });
  } catch {
    return false;
  }
  return isAddressEqual(recovered, walletAddressValue as `0x${string}`);
}

async function consumeWalletNonce(
  userId: string,
  action: string
): Promise<boolean> {
  const deleted = await db
    .delete(verifications)
    .where(
      and(
        eq(verifications.identifier, nonceIdentifier(userId, action)),
        gt(verifications.expiresAt, new Date())
      )
    )
    .returning({ id: verifications.id });
  return deleted.length > 0;
}

async function verifyEmailOtp(
  userId: string,
  action: string,
  emailOtp: string,
  serverSecret: string
): Promise<boolean> {
  const identifier = emailIdentifier(userId, action);
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
    return false;
  }
  let decrypted: string;
  try {
    decrypted = await symmetricDecrypt({ key: serverSecret, data: row.value });
  } catch (err) {
    logSystemError(
      ErrorCategory.AUTH,
      "[WalletStepUp] Failed to decrypt email OTP",
      err,
      { action }
    );
    return false;
  }
  if (!constantTimeEquals(decrypted, emailOtp)) {
    return false;
  }
  await db.delete(verifications).where(eq(verifications.id, row.id));
  return true;
}

async function requireWalletStepUp(args: {
  userId: string;
  action: string;
  signature?: string;
  code?: string;
  emailOtp?: string;
}): Promise<StepUpResult> {
  const { userId, action } = args;
  const serverSecret = process.env.BETTER_AUTH_SECRET;
  if (!serverSecret) {
    return {
      ok: false,
      status: 500,
      error: "Server misconfigured",
      code: "server_misconfigured",
    };
  }

  const rateLimit = checkDualFactorRateLimit(userId, action);
  if (!rateLimit.allowed) {
    return {
      ok: false,
      status: 429,
      error: "Too many attempts. Wait and try again.",
      code: "rate_limited",
      retryAfter: rateLimit.retryAfter,
    };
  }

  const ctx = await loadWalletContext(userId);
  if (!ctx.walletAddressValue) {
    return {
      ok: false,
      status: 401,
      error: "No wallet is linked to this account.",
      code: "wallet_not_linked",
    };
  }

  const required = resolveRequiredFactors({
    isWalletUser: true,
    enrolled: {
      wallet: true,
      totp: ctx.hasTotp,
      email: Boolean(ctx.stepUpEmail),
    },
  });

  const signature =
    typeof args.signature === "string" ? args.signature.trim() : "";
  const totpCode = typeof args.code === "string" ? args.code.trim() : "";
  const inboxCode =
    typeof args.emailOtp === "string" ? args.emailOtp.trim() : "";

  const needWallet = required.includes("wallet");
  const needTotp = required.includes("totp");
  const needEmail = required.includes("email");

  const missingWallet = needWallet && !signature;
  const missingTotp = needTotp && totpCode.length !== 6;
  const missingEmail = needEmail && inboxCode.length !== 6;

  // First pass: mint whatever challenges are missing and tell the client the
  // full factor set so it can collect all inputs at once.
  if (missingWallet || missingTotp || missingEmail) {
    let challenge: string | undefined;
    if (missingWallet) {
      challenge = await mintNonce(userId, action, serverSecret);
    }
    if (missingEmail && ctx.stepUpEmail) {
      const sent = await mintEmailOtp(
        userId,
        action,
        ctx.stepUpEmail,
        serverSecret
      );
      if (!sent) {
        return {
          ok: false,
          status: 503,
          error: "Failed to send confirmation email",
          code: "email_send_failed",
        };
      }
    }
    return {
      ok: false,
      status: 401,
      error: "Confirm this action to continue.",
      code: missingWallet ? "signature_required" : "factors_required",
      challenge,
      required,
    };
  }

  // Verify every required factor; all must pass before consuming the nonce.
  if (needWallet) {
    const ok = await verifyWalletSignature(
      userId,
      action,
      signature,
      ctx.walletAddressValue,
      serverSecret
    );
    if (!ok) {
      return {
        ok: false,
        status: 401,
        error: "Invalid wallet signature.",
        code: "wallet_signature_invalid",
      };
    }
  }
  if (needTotp) {
    const ok = ctx.totpSecret
      ? await verifyUserTotp(ctx.totpSecret, totpCode, serverSecret)
      : false;
    if (!ok) {
      return {
        ok: false,
        status: 401,
        error: "Invalid authenticator code",
        code: "mfa_code_invalid",
      };
    }
  }
  if (needEmail) {
    const ok = await verifyEmailOtp(userId, action, inboxCode, serverSecret);
    if (!ok) {
      return {
        ok: false,
        status: 401,
        error: "Invalid email code",
        code: "email_code_invalid",
      };
    }
  }

  // All factors verified. Atomically consume the wallet nonce via
  // DELETE...RETURNING so concurrent requests cannot double-succeed.
  if (needWallet) {
    const consumed = await consumeWalletNonce(userId, action);
    if (!consumed) {
      return {
        ok: false,
        status: 401,
        error: "Invalid wallet signature.",
        code: "wallet_signature_invalid",
      };
    }
  }

  resetDualFactor(userId, action);
  return { ok: true };
}

type StepUpArgs = {
  userId: string;
  email: string;
  action: string;
  headers: Headers;
  /** TOTP code. */
  code?: string;
  /** Email OTP. */
  emailOtp?: string;
  /** Wallet signature over the step-up challenge (wallet users). */
  signature?: string;
};

/**
 * Unified step-up gate. Routes call this instead of `requireDualFactor`.
 * Email/TOTP users go through the unchanged dual-factor flow; wallet users go
 * through the multi-factor wallet path (signature + any opted-in factors).
 */
export function requireStepUp(args: StepUpArgs): Promise<StepUpResult> {
  if (isWalletEmail(args.email)) {
    return requireWalletStepUp({
      userId: args.userId,
      action: args.action,
      signature: args.signature,
      code: args.code,
      emailOtp: args.emailOtp,
    });
  }
  return requireDualFactor({
    userId: args.userId,
    email: args.email,
    action: args.action,
    code: args.code,
    emailOtp: args.emailOtp,
    headers: args.headers,
  });
}
