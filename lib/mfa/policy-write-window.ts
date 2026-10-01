import "server-only";

import crypto from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { db } from "@/lib/db";
import { verifications } from "@/lib/db/schema";
import { generateId } from "@/lib/utils/id";

/**
 * A short window during which one person may write policy without proving
 * themselves again.
 *
 * Every other step-up action here is a single act: withdraw once, export once.
 * Editing policy is not. Writing one rule is a handful of writes, and gating
 * each of them on its own challenge would send an email per statement, so the
 * cost of the guardrail would land on the people who use it most and they would
 * stop writing policy at all.
 *
 * So the challenge is paid once and buys ten minutes. What makes that
 * acceptable is how narrow the window is:
 *
 *   - it opens only for policy and grant writes, never for any other gated
 *     action, so a withdrawal challenge cannot be spent on a policy edit;
 *   - it belongs to one organization, so holding it for one does not permit
 *     writing another's;
 *   - the browser has to present the token it was issued, so the window follows
 *     the device that answered the challenge rather than the account;
 *   - it lives in the database, so signing out or revoking a session can end it
 *     before its time, which a self-contained signed cookie could not offer.
 *
 * The token is stored as a SHA-256 hash. A read of this table yields nothing
 * that can be replayed.
 */

const COOKIE_BASE = "kh_policy_write";

/**
 * `__Host-` is the strongest statement a cookie can make about where it came
 * from: the browser refuses to set it unless it is Secure, has no Domain and is
 * path `/`, which means no sibling subdomain can create or overwrite it. We run
 * app, docs and per-PR hosts under one registrable domain, so without the
 * prefix a foothold on any of them could plant a policy window for the app.
 *
 * The prefix needs a secure context, so plain http development keeps the bare
 * name. Both spellings are read back, the way the session cookie is.
 */
export const POLICY_WRITE_COOKIE =
  process.env.NODE_ENV === "production" ? `__Host-${COOKIE_BASE}` : COOKIE_BASE;

/** Long enough to author a policy in one sitting, short enough to matter. */
export const POLICY_WRITE_WINDOW_MINUTES = 10;

const WINDOW_MS = POLICY_WRITE_WINDOW_MINUTES * 60 * 1000;

function identifierFor(userId: string, organizationId: string): string {
  return `policy_write_window:${userId}:${organizationId}`;
}

function hash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Record a completed challenge and return the token the browser must keep.
 *
 * Any window the same person already held for this organization is replaced, so
 * answering a second challenge cannot leave an older token alive behind it.
 */
export async function openPolicyWriteWindow(input: {
  userId: string;
  organizationId: string;
}): Promise<{ token: string; expiresAt: Date }> {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + WINDOW_MS);
  const identifier = identifierFor(input.userId, input.organizationId);

  await db
    .delete(verifications)
    .where(eq(verifications.identifier, identifier));
  await db.insert(verifications).values({
    id: generateId(),
    identifier,
    value: hash(token),
    expiresAt,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return { token, expiresAt };
}

/**
 * Whether this person, in this organization, holding this token, may write now.
 *
 * Absent or expired is not an error: it means the challenge has to be answered,
 * which is the normal path the first time somebody edits.
 */
export async function hasPolicyWriteWindow(input: {
  userId: string;
  organizationId: string;
  token: string | undefined;
}): Promise<boolean> {
  if (!input.token) {
    return false;
  }

  const [row] = await db
    .select({ value: verifications.value })
    .from(verifications)
    .where(
      and(
        eq(
          verifications.identifier,
          identifierFor(input.userId, input.organizationId)
        ),
        gt(verifications.expiresAt, new Date())
      )
    )
    .limit(1);

  if (!row) {
    return false;
  }

  // Constant-time: the stored value is a hash, so both sides are a fixed
  // length and a comparison that returns early would leak it a byte at a time.
  const presented = Buffer.from(hash(input.token));
  const stored = Buffer.from(row.value);
  return (
    presented.length === stored.length &&
    crypto.timingSafeEqual(presented, stored)
  );
}

/** End the window early. Used when a session ends or the person signs out. */
export async function closePolicyWriteWindow(input: {
  userId: string;
  organizationId: string;
}): Promise<void> {
  await db
    .delete(verifications)
    .where(
      eq(
        verifications.identifier,
        identifierFor(input.userId, input.organizationId)
      )
    );
}

/**
 * The window token this request carries, if any.
 *
 * Read from the request rather than from next/headers so the same check works
 * for a route handler and for anything that only holds a Request.
 */
export function readPolicyWriteCookie(request: Request): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) {
    return;
  }
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === POLICY_WRITE_COOKIE || name === `__Host-${COOKIE_BASE}`) {
      return rest.join("=") || undefined;
    }
  }
  return;
}
