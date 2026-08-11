#!/usr/bin/env tsx

/**
 * dev-bootstrap.ts
 *
 * One-shot bootstrap for a usable local-dev DB. Idempotent. Refuses to run
 * against anything that doesn't look like a local Postgres host.
 *
 * Sequence:
 *   1. assertLocalDb()
 *   2. If users table exists AND drizzle.__drizzle_migrations is empty,
 *      run scripts/backfill-drizzle-migrations.ts so the migration run skips
 *      the already-applied SQL. (db:push-bootstrapped DBs land here.)
 *   3. Apply migrations in-process, recovering from db:push drift if the
 *      journal still lags the schema (see scripts/lib/migration-drift.ts).
 *   4. seedPersistentTestUsers() for the e2e user/org set.
 *   5. Upsert the dev user (default dev@keeperhub.local) + org + membership.
 *   6. Read the local kh CLI token from ~/.config/kh/hosts.yml and upsert
 *      an organization_api_keys row that hashes to it. The file itself is
 *      never read in or committed.
 *   7. Upsert the 8 workflow fixtures from ./fixtures/dev-workflows.ts
 *      into the dev user's org.
 *   8. Seed the 6 public onboarding hub workflows from
 *      ./fixtures/onboarding-workflows.ts into the dev user's org so the
 *      recommendations endpoint resolves them locally without env vars.
 *
 * Re-run anytime: it's an upsert at every step.
 */

import "dotenv/config";

import { createHash, randomBytes, scrypt } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  assertMigrateSucceeded,
  queryJournalDriftState,
  runMigrateWithRecovery,
} from "../lib/migration-drift";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { getDatabaseUrl } from "../../lib/db/connection-utils";
import {
  accounts,
  member,
  organization,
  users,
  userTrustedIps,
  workflows,
} from "../../lib/db/schema";
import { organizationApiKeys } from "../../lib/db/schema-extensions";
import { generateId } from "../../lib/utils/id";
import { seedPersistentTestUsers } from "../../tests/e2e/playwright/utils/seed";
import {
  buildTriggerNodes,
  DEV_WORKFLOW_FIXTURES,
} from "./fixtures/dev-workflows";
import { seedOnboardingWorkflows } from "./seed-onboarding-workflows";

// ---------------------------------------------------------------------------
// Hostname guard
// ---------------------------------------------------------------------------

const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "db", "postgres"]);

function assertLocalDb(url: string): string {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    throw new Error(
      `dev-bootstrap: DATABASE_URL is not a parseable URL: ${url}`
    );
  }
  if (!ALLOWED_HOSTS.has(hostname)) {
    throw new Error(
      `dev-bootstrap: refusing to run against host "${hostname}". ` +
        `Only ${[...ALLOWED_HOSTS].join(", ")} are allowed. ` +
        "Set DATABASE_URL to a local Postgres before re-running."
    );
  }
  return hostname;
}

// ---------------------------------------------------------------------------
// Password hashing (matches tests/e2e/playwright/utils/seed.ts so the
// dev user's password is verifiable through Better Auth's credential flow)
// ---------------------------------------------------------------------------

const SCRYPT_CONFIG = { N: 16_384, r: 16, p: 1, dkLen: 64 } as const;
const DEFAULT_DEV_PASSWORD = "Test1234!";

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function scryptAsync(
  password: string,
  salt: string,
  keylen: number
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      keylen,
      {
        N: SCRYPT_CONFIG.N,
        r: SCRYPT_CONFIG.r,
        p: SCRYPT_CONFIG.p,
        maxmem: 128 * SCRYPT_CONFIG.N * SCRYPT_CONFIG.r * 2,
      },
      (err, derivedKey) => {
        if (err) {
          reject(err);
        } else {
          resolve(derivedKey);
        }
      }
    );
  });
}

