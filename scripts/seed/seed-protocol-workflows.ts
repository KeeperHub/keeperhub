/**
 * Seed protocol-coverage workflows into the database (KEEP-458).
 *
 * Reads co-located `TEST_DATA` from each `protocols/<slug>.ts` and inserts
 * one workflow row per (protocol, chain, action, trigger) — plus the setup
 * workflow per (protocol, chain) — owned by the persistent test user.
 *
 * Idempotent: deterministic IDs derived from the tuple mean re-runs are a
 * no-op for already-seeded workflows.
 *
 * Usage:
 *   pnpm tsx scripts/seed/seed-protocol-workflows.ts \
 *     [--protocol=<slug>] [--chain=<chainId>] [--phase=setup|read|write] \
 *     [--trigger=Manual|Schedule|Webhook|Event|Block] [--user=<email>]
 */

import { createHash } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getDatabaseUrl } from "../../lib/db/connection-utils";
import { member, users, workflows } from "../../lib/db/schema";
import { organizationWallets } from "../../lib/db/schema-extensions";
import "@/protocols";
import {
  buildActionWorkflow,
  buildSetupWorkflow,
  type BuiltWorkflow,
  listCoverageTargets,
  TRIGGER_TYPES,
  type TriggerType,
} from "../../lib/test-data/build-workflow";
import { getProtocol } from "../../lib/protocol-registry";

type Cli = {
  protocol?: string;
  chainId?: string;
  phase?: "setup" | "read" | "write";
  trigger?: TriggerType;
  userEmail: string;
};

function parseCli(argv: string[]): Cli {
  const cli: Cli = {
    userEmail:
      process.env.SEED_EMAIL ?? "pr-test-do-not-delete@techops.services",
  };
  for (const arg of argv.slice(2)) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    if (!value) {
      continue;
    }
    if (key === "protocol") {
      cli.protocol = value;
    } else if (key === "chain") {
      cli.chainId = value;
    } else if (key === "phase") {
      if (value === "setup" || value === "read" || value === "write") {
        cli.phase = value;
      }
    } else if (key === "trigger") {
      if ((TRIGGER_TYPES as readonly string[]).includes(value)) {
        cli.trigger = value as TriggerType;
      }
    } else if (key === "user") {
      cli.userEmail = value;
    }
  }
  return cli;
}

function deterministicId(parts: string[]): string {
  const hash = createHash("sha256").update(parts.join("/")).digest("hex").slice(0, 12);
  return `proto-${hash}`;
}

type SeedOutcome = "inserted" | "refreshed" | "skipped" | "failed";

// Slack between the seeder's last touch and the row's updatedAt on a row
// the seeder has just written. INSERT and UPDATE stamp seededAt and
// updatedAt to the same `now` within one statement, but timestamps round to
// microsecond resolution and can differ by a few ms across statements.
// 5 seconds is wide enough to absorb that without masking real user edits.
export const USER_EDIT_EPSILON_MS = 5000;

export type ExistingWorkflowRow = {
  updatedAt: Date;
  seededAt: Date | null;
};

export type SeedAction =
  | { kind: "insert" }
  | { kind: "refresh" }
  | { kind: "skip"; reason: "user-created" | "user-edited"; gapMs?: number };

/**
 * Decide what to do with a deterministic-ID workflow row given the existing
 * state. Pure: separates the gating logic from the SQL plumbing in
 * upsertOne so it can be unit-tested cheaply (no DB stubs).
 *
 *   - undefined existing -> insert
 *   - seededAt null -> skip (user-created; deterministic-ID collision is
 *     astronomically unlikely, but the null check is free)
 *   - updatedAt > seededAt + epsilon -> skip (user-edited after last seed)
 *   - otherwise -> refresh
 *
 * Reciprocally: gapMs <= epsilon (including zero and negative gaps from
 * timestamp rounding or clock skew) is treated as the seeder's own touch.
 */
export function decideSeedAction(
  existing: ExistingWorkflowRow | undefined,
  epsilonMs: number
): SeedAction {
  if (!existing) {
    return { kind: "insert" };
  }
  if (existing.seededAt === null) {
    return { kind: "skip", reason: "user-created" };
  }
  const gapMs = existing.updatedAt.getTime() - existing.seededAt.getTime();
  if (gapMs > epsilonMs) {
    return { kind: "skip", reason: "user-edited", gapMs };
  }
  return { kind: "refresh" };
}

async function upsertOne(
  db: ReturnType<typeof drizzle>,
  workflow: BuiltWorkflow,
  idParts: string[],
  userId: string,
  organizationId: string,
  now: Date
): Promise<SeedOutcome> {
  const id = deterministicId(idParts);
  try {
    const existing = await db
      .select({
        updatedAt: workflows.updatedAt,
        seededAt: workflows.seededAt,
      })
      .from(workflows)
      .where(eq(workflows.id, id))
      .limit(1);

    const action = decideSeedAction(existing[0], USER_EDIT_EPSILON_MS);
    if (action.kind === "skip") {
      const detail =
        action.reason === "user-created"
          ? "row exists but seededAt is null -- user-created"
          : `user-edited; updatedAt is ${action.gapMs}ms after seededAt`;
      console.warn(`  ~ ${idParts.join("/")}: skipped (${detail})`);
      return "skipped";
    }

    if (action.kind === "insert") {
      await db.insert(workflows).values({
        id,
        name: workflow.name,
        description: workflow.description,
        userId,
        organizationId,
        nodes: workflow.nodes,
        edges: workflow.edges,
        visibility: "private",
        enabled: true,
        createdAt: now,
        updatedAt: now,
        seededAt: now,
      });
      return "inserted";
    }

    await db
      .update(workflows)
      .set({
        name: workflow.name,
        description: workflow.description,
        nodes: workflow.nodes,
        edges: workflow.edges,
        updatedAt: now,
        seededAt: now,
      })
      .where(eq(workflows.id, id));
    return "refreshed";
  } catch (err) {
    console.error(
      `  ! ${idParts.join("/")}: upsert failed (${(err as Error).message})`
    );
    return "failed";
  }
}

