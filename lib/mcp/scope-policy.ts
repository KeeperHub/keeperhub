import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { member, organization } from "@/lib/db/schema";
import { mcpScopeEpochs } from "@/lib/db/schema-oauth";
import { clampScope, highestScopeRank } from "@/lib/mcp/oauth-scopes";

/**
 * How long a policy read is trusted without going back to the database. Every
 * MCP call consults it, so an uncached read would put the database in the hot
 * path. The cost is the delay before a narrowing or a revoke bites.
 */
const CACHE_TTL_MS = 30_000;

/** A token minted before epochs existed carries no claim and reads as 0. */
export const DEFAULT_EPOCH = 0;

export type ScopePolicy = {
  epoch: number;
  /** Ceiling for the whole organization, or null for no ceiling. */
  orgMaxScope: string | null;
  /** Ceiling for this person in this organization, or null. */
  memberMaxScope: string | null;
};

const EMPTY: ScopePolicy = {
  epoch: DEFAULT_EPOCH,
  memberMaxScope: null,
  orgMaxScope: null,
};

const cache = new Map<string, { policy: ScopePolicy; readAt: number }>();

function key(userId: string, organizationId: string): string {
  return `${userId}:${organizationId}`;
}

export function forgetScopePolicy(
  userId: string,
  organizationId: string
): void {
  cache.delete(key(userId, organizationId));
}

/** Drops every cached policy. Used when a ceiling changes for a whole org. */
export function forgetAllScopePolicies(): void {
  cache.clear();
}

async function readPolicy(
  userId: string,
  organizationId: string
): Promise<ScopePolicy> {
  const [epochRow] = await db
    .select({ epoch: mcpScopeEpochs.epoch })
    .from(mcpScopeEpochs)
    .where(
      and(
        eq(mcpScopeEpochs.userId, userId),
        eq(mcpScopeEpochs.organizationId, organizationId)
      )
    )
    .limit(1);

  const [ceilings] = await db
    .select({
      memberMaxScope: member.mcpMaxScope,
      orgMaxScope: organization.mcpMaxScope,
    })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(
      and(eq(member.userId, userId), eq(member.organizationId, organizationId))
    )
    .limit(1);

  return {
    epoch: epochRow?.epoch ?? DEFAULT_EPOCH,
    memberMaxScope: ceilings?.memberMaxScope ?? null,
    orgMaxScope: ceilings?.orgMaxScope ?? null,
  };
}

/** The policy to judge an incoming token against. Cached. */
export async function getScopePolicy(
  userId: string,
  organizationId: string
): Promise<ScopePolicy> {
  const cached = cache.get(key(userId, organizationId));
  if (cached && Date.now() - cached.readAt < CACHE_TTL_MS) {
    return cached.policy;
  }
  const policy = await readPolicy(userId, organizationId);
  cache.set(key(userId, organizationId), { policy, readAt: Date.now() });
  return policy;
}

/**
 * The policy to stamp a token being minted against. Never cached.
 *
 * The cache is per process, so a change on one instance is invisible to the
 * others until their copy ages out. Minting against a stale epoch produces a
 * token that is already invalid: the client is refused, refreshes, and is
 * handed another dead token, which is a loop rather than a delay.
 */
export async function getScopePolicyForMint(
  userId: string,
  organizationId: string
): Promise<ScopePolicy> {
  const policy = await readPolicy(userId, organizationId);
  cache.set(key(userId, organizationId), { policy, readAt: Date.now() });
  return policy;
}

/**
 * Retires every access token this person holds in this organization.
 *
 * Called whenever what they may do changes: a revoke, a ceiling, a scope edit.
 * Tokens already handed out cannot be recalled, so moving the epoch past them
 * is what takes the access away before they would have expired.
 */
export async function bumpScopeEpoch(
  userId: string,
  organizationId: string
): Promise<number> {
  const [row] = await db
    .insert(mcpScopeEpochs)
    .values({ userId, organizationId, epoch: DEFAULT_EPOCH + 1 })
    .onConflictDoUpdate({
      target: [mcpScopeEpochs.userId, mcpScopeEpochs.organizationId],
      set: {
        epoch: sql`${mcpScopeEpochs.epoch} + 1`,
        updatedAt: new Date(),
      },
    })
    .returning({ epoch: mcpScopeEpochs.epoch });

  // Visible to this process at once; other instances pick it up as their own
  // cached copies age out.
  forgetScopePolicy(userId, organizationId);
  return row?.epoch ?? DEFAULT_EPOCH + 1;
}

/** The lower of the two ceilings, which is the one that binds. */
export function policyCeiling(policy: ScopePolicy): string | null {
  const { orgMaxScope, memberMaxScope } = policy;
  if (!orgMaxScope) {
    return memberMaxScope;
  }
  if (!memberMaxScope) {
    return orgMaxScope;
  }
  return highestScopeRank(memberMaxScope) <= highestScopeRank(orgMaxScope)
    ? memberMaxScope
    : orgMaxScope;
}

/**
 * What a token may actually do right now.
 *
 * The scope inside a token is what was granted when it was minted, which is the
 * person's own choice at consent. The ceilings are the organization's, so they
 * are applied on every call rather than trusted to have been baked in: a token
 * can outlive a narrowing by up to its full hour, and a person could otherwise
 * reconnect to mint themselves a wider one.
 */
export function effectiveScope(
  tokenScope: string,
  policy: ScopePolicy
): string {
  return clampScope(tokenScope, policyCeiling(policy));
}

export { EMPTY as EMPTY_SCOPE_POLICY };