async function hashPassword(password: string): Promise<string> {
  const saltBytes = randomBytes(16);
  const salt = bytesToHex(saltBytes);
  const key = await scryptAsync(
    password.normalize("NFKC"),
    salt,
    SCRYPT_CONFIG.dkLen
  );
  return `${salt}:${bytesToHex(key)}`;
}

// ---------------------------------------------------------------------------
// Step 2 + 3: migration journal + db:migrate
// ---------------------------------------------------------------------------

async function maybeBackfillJournal(
  client: ReturnType<typeof postgres>
): Promise<boolean> {
  const state = await queryJournalDriftState(client);
  return state.usersExists && state.journalCount === 0;
}

function runChildScript(script: string, label: string): void {
  console.log(`> ${label}`);
  const result = spawnSync("pnpm", ["tsx", script], {
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`${label} exited with status ${result.status ?? "null"}`);
  }
}

async function runMigrate(databaseUrl: string): Promise<void> {
  console.log("> apply migrations");
  const result = await runMigrateWithRecovery(databaseUrl, process.env);
  assertMigrateSucceeded(result);
}

// ---------------------------------------------------------------------------
// Step 5: dev user upsert
// ---------------------------------------------------------------------------

type DevIdentity = {
  userId: string;
  orgId: string;
  email: string;
};

async function ensureDevIdentity(
  db: ReturnType<typeof drizzle>
): Promise<DevIdentity> {
  const email = process.env.SEED_DEV_EMAIL ?? "dev@keeperhub.local";
  const name = process.env.SEED_DEV_NAME ?? "Dev User";
  const password = process.env.SEED_DEV_PASSWORD ?? DEFAULT_DEV_PASSWORD;
  const orgSlug = process.env.SEED_DEV_ORG_SLUG ?? "dev-org";
  const orgName = process.env.SEED_DEV_ORG_NAME ?? "Dev Org";
  const now = new Date();

  const existingUser = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  let userId: string;
  if (existingUser[0]) {
    userId = existingUser[0].id;
    // twoFactorEnabled=true so the dev user passes proxy.ts:mfaBlock with a
    // minted (rather than enrolled) session. The session row carries
    // requiresMfa=false and mfaVerifiedAt set, so the gate sees an "enrolled"
    // user with a satisfied step-up. No two_factor row is seeded; the dev
    // mint flow never asks the user for a TOTP, so no secret is needed.
    await db
      .update(users)
      .set({
        emailVerified: true,
        twoFactorEnabled: true,
        updatedAt: now,
      })
      .where(eq(users.id, userId));
  } else {
    userId = generateId();
    await db.insert(users).values({
      id: userId,
      name,
      email,
      emailVerified: true,
      twoFactorEnabled: true,
      createdAt: now,
      updatedAt: now,
      isAnonymous: false,
    });
  }

  const existingAccount = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.userId, userId))
    .limit(1);

  if (existingAccount.length === 0) {
    const hash = await hashPassword(password);
    await db.insert(accounts).values({
      id: generateId(),
      accountId: userId,
      providerId: "credential",
      userId,
      password: hash,
      createdAt: now,
      updatedAt: now,
    });
  }

  const existingOrg = await db
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.slug, orgSlug))
    .limit(1);

  let orgId: string;
  if (existingOrg[0]) {
    orgId = existingOrg[0].id;
  } else {
    orgId = generateId();
    await db.insert(organization).values({
      id: orgId,
      name: orgName,
      slug: orgSlug,
      createdAt: now,
    });
  }

  // Check membership in THIS specific org; a user may already belong to other
  // orgs from earlier ad-hoc seeds.
  const existingMember = await db
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.userId, userId), eq(member.organizationId, orgId)))
    .limit(1);

  if (existingMember.length === 0) {
    await db.insert(member).values({
      id: generateId(),
      organizationId: orgId,
      userId,
      role: "owner",
      createdAt: now,
    });
  }

  await ensureTrustedLocalIps(db, userId);

  return { userId, orgId, email };
}

