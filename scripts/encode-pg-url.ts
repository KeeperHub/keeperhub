#!/usr/bin/env tsx

/**
 * encode-pg-url.ts
 *
 * Reads WORKFLOW_POSTGRES_URL (falling back to DATABASE_URL) from the
 * environment, percent-encodes the username and password so that special
 * characters (base64 +/= from CNPG, etc.) don't break URL parsing, and
 * prints the result to stdout.
 *
 * Used by Helm init containers before running workflow-postgres-setup and
 * drizzle-kit migrations. The same logic lives in instrumentation.ts for
 * runtime use -- keep both in sync.
 *
 * Usage (shell):
 *   export WORKFLOW_POSTGRES_URL=$(tsx scripts/encode-pg-url.ts)
 */

const url = process.env.WORKFLOW_POSTGRES_URL ?? process.env.DATABASE_URL ?? "";

if (!url) {
  process.exit(0);
}

// Fast path: if the URL already parses, credentials are already encoded.
try {
  new URL(url);
  process.stdout.write(url);
  process.exit(0);
} catch {
  // Fall through to manual encoding
}

// Manual encoding for URLs where new URL() fails due to special characters
// in the userinfo component (username:password).
//
// Standard format: scheme://user:password@host:port/database?params
//
// Parsing strategy:
// 1. The last '@' separates credentials from the host
//    (handles passwords containing '@', e.g. p@ssword)
// 2. The first ':' after '://' AND before '@' separates username from password
//    (handles passwords containing ':', e.g. base64 a:b=)
// 3. PostgreSQL usernames cannot contain unescaped ':'
const schemeEnd = url.indexOf("://") + 3;
const atIdx = url.lastIndexOf("@");

// Find the credential separator -- must be between scheme and '@'
const credentialRange = url.slice(schemeEnd, atIdx);
const colonOffset = credentialRange.indexOf(":");
const colonIdx = colonOffset !== -1 ? schemeEnd + colonOffset : -1;

if (schemeEnd > 3 && atIdx > schemeEnd && colonIdx > schemeEnd) {
  const user = url.slice(schemeEnd, colonIdx);
  const pass = url.slice(colonIdx + 1, atIdx);
  // Verify the host portion after '@' looks valid (contains ':' for port or '/' for path)
  const hostPart = url.slice(atIdx + 1);
  if (hostPart.includes(":") || hostPart.includes("/")) {
    process.stdout.write(
      `${url.slice(0, schemeEnd)}${encodeURIComponent(user)}:${encodeURIComponent(pass)}${url.slice(atIdx)}`
    );
  } else {
    process.stdout.write(url);
  }
} else {
  process.stdout.write(url);
}