async function seed(cli: Cli): Promise<void> {
  const client = postgres(getDatabaseUrl(), { max: 1 });
  const db = drizzle(client);

  console.log("Seeding protocol-coverage workflows");
  console.log(`User: ${cli.userEmail}`);

  const userRow = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, cli.userEmail))
    .limit(1);
  if (!userRow[0]) {
    console.error(
      `User "${cli.userEmail}" not found. Run seed-test-wallet.ts first.`
    );
    await client.end();
    process.exit(1);
  }
  const userId = userRow[0].id;

  // Order by createdAt then id so multi-org test users resolve to the same
  // organization on every seed run. Without orderBy, Postgres can return any
  // matching row, which would let the chosen org -- and therefore the wallet
  // address baked into every seeded workflow -- silently shift between runs.
  const memberRow = await db
    .select({ organizationId: member.organizationId })
    .from(member)
    .where(eq(member.userId, userId))
    .orderBy(asc(member.createdAt), asc(member.id))
    .limit(1);
  const orgId = memberRow[0]?.organizationId ?? null;

  if (!orgId) {
    console.error(
      `User "${cli.userEmail}" has no organization; cannot resolve a wallet to bake into seeded workflows.`
    );
    await client.end();
    process.exit(1);
  }

  const walletRow = await db
    .select({ walletAddress: organizationWallets.walletAddress })
    .from(organizationWallets)
    .where(
      and(eq(organizationWallets.organizationId, orgId), eq(organizationWallets.isActive, true))
    )
    .limit(1);
  if (!walletRow[0]) {
    console.error(
      `No active wallet for org "${orgId}". Run pnpm db:seed-test-wallet (with TURNKEY_* env vars) first.`
    );
    await client.end();
    process.exit(1);
  }
  const walletAddress = walletRow[0].walletAddress;
  console.log(`Wallet: ${walletAddress}`);

  const targets = listCoverageTargets().filter(
    (t) =>
      (!cli.protocol || t.protocolSlug === cli.protocol) &&
      (!cli.chainId || t.chainId === cli.chainId)
  );
  if (targets.length === 0) {
    console.warn(
      `No coverage targets matched (protocol=${cli.protocol ?? "*"}, chain=${cli.chainId ?? "*"})`
    );
    await client.end();
    return;
  }

  const triggerFilter: TriggerType[] = cli.trigger
    ? [cli.trigger]
    : [...TRIGGER_TYPES];

  const now = new Date();
  const tally: Record<SeedOutcome, number> = {
    inserted: 0,
    refreshed: 0,
    skipped: 0,
    failed: 0,
  };

  for (const target of targets) {
    const { protocolSlug, chainId } = target;
    const protocol = getProtocol(protocolSlug);
    if (!protocol) {
      console.warn(`  ! protocol ${protocolSlug} not registered; skipping`);
      continue;
    }

    if (!cli.phase || cli.phase === "setup") {
      const setupWf = buildSetupWorkflow({
        protocolSlug,
        chainId,
        walletAddress,
      });
      tally[
        await upsertOne(
          db,
          setupWf,
          ["setup", protocolSlug, chainId],
          userId,
          orgId,
          now
        )
      ] += 1;
    }

    for (const action of protocol.actions) {
      if (cli.phase && cli.phase !== action.type) {
        continue;
      }
      for (const trigger of triggerFilter) {
        const wf = buildActionWorkflow({
          protocolSlug,
          actionSlug: action.slug,
          chainId,
          trigger,
          walletAddress,
        });
        tally[
          await upsertOne(
            db,
            wf,
            [action.type, protocolSlug, chainId, action.slug, trigger],
            userId,
            orgId,
            now
          )
        ] += 1;
      }
    }
  }

  console.log(
    `Done. ${tally.inserted} inserted, ${tally.refreshed} refreshed, ${tally.skipped} skipped (user-edited), ${tally.failed} failed.`
  );
  await client.end();
  if (tally.failed > 0) {
    process.exit(1);
  }
}

// Main-guard so `import { decideSeedAction } from ...` in tests/unit doesn't
// fire seed() at module load (which would try to connect to PG on import and
// throw an unhandled rejection in the unit test pool). Mirrors the pattern
// used by scripts/pin-agent-card.ts and scripts/update-agent-uri.ts.
const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("seed-protocol-workflows.ts") ||
    process.argv[1].endsWith("seed-protocol-workflows.js"));

if (isMain) {
  seed(parseCli(process.argv));
}
