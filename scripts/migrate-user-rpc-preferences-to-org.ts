/**
 * One-time move of per-user RPC preferences into organization RPC configs.
 *
 * Before organization configs existed, a user could store their own primary,
 * fallback and WebSocket URLs per chain, and only some workflow paths honoured
 * them. Each such row becomes a config in every organization where that user
 * is an owner or admin, named MIGRATED_CONFIG_NAME. It is never made the
 * chain's default and "own RPC only" is left off, so no workflow changes route
 * until an owner or admin makes it the default from settings.
 *
 * Every URL first passes the same check as a config saved from settings: a
 * public host that answers for the row's chain. URLs are stored encrypted and
 * never printed. Rows whose user manages no organization, whose chain is
 * unknown or disabled, or whose URLs fail the check are skipped and reported
 * by id.
 *
 * Idempotent: a chain that already has a config with the migrated name in an
 * organization is skipped. A LIVE run against a non-local DB requires --yes.
 *
 * `--conditions=react-server` is required: the encryption module is marked
 * `server-only`, whose default entry throws outside a server component.
 *
 * Usage:
 *   pnpm tsx --conditions=react-server scripts/migrate-user-rpc-preferences-to-org.ts --dry-run
 *   pnpm tsx --conditions=react-server scripts/migrate-user-rpc-preferences-to-org.ts          # local DB
 *   pnpm tsx --conditions=react-server scripts/migrate-user-rpc-preferences-to-org.ts --yes    # staging/prod
 */

import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { member, userRpcPreferences } from "@/lib/db/schema";
import { organizationRpcConfigs } from "@/lib/db/schema-rpc";
import { ORG_MANAGERS } from "@/lib/middleware/require-org-role";
import { ErrorCategory, logSystemError, logUserError } from "@/lib/logging";
import { encodeRpcConfigUrls } from "@/lib/rpc/engine/org/codec";
import {
  RpcConfigUrlSlot,
  type RpcConfigUrls,
} from "@/lib/rpc/engine/org/url-slots";
import { verifyRpcConfigUrls } from "@/lib/rpc/engine/org/verify";
import { platformRpcSource } from "@/lib/rpc/engine/runtime";
import type { RpcChain } from "@/lib/rpc/engine/types";
import { isLocalDb } from "@/scripts/lib/local-db";

const MIGRATED_CONFIG_NAME = "Migrated from user settings";

const SkipReason = {
  NO_MANAGED_ORGANIZATION: "user is not an owner or admin of any organization",
  CHAIN_UNAVAILABLE: "chain is unknown or disabled",
  FAILED_CHECK: "a stored URL is not public or does not answer for its chain",
} as const;
type SkipReason = (typeof SkipReason)[keyof typeof SkipReason];

type CliArgs = { dryRun: boolean; yes: boolean };

function parseArgs(argv: readonly string[]): CliArgs {
  return { dryRun: argv.includes("--dry-run"), yes: argv.includes("--yes") };
}

type PreferenceRow = typeof userRpcPreferences.$inferSelect;

function urlsOf(row: PreferenceRow): RpcConfigUrls {
  const urls: RpcConfigUrls = {
    [RpcConfigUrlSlot.HTTP_PRIMARY]: row.primaryRpcUrl,
  };
  if (row.fallbackRpcUrl) {
    urls[RpcConfigUrlSlot.HTTP_FALLBACK] = row.fallbackRpcUrl;
  }
  if (row.primaryWssUrl) {
    urls[RpcConfigUrlSlot.WSS_PRIMARY] = row.primaryWssUrl;
  }
  if (row.fallbackWssUrl) {
    urls[RpcConfigUrlSlot.WSS_FALLBACK] = row.fallbackWssUrl;
  }
  return urls;
}

async function managedOrganizations(userId: string): Promise<string[]> {
  const rows = await db
    .select({ organizationId: member.organizationId })
    .from(member)
    .where(
      and(eq(member.userId, userId), inArray(member.role, [...ORG_MANAGERS]))
    );
  return rows.map((row) => row.organizationId);
}