// Pre-trust the IPs Chrome will use when hitting localhost:3000 so the
// proxy gate's legacy-IP bridge (login-risk.ts:gateRequestCountry) passes
// for the minted session even if a CF-IPCountry header is forced in for
// testing. Without these a forced-country local request would redirect to
// /verify-ip, which defeats the point of skipping the UI auth flow.
//
// IPv4 stored as-is; IPv6 ::1 normalizes to its /64 (all-zero) prefix per
// normalizeIpForTrust, matching what the bridge looks up.
const TRUSTED_LOCAL_IPS = [
  "127.0.0.1",
  "0000:0000:0000:0000:0000:0000:0000:0000",
] as const;

async function ensureTrustedLocalIps(
  db: ReturnType<typeof drizzle>,
  userId: string
): Promise<void> {
  const now = new Date();
  for (const ip of TRUSTED_LOCAL_IPS) {
    const existing = await db
      .select({ id: userTrustedIps.id })
      .from(userTrustedIps)
      .where(and(eq(userTrustedIps.userId, userId), eq(userTrustedIps.ip, ip)))
      .limit(1);
    if (existing.length === 0) {
      await db.insert(userTrustedIps).values({
        userId,
        ip,
        country: "LOCAL",
        firstSeenAt: now,
        lastSeenAt: now,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Step 6: kh CLI key binding
// ---------------------------------------------------------------------------

const KH_HOSTS_FILE = path.join(os.homedir(), ".config/kh/hosts.yml");
const KH_HOST = process.env.SEED_DEV_KH_HOST ?? "localhost:3000";

function readKhToken(host: string): string | null {
  if (!fs.existsSync(KH_HOSTS_FILE)) {
    return null;
  }
  const text = fs.readFileSync(KH_HOSTS_FILE, "utf8");
  const lines = text.split(/\r?\n/);
  const hostPattern = new RegExp(`^(\\s+)${escapeRegex(host)}:\\s*$`);

  for (const [i, line] of lines.entries()) {
    const match = line.match(hostPattern);
    if (!match) {
      continue;
    }
    const hostIndent = match[1].length;
    // Scan downward from this host header for the first `token:` line whose
    // indent is deeper than the host header's. Stop once indent returns to
    // the host level or above (sibling key) or we hit EOF.
    for (const inner of lines.slice(i + 1)) {
      if (inner.trim() === "") {
        continue;
      }
      const indent = inner.length - inner.trimStart().length;
      if (indent <= hostIndent) {
        break;
      }
      const tokenMatch = inner.match(/^\s+token:\s*(\S+)\s*$/);
      if (tokenMatch) {
        return tokenMatch[1];
      }
    }
    return null;
  }
  return null;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\:]/g, "\\$&");
}

async function bindKhKey(
  db: ReturnType<typeof drizzle>,
  identity: DevIdentity
): Promise<{ bound: boolean; prefix?: string; reason?: string }> {
  const token = readKhToken(KH_HOST);
  if (!token) {
    return {
      bound: false,
      reason: `no token for "${KH_HOST}" in ${KH_HOSTS_FILE}`,
    };
  }
  if (!token.startsWith("kh_")) {
    return { bound: false, reason: `token does not have kh_ prefix` };
  }

  const keyHash = createHash("sha256").update(token).digest("hex");
  const keyPrefix = token.slice(0, 8);

  const existing = await db
    .select({ id: organizationApiKeys.id })
    .from(organizationApiKeys)
    .where(eq(organizationApiKeys.keyHash, keyHash))
    .limit(1);

  if (existing[0]) {
    await db
      .update(organizationApiKeys)
      .set({
        organizationId: identity.orgId,
        createdBy: identity.userId,
        revokedAt: null,
        expiresAt: null,
      })
      .where(eq(organizationApiKeys.id, existing[0].id));
    return { bound: true, prefix: keyPrefix };
  }

  await db.insert(organizationApiKeys).values({
    id: generateId(),
    organizationId: identity.orgId,
    name: `local kh CLI (${KH_HOST})`,
    keyHash,
    keyPrefix,
    createdBy: identity.userId,
  });
  return { bound: true, prefix: keyPrefix };
}

// ---------------------------------------------------------------------------
// Step 7: workflow fixtures
// ---------------------------------------------------------------------------

async function seedWorkflowFixtures(
  db: ReturnType<typeof drizzle>,
  identity: DevIdentity
): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;
  const now = new Date();

  for (const fixture of DEV_WORKFLOW_FIXTURES) {
    const { nodes, edges } = buildTriggerNodes(fixture);
    const existing = await db
      .select({ id: workflows.id })
      .from(workflows)
      .where(eq(workflows.id, fixture.id))
      .limit(1);

    if (existing[0]) {
      await db
        .update(workflows)
        .set({
          name: fixture.name,
          description: fixture.description,
          userId: identity.userId,
          organizationId: identity.orgId,
          nodes,
          edges,
          enabled: fixture.enabled,
          deletedAt: fixture.softDeleted ? now : null,
          updatedAt: now,
        })
        .where(eq(workflows.id, fixture.id));
      updated++;
    } else {
      await db.insert(workflows).values({
        id: fixture.id,
        name: fixture.name,
        description: fixture.description,
        userId: identity.userId,
        organizationId: identity.orgId,
        nodes,
        edges,
        visibility: "private",
        enabled: fixture.enabled,
        deletedAt: fixture.softDeleted ? now : null,
        createdAt: now,
        updatedAt: now,
      });
      created++;
    }
  }
  return { created, updated };
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const host = assertLocalDb(url);
  console.log(`dev-bootstrap: connected to ${host}`);

  const client = postgres(url, { max: 1 });
  try {
    const needsBackfill = await maybeBackfillJournal(client);
    if (needsBackfill) {
      runChildScript(
        path.join(__dirname, "..", "backfill-drizzle-migrations.ts"),
        "backfill drizzle journal (db:push -> db:migrate handoff)"
      );
    } else {
      console.log("> journal already populated or fresh DB; skipping backfill");
    }
  } finally {
    await client.end();
  }

  await runMigrate(url);

  console.log("> seedPersistentTestUsers()");
  await seedPersistentTestUsers();

  const seedClient = postgres(url, { max: 1 });
  const db = drizzle(seedClient);
  try {
    const identity = await ensureDevIdentity(db);
    console.log(`  + dev user: ${identity.email} (${identity.userId})`);
    console.log(`  + dev org:  ${identity.orgId}`);

    const keyBinding = await bindKhKey(db, identity);
    if (keyBinding.bound) {
      console.log(`  + kh key:   bound to dev org (prefix ${keyBinding.prefix})`);
    } else {
      console.log(`  ! kh key:   skipped (${keyBinding.reason})`);
    }

    const fixtures = await seedWorkflowFixtures(db, identity);
    console.log(
      `  + workflows: ${fixtures.created} created, ${fixtures.updated} updated ` +
        `(${DEV_WORKFLOW_FIXTURES.length} total fixtures)`
    );

    const onboarding = await seedOnboardingWorkflows(db, identity);
    console.log(
      `  + onboarding: ${onboarding.created} created, ${onboarding.refreshed} refreshed, ` +
        `${onboarding.skipped} skipped (user-edited)`
    );

    // Use sql to keep schema imports honest: this is just a smoke-test count.
    const total = await db.execute(
      sql`SELECT COUNT(*)::int AS c FROM workflows WHERE organization_id = ${identity.orgId}`
    );
    const totalRow = total as unknown as Array<{ c: number }>;
    console.log(`  = workflows in dev org: ${totalRow[0]?.c ?? "?"}`);
  } finally {
    await seedClient.end();
  }

  console.log("\ndev-bootstrap: done.");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
