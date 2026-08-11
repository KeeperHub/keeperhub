#!/usr/bin/env tsx

/**
 * dev-mint-session.ts
 *
 * Mint a Better Auth session for a local-dev user without going through the
 * UI (signup -> OTP -> MFA -> TOTP). The signed cookie value is written to
 * .claude/.dev-session-cookie-LOCAL so it can be pasted into Chrome devtools
 * as the `better-auth.session_token` cookie.
 *
 * Mirrors app/api/auth/oauth-mfa-finalize/route.ts:117-167 -- same row shape
 * (requiresMfa=false, mfaVerifiedAt=now), same HMAC signing scheme, same
 * cookie name. The only difference is we skip the dual-factor challenge and
 * accept any email the caller names. That is dangerous against a real
 * deployment, which is why the script refuses to run unless BOTH:
 *   - DATABASE_URL points at a local Postgres host, AND
 *   - KEEPERHUB_DEV_MINT=1 is set in the environment.
 *
 * Usage:
 *   KEEPERHUB_DEV_MINT=1 pnpm dev:mint-cookie dev@keeperhub.local
 */

import "dotenv/config";

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import {
  hashSessionToken,
  signSessionCookieValue,
} from "../lib/auth-session-token-hash";
import { getDatabaseUrl } from "../lib/db/connection-utils";
import { member, organization, sessions, users } from "../lib/db/schema";

// ---------------------------------------------------------------------------
// Guards: hostname + opt-in env var
// ---------------------------------------------------------------------------

const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "db", "postgres"]);

function assertLocalDb(url: string): void {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    throw new Error(`dev-mint-session: DATABASE_URL is not a parseable URL`);
  }
  if (!ALLOWED_HOSTS.has(hostname)) {
    throw new Error(
      `dev-mint-session: refusing to run against host "${hostname}". ` +
        `Only ${[...ALLOWED_HOSTS].join(", ")} are allowed. ` +
        "Set DATABASE_URL to a local Postgres before re-running."
    );
  }
}

function assertOptIn(): void {
  if (process.env.KEEPERHUB_DEV_MINT !== "1") {
    throw new Error(
      "dev-mint-session: refusing to run without KEEPERHUB_DEV_MINT=1. " +
        "This is a session-forge utility; set the env var to acknowledge."
    );
  }
}

// ---------------------------------------------------------------------------
// Mint
// ---------------------------------------------------------------------------

const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const COOKIE_OUTPUT_PATH = path.join(
  process.cwd(),
  ".claude",
  ".dev-session-cookie-LOCAL"
);

type MintResult = {
  email: string;
  userId: string;
  cookieName: string;
  signedCookieValue: string;
  expiresAt: Date;
};

async function mintSession(email: string): Promise<MintResult> {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    throw new Error(
      "dev-mint-session: BETTER_AUTH_SECRET is not set. The cookie cannot be signed."
    );
  }

  const url = getDatabaseUrl();
  const client = postgres(url, { max: 1 });
  const db = drizzle(client);

  try {
    const row = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (!row[0]) {
      throw new Error(
        `dev-mint-session: no user found with email "${email}". ` +
          "Run pnpm dev:bootstrap first, or pass a seeded email."
      );
    }
    const userId = row[0].id;

    // Surface a stable "active org" so the UI lands on the seeded workflows.
    // Prefer the membership in the bootstrap's dev-org slug; fall back to the
    // user's first membership so a custom SEED_DEV_ORG_SLUG still works.
    const devOrgSlug = process.env.SEED_DEV_ORG_SLUG ?? "dev-org";
    const devOrgMember = await db
      .select({ organizationId: member.organizationId })
      .from(member)
      .innerJoin(organization, eq(organization.id, member.organizationId))
      .where(and(eq(member.userId, userId), eq(organization.slug, devOrgSlug)))
      .limit(1);
    let activeOrganizationId: string | null =
      devOrgMember[0]?.organizationId ?? null;
    if (!activeOrganizationId) {
      const fallback = await db
        .select({ organizationId: member.organizationId })
        .from(member)
        .where(eq(member.userId, userId))
        .orderBy(asc(member.createdAt))
        .limit(1);
      activeOrganizationId = fallback[0]?.organizationId ?? null;
    }

    const rawToken = randomBytes(32).toString("base64url");
    const tokenHash = hashSessionToken(rawToken);
    const expiresAt = new Date(Date.now() + DEFAULT_SESSION_TTL_MS);
    const sessionId = `sess_${randomBytes(16).toString("base64url")}`;
    const now = new Date();

    await db.insert(sessions).values({
      id: sessionId,
      userId,
      token: tokenHash,
      expiresAt,
      createdAt: now,
      updatedAt: now,
      ipAddress: "127.0.0.1",
      userAgent: "dev-mint-session",
      requiresMfa: false,
      mfaVerifiedAt: now,
      activeOrganizationId,
    });

    const signedCookieValue = signSessionCookieValue(rawToken, secret);
    // The route uses __Secure- in production, plain in dev. dev-mint always
    // targets dev, so emit the dev cookie name.
    const cookieName = "better-auth.session_token";

    return { email, userId, cookieName, signedCookieValue, expiresAt };
  } finally {
    await client.end();
  }
}

function writeCookieFile(result: MintResult): void {
  const dir = path.dirname(COOKIE_OUTPUT_PATH);
  fs.mkdirSync(dir, { recursive: true });
  const body = [
    `# Generated by scripts/dev-mint-session.ts at ${new Date().toISOString()}`,
    `# User:    ${result.email} (${result.userId})`,
    `# Cookie:  ${result.cookieName}`,
    `# Expires: ${result.expiresAt.toISOString()}`,
    "#",
    "# Paste the line below into Chrome devtools (Application > Cookies > localhost:3000)",
    "# as the value for the cookie named above, then refresh.",
    "",
    result.signedCookieValue,
    "",
  ].join("\n");
  fs.writeFileSync(COOKIE_OUTPUT_PATH, body, { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

function parseEmail(): string {
  const email = process.argv[2];
  if (!email) {
    throw new Error(
      "dev-mint-session: missing email argument. " +
        "Usage: KEEPERHUB_DEV_MINT=1 pnpm dev:mint-cookie <email>"
    );
  }
  return email;
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  assertLocalDb(url);
  assertOptIn();
  const email = parseEmail();
  const result = await mintSession(email);
  writeCookieFile(result);

  console.log(`dev-mint-session: minted session for ${result.email}`);
  console.log(`  user id:    ${result.userId}`);
  console.log(`  cookie:     ${result.cookieName}`);
  console.log(`  expires:    ${result.expiresAt.toISOString()}`);
  console.log(`  written to: ${COOKIE_OUTPUT_PATH}`);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(msg);
  process.exit(1);
});
