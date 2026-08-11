import { and, desc, eq, ilike, inArray, lt, or, sql } from "drizzle-orm";
import { unstable_cache } from "next/cache";
import { db } from "@/lib/db";
import { organization, workflows } from "@/lib/db/schema";
import { publicTags, workflowPublicTags } from "@/lib/db/schema-extensions";
import { workflowPayments } from "@/lib/db/schema-payments";
import { sanitizeDescription } from "@/lib/sanitize-description";

export type MarketplaceSort =
  | "popular"
  | "newest"
  | "top-calls"
  | "price"
  | "owner";

export type MarketplaceLeaderboardRow = {
  workflowId: string;
  listedSlug: string | null;
  displayName: string;
  description: string | null;
  organizationName: string | null;
  callCount: number;
  priceUsdcPerCall: string | null;
  chain: string | null;
  listedAt: Date | null;
  tags: string[];
  inputSchema: Record<string, unknown> | null;
  outputMapping: Record<string, unknown> | null;
};

export type MarketplaceLeaderboardResult = {
  rows: MarketplaceLeaderboardRow[];
  nextCursor: string | null;
  total: number;
};

const PAGE_LIMIT = 50;

// Escape LIKE/ILIKE metacharacters so user input is treated as a literal
// substring. Drizzle parameterises the bound value, so this is a UX fix
// (no accidental wildcard) rather than a security fix.
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