async function enabledChain(chainId: number): Promise<RpcChain | null> {
  const record = await platformRpcSource.load(chainId);
  return record?.chain.isEnabled ? record.chain : null;
}

type ChainConfigs = {
  /** This user's preference was already migrated into the organization. */
  migrated: boolean;
  /** Names already taken on the chain. */
  names: Set<string>;
};

async function existingConfigs(
  organizationId: string,
  chainId: number,
  userId: string
): Promise<ChainConfigs> {
  const rows = await db
    .select({
      name: organizationRpcConfigs.name,
      createdBy: organizationRpcConfigs.createdBy,
    })
    .from(organizationRpcConfigs)
    .where(
      and(
        eq(organizationRpcConfigs.organizationId, organizationId),
        eq(organizationRpcConfigs.chainId, chainId)
      )
    );
  return {
    migrated: rows.some(
      (row) =>
        row.createdBy === userId && row.name.startsWith(MIGRATED_CONFIG_NAME)
    ),
    names: new Set(rows.map((row) => row.name)),
  };
}

/** The migrated name, numbered when another admin's preference took it. */
function migratedName(taken: ReadonlySet<string>): string {
  if (!taken.has(MIGRATED_CONFIG_NAME)) {
    return MIGRATED_CONFIG_NAME;
  }
  let n = 2;
  while (taken.has(`${MIGRATED_CONFIG_NAME} ${n}`)) {
    n += 1;
  }
  return `${MIGRATED_CONFIG_NAME} ${n}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!(args.dryRun || args.yes || isLocalDb())) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[RPC Preference Migration] Refusing a live run against a non-local database without --yes"
    );
    process.exit(1);
  }

  const preferences = await db.select().from(userRpcPreferences);
  const skipped: { preferenceId: string; reason: SkipReason }[] = [];
  let created = 0;
  let alreadyMigrated = 0;

  for (const preference of preferences) {
    const chain = await enabledChain(preference.chainId);
    if (!chain) {
      skipped.push({
        preferenceId: preference.id,
        reason: SkipReason.CHAIN_UNAVAILABLE,
      });
      continue;
    }
    const organizations = await managedOrganizations(preference.userId);
    if (organizations.length === 0) {
      skipped.push({
        preferenceId: preference.id,
        reason: SkipReason.NO_MANAGED_ORGANIZATION,
      });
      continue;
    }

    const urls = urlsOf(preference);
    const checked = await verifyRpcConfigUrls(urls, chain);
    if (!checked.ok) {
      skipped.push({
        preferenceId: preference.id,
        reason: SkipReason.FAILED_CHECK,
      });
      continue;
    }
    const encryptedUrls = encodeRpcConfigUrls(urls);

    for (const organizationId of organizations) {
      const existing = await existingConfigs(
        organizationId,
        preference.chainId,
        preference.userId
      );
      if (existing.migrated) {
        alreadyMigrated += 1;
        continue;
      }
      if (!args.dryRun) {
        await db.insert(organizationRpcConfigs).values({
          organizationId,
          chainId: preference.chainId,
          name: migratedName(existing.names),
          isDefault: false,
          enabled: true,
          encryptedUrls,
          verification: checked.verification,
          createdBy: preference.userId,
          updatedBy: preference.userId,
        });
      }
      created += 1;
    }
  }

  console.info(
    JSON.stringify(
      {
        mode: args.dryRun ? "dry-run" : "live",
        preferences: preferences.length,
        configsCreated: created,
        alreadyMigrated,
        skipped,
      },
      null,
      2
    )
  );
  process.exit(0);
}

main().catch((error: unknown) => {
  logSystemError(
    ErrorCategory.DATABASE,
    "[RPC Preference Migration] Failed",
    error instanceof Error ? error : new Error("unknown error")
  );
  process.exit(1);
});
