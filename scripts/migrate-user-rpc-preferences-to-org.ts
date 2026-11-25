/**
 * One-time move of per-user RPC preferences into organization RPC configs.
 *
 * Before organization configs existed, a user could store their own primary,
 * fallback and WebSocket URLs per chain, and only some workflow paths honoured
 * them. Each such row becomes a config in every organization where that user
 * is an owner or admin, named MIGRATED_CONFIG_NAME. It becomes the chain's
 * default only when the organization has none, and "own RPC only" is left off,
 * so nothing that runs today changes route without someone choosing it.
 *
 * URLs are stored encrypted and never printed. Rows whose user manages no
 * organization, whose chain is unknown or disabled, or whose URL is malformed
 * are skipped and reported by id. The new configs carry no verification
 * result yet: run "Test" on each from settings, or the config API, after the
 * move.
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
import { chains, member, userRpcPreferences } from "@/lib/db/schema";
import { organizationRpcConfigs } from "@/lib/db/schema-rpc";
import { ORG_MANAGERS } from "@/lib/middleware/require-org-role";
import { encodeRpcConfigUrls } from "@/lib/rpc/engine/org/codec";
import {
  RpcConfigUrlSlot,
  type RpcConfigUrls,
} from "@/lib/rpc/engine/org/url-slots";
import { isLocalDb } from "@/scripts/lib/local-db";

const MIGRATED_CONFIG_NAME = "Migrated from user settings";

const SkipReason = {
  NO_MANAGED_ORGANIZATION: "user is not an owner or admin of any organization",
  CHAIN_UNAVAILABLE: "chain is unknown or disabled",
  INVALID_URL: "a stored URL is malformed",
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

async function enabledChainIds(): Promise<Set<number>> {
  const rows = await db
    .select({ chainId: chains.chainId })
    .from(chains)
    .where(eq(chains.isEnabled, true));
  return new Set(rows.map((row) => row.chainId));
}

async function existingConfigs(
  organizationId: string,
  chainId: number
): Promise<{ migrated: boolean; hasDefault: boolean }> {
  const rows = await db
    .select({
      name: organizationRpcConfigs.name,
      isDefault: organizationRpcConfigs.isDefault,
    })
    .from(organizationRpcConfigs)
    .where(
      and(
        eq(organizationRpcConfigs.organizationId, organizationId),
        eq(organizationRpcConfigs.chainId, chainId)
      )
    );
  return {
    migrated: rows.some((row) => row.name === MIGRATED_CONFIG_NAME),
    hasDefault: rows.some((row) => row.isDefault),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!(args.dryRun || args.yes || isLocalDb())) {
    console.error(
      "Refusing a live run against a non-local database without --yes."
    );
    process.exit(1);
  }

  const preferences = await db.select().from(userRpcPreferences);
  const chainIds = await enabledChainIds();
  const skipped: { preferenceId: string; reason: SkipReason }[] = [];
  let created = 0;
  let alreadyMigrated = 0;

  for (const preference of preferences) {
    if (!chainIds.has(preference.chainId)) {
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

    let encoded: ReturnType<typeof encodeRpcConfigUrls>;
    try {
      encoded = encodeRpcConfigUrls(urlsOf(preference));
    } catch {
      skipped.push({
        preferenceId: preference.id,
        reason: SkipReason.INVALID_URL,
      });
      continue;
    }

    for (const organizationId of organizations) {
      const existing = await existingConfigs(
        organizationId,
        preference.chainId
      );
      if (existing.migrated) {
        alreadyMigrated += 1;
        continue;
      }
      if (!args.dryRun) {
        await db.insert(organizationRpcConfigs).values({
          organizationId,
          chainId: preference.chainId,
          name: MIGRATED_CONFIG_NAME,
          isDefault: !existing.hasDefault,
          enabled: true,
          ...encoded,
          verification: {},
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
  console.error(
    "[migrate-user-rpc-preferences] failed:",
    error instanceof Error ? error.message : "unknown error"
  );
  process.exit(1);
});