type CursorPayload = {
  c: number; // last callCount
  i: string; // last workflowId tiebreaker
};

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(raw: string | null): CursorPayload | null {
  if (!raw) {
    return null;
  }
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as CursorPayload;
    if (typeof parsed.c !== "number" || typeof parsed.i !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function runLeaderboardQuery(
  sort: MarketplaceSort,
  cursor: CursorPayload | null,
  query: string,
  tagSlug: string | null,
  ownerName: string | null
): Promise<MarketplaceLeaderboardResult> {
  // PUBLIC COLUMN WHITELIST -- see MARKET-04. Adding fields here requires
  // re-reading MARKET-04 + MARKET-13 first. NEVER add private columns:
  //   - workflows.{user identity}
  //   - workflowPayments.{usdc amount, payer wallet, creator wallet}
  // The grep gate in 44-05 acceptance asserts these literal identifiers
  // appear ZERO times in this file -- spell them out in PROSE only.
  //
  // Phase 44.x revision: the org's public display name is now exposed in the
  // marketplace as a trust signal (analog to App Store developer name). The
  // internal organization id is NOT surfaced — only the human-chosen name
  // joined from the organization table, which keeps MARKET-13's banned-token
  // grep clean.
  const callCountExpr = sql<number>`count(${workflowPayments.id})::int`;

  const baseFilter = eq(workflows.isListed, true);

  // Cursor filter for popular/top-calls (callCount tiebroken by id). The
  // cursor payload encodes `{c: callCount, i: id}` which only makes sense
  // for those two sorts; nextCursor is gated to match below so newest/price
  // never emit a cursor in the first place.
  const cursorFilter =
    cursor && (sort === "popular" || sort === "top-calls")
      ? or(
          lt(callCountExpr, cursor.c),
          and(eq(callCountExpr, cursor.c), lt(workflows.id, cursor.i))
        )
      : undefined;

  // Free-text filter spanning the public display name and the joined
  // organization name (the marketplace's two human-facing labels). A user
  // typing "keeperhub" finds rows whose name or owner contains the term.
  // Case-insensitive, simple substring match; no full-text indexing yet —
  // fine at v1.11 scale. Escape LIKE metacharacters so a user typing `_` or
  // `%` doesn't get unexpected wildcard semantics.
  const queryFilter = (() => {
    if (query === "") {
      return undefined;
    }
    const pattern = `%${escapeLikePattern(query)}%`;
    return or(
      ilike(workflows.name, pattern),
      ilike(organization.name, pattern)
    );
  })();

  // Owner filter — exact case-insensitive match on the joined organization
  // name. Used by the clickable owner cell so clicking "KeeperHub" returns
  // only that org's listings, not "KeeperHub Demo" too. The COUNT query
  // below applies the same filter for an accurate "Showing N of TOTAL".
  const ownerFilter =
    ownerName === null
      ? undefined
      : sql`lower(${organization.name}) = lower(${ownerName})`;

  // Tag filter — restrict to workflows linked to the given public tag slug.
  // Resolved via a sub-select on workflow_public_tags + public_tags (slug is
  // the human-shareable URL token; id is the internal FK).
  const tagFilter = tagSlug
    ? inArray(
        workflows.id,
        db
          .select({ workflowId: workflowPublicTags.workflowId })
          .from(workflowPublicTags)
          .innerJoin(
            publicTags,
            eq(publicTags.id, workflowPublicTags.publicTagId)
          )
          .where(eq(publicTags.slug, tagSlug))
      )
    : undefined;

  const whereClause = and(
    baseFilter,
    cursorFilter,
    queryFilter,
    tagFilter,
    ownerFilter
  );

  const orderClause = (() => {
    if (sort === "newest") {
      return [desc(workflows.listedAt), desc(workflows.id)];
    }
    if (sort === "price") {
      // Price sort: highest priced first; nulls last so unpriced rows don't
      // float to the top. Tiebreak by id for stable ordering.
      return [
        sql`${workflows.priceUsdcPerCall} desc nulls last`,
        desc(workflows.id),
      ];
    }
    if (sort === "owner") {
      // Owner sort: A→Z by joined organization name; anonymous (null)
      // listings sink to the bottom so named providers lead. Tiebreak by id.
      return [sql`${organization.name} asc nulls last`, desc(workflows.id)];
    }
    return [desc(callCountExpr), desc(workflows.id)];
  })();

  const rows = await db
    .select({
      workflowId: workflows.id,
      listedSlug: workflows.listedSlug,
      displayName: workflows.name,
      description: workflows.description,
      organizationName: organization.name,
      callCount: callCountExpr,
      priceUsdcPerCall: workflows.priceUsdcPerCall,
      chain: workflows.chain,
      listedAt: workflows.listedAt,
      inputSchema: workflows.inputSchema,
      outputMapping: workflows.outputMapping,
    })
    .from(workflows)
    .leftJoin(organization, eq(organization.id, workflows.organizationId))
    .leftJoin(workflowPayments, eq(workflowPayments.workflowId, workflows.id))
    .where(whereClause)
    // Postgres strict-aggregate rule: any non-aggregated SELECT column must
    // appear in GROUP BY. workflows.id functionally determines every other
    // workflows.* column (PK), so adding it here is enough — but joined
    // tables don't get the same free pass, so organization.name must be
    // listed explicitly.
    .groupBy(workflows.id, organization.name)
    .orderBy(...orderClause)
    .limit(PAGE_LIMIT + 1);

  // Total count of listed workflows matching the active query (for the
  // "Showing 1-N of TOTAL" footer). Single COUNT(*) — cheap because
  // workflows.is_listed has an index path; the optional ILIKE adds a
  // small linear scan over the listed subset.
  const totalRow = await db
    .select({ value: sql<number>`count(distinct ${workflows.id})::int` })
    .from(workflows)
    .leftJoin(organization, eq(organization.id, workflows.organizationId))
    .where(and(baseFilter, queryFilter, tagFilter, ownerFilter));
  const total = totalRow[0]?.value ?? 0;

  const hasMore = rows.length > PAGE_LIMIT;
  const pageRows = hasMore ? rows.slice(0, PAGE_LIMIT) : rows;
  const last = pageRows.at(-1);
  // Only emit a cursor for sorts whose cursor payload is meaningful. For
  // newest + price, the cursor decoder would silently no-op the filter and
  // page 2 would re-return page 1, so we suppress the cursor entirely until
  // those branches grow real listedAt / priceUsdcPerCall cursor support.
  const cursorEligible = sort === "popular" || sort === "top-calls";
  const nextCursor =
    cursorEligible && hasMore && last
      ? encodeCursor({ c: last.callCount, i: last.workflowId })
      : null;

  // Tags fetched in a separate query to avoid row multiplication on the main
  // GROUP BY (joining the tag link table here would inflate COUNT(payments)).
  // Public tag names are part of the marketplace's public column whitelist.
  const pageIds = pageRows.map((r) => r.workflowId);
  const tagRows =
    pageIds.length === 0
      ? []
      : await db
          .select({
            workflowId: workflowPublicTags.workflowId,
            name: publicTags.name,
          })
          .from(workflowPublicTags)
          .innerJoin(
            publicTags,
            eq(publicTags.id, workflowPublicTags.publicTagId)
          )
          .where(inArray(workflowPublicTags.workflowId, pageIds))
          .orderBy(publicTags.name);

  const tagsByWorkflow = new Map<string, string[]>();
  for (const { workflowId, name } of tagRows) {
    const list = tagsByWorkflow.get(workflowId) ?? [];
    list.push(name);
    tagsByWorkflow.set(workflowId, list);
  }

  // Marketplace is a public surface — every viewer is treated as a non-owner
  // for description purposes. Mirrors the GET /api/workflows/[id] sanitisation
  // applied on listed workflows so injection markers can't reach the row card.
  const rowsWithTags: MarketplaceLeaderboardRow[] = pageRows.map((row) => ({
    ...row,
    description: row.description
      ? sanitizeDescription(row.description, { maxLength: 2000 })
      : null,
    tags: tagsByWorkflow.get(row.workflowId) ?? [],
  }));

  return { rows: rowsWithTags, nextCursor, total };
}

async function fetchUncached(
  sort: MarketplaceSort,
  cursorRaw: string | null,
  query: string,
  tagSlug: string | null,
  ownerName: string | null
): Promise<MarketplaceLeaderboardResult> {
  const cursor = decodeCursor(cursorRaw);
  return await runLeaderboardQuery(sort, cursor, query, tagSlug, ownerName);
}

// Bypass unstable_cache in dev so editor changes (schema, sort columns,
// seeded data) show up on the next request instead of waiting up to 60s
// or surviving across restarts via the persisted Next data cache. Prod
// keeps the 60s cache for marketplace traffic.
export const fetchMarketplaceLeaderboard =
  process.env.NODE_ENV === "production"
    ? unstable_cache(fetchUncached, ["marketplace-leaderboard"], {
        revalidate: 60,
        tags: ["marketplace"],
      })
    : fetchUncached;

export { encodeCursor as encodeMarketplaceCursor };
