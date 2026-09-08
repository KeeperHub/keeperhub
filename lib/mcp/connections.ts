import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { member, organization, users } from "@/lib/db/schema";
import { mcpOauthClients, mcpOauthRefreshTokens } from "@/lib/db/schema-oauth";
import {
  type OAuthScope,
  SUPPORTED_SCOPES,
  scopeExceeds,
} from "@/lib/mcp/oauth-scopes";

/** One client a person connected to one organization. */
export type McpConnection = {
  /** Stable across token rotation: see connectionId. */
  id: string;
  clientId: string;
  clientName: string;
  userId: string;
  userName: string;
  userEmail: string;
  scope: string;
  connectedAt: Date;
  expiresAt: Date;
  lastUsedAt: Date | null;
};

/**
 * A connection is a client plus the person who consented, not a token row.
 * Refreshing rotates the row and mints a new primary key, so a row id handed
 * to the browser stops resolving the moment the agent refreshes. This pair
 * survives that.
 */
export function connectionId(clientId: string, userId: string): string {
  return `${clientId}::${userId}`;
}

function parseConnectionId(
  id: string
): { clientId: string; userId: string } | null {
  const at = id.lastIndexOf("::");
  if (at <= 0) {
    return null;
  }
  return { clientId: id.slice(0, at), userId: id.slice(at + 2) };
}

export function isSupportedScope(value: unknown): value is OAuthScope {
  return (
    typeof value === "string" &&
    (SUPPORTED_SCOPES as readonly string[]).includes(value)
  );
}

/**
 * True when `scope` grants more than `ceiling` allows. Ranking lives with the
 * scopes themselves, so a scope set is measured the same way here as it is
 * where access is decided.
 */
export function exceedsCeiling(scope: string, ceiling: string | null): boolean {
  return scopeExceeds(scope, ceiling);
}

/**
 * Connections in an organization. A member is shown only what they connected;
 * passing no userId returns everything, which is for admins and owners.
 */
export async function listConnections(
  organizationId: string,
  userId?: string
): Promise<McpConnection[]> {
  const rows = await db
    .select({
      clientId: mcpOauthRefreshTokens.clientId,
      clientName: mcpOauthClients.clientName,
      connectedAt: mcpOauthRefreshTokens.connectedAt,
      createdAt: mcpOauthRefreshTokens.createdAt,
      expiresAt: mcpOauthRefreshTokens.expiresAt,
      lastUsedAt: mcpOauthRefreshTokens.lastUsedAt,
      scope: mcpOauthRefreshTokens.scope,
      userEmail: users.email,
      userId: mcpOauthRefreshTokens.userId,
      userName: users.name,
    })
    .from(mcpOauthRefreshTokens)
    .leftJoin(
      mcpOauthClients,
      eq(mcpOauthClients.clientId, mcpOauthRefreshTokens.clientId)
    )
    .leftJoin(users, eq(users.id, mcpOauthRefreshTokens.userId))
    .where(
      userId
        ? and(
            eq(mcpOauthRefreshTokens.organizationId, organizationId),
            eq(mcpOauthRefreshTokens.userId, userId)
          )
        : eq(mcpOauthRefreshTokens.organizationId, organizationId)
    )
    .orderBy(desc(mcpOauthRefreshTokens.createdAt));

  // Rotation can briefly leave more than one row for the same pair; the newest
  // is the connection and the rest are its history.
  const seen = new Set<string>();
  const connections: McpConnection[] = [];
  for (const row of rows) {
    const id = connectionId(row.clientId, row.userId);
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    connections.push({
      clientId: row.clientId,
      clientName: row.clientName ?? "Unknown client",
      connectedAt: row.connectedAt ?? row.createdAt,
      expiresAt: row.expiresAt,
      id,
      lastUsedAt: row.lastUsedAt,
      scope: row.scope,
      userEmail: row.userEmail ?? "",
      userId: row.userId,
      userName: row.userName ?? "",
    });
  }
  return connections;
}

/** One connection, scoped to its organization so an id alone cannot reach across. */
export async function getConnection(
  id: string,
  organizationId: string
): Promise<McpConnection | null> {
  const parsed = parseConnectionId(id);
  if (!parsed) {
    return null;
  }
  const rows = await listConnections(organizationId, parsed.userId);
  return rows.find((row) => row.id === id) ?? null;
}

/**
 * Caps what a person's agents may do in an organization.
 *
 * Set on the membership, not on the connection. Every `mcp add` registers a new
 * OAuth client, so a cap held against a connection is shed by reconnecting;
 * the membership survives both re-consent and re-registration.
 *
 * The sessions' own scopes are left alone. What a session was granted at
 * consent is a fact about what happened, and overwriting it would lose that
 * while telling the list something untrue. The cap is applied on every call
 * instead, so what an agent can actually do is the narrower of the two without
 * either record being falsified.
 */
export async function setMemberScopeCeiling(
  userId: string,
  organizationId: string,
  scope: OAuthScope
): Promise<void> {
  await db
    .update(member)
    .set({ mcpMaxScope: scope })
    .where(
      and(eq(member.userId, userId), eq(member.organizationId, organizationId))
    );
}

export type OrgMemberRow = {
  userId: string;
  userName: string;
  userEmail: string;
  role: string;
  maxScope: string | null;
};

/**
 * Everyone in the organization, whether or not they have ever connected an
 * agent. An admin has to be able to set someone's limit before that person
 * connects anything, so the list cannot be built from the sessions alone.
 */
export async function listOrgMembers(
  organizationId: string
): Promise<OrgMemberRow[]> {
  const rows = await db
    .select({
      maxScope: member.mcpMaxScope,
      role: member.role,
      userEmail: users.email,
      userId: member.userId,
      userName: users.name,
    })
    .from(member)
    .leftJoin(users, eq(users.id, member.userId))
    .where(eq(member.organizationId, organizationId));

  return rows.map((row) => ({
    maxScope: row.maxScope,
    role: row.role,
    userEmail: row.userEmail ?? "",
    userId: row.userId,
    userName: row.userName ?? "",
  }));
}

export async function getMemberScopeCeiling(
  userId: string,
  organizationId: string
): Promise<string | null> {
  const [row] = await db
    .select({ mcpMaxScope: member.mcpMaxScope })
    .from(member)
    .where(
      and(eq(member.userId, userId), eq(member.organizationId, organizationId))
    )
    .limit(1);
  return row?.mcpMaxScope ?? null;
}

/**
 * Ends a session for good.
 *
 * The rows are deleted rather than flagged: a revoked session is not something
 * anyone acts on again, and keeping it would leave the list growing with dead
 * entries. What happened is not lost, because the caller writes an audit event
 * naming the client, the person and the scope before this runs, and that record
 * is append-only.
 */
export async function revokeConnection(
  id: string,
  organizationId: string
): Promise<void> {
  const parsed = parseConnectionId(id);
  if (!parsed) {
    return;
  }
  await db
    .delete(mcpOauthRefreshTokens)
    .where(
      and(
        eq(mcpOauthRefreshTokens.organizationId, organizationId),
        eq(mcpOauthRefreshTokens.clientId, parsed.clientId),
        eq(mcpOauthRefreshTokens.userId, parsed.userId)
      )
    );
}

/**
 * At most one write per connection per minute. Every MCP call passes through
 * the toucher, and "last used" only needs to be right to the minute.
 */
const TOUCH_INTERVAL_MS = 60_000;
const lastTouched = new Map<string, number>();

/**
 * Records that one connection was just used. Best effort: a failure here must
 * never turn a working call into a failed one.
 *
 * Scoped to the calling client, not to everything the person has: one person
 * can hold several connections in an organization, and marking them all used
 * because one of them called makes an idle agent look active and hides the
 * very thing the column exists to show. A token minted before the client claim
 * existed carries no clientId, and no liveness is recorded for it rather than
 * attributing its call to the wrong connection.
 */
export async function touchConnection(
  userId: string,
  organizationId: string,
  clientId: string | undefined
): Promise<void> {
  if (!clientId) {
    return;
  }
  const key = `${userId}:${organizationId}:${clientId}`;
  const now = Date.now();
  const seen = lastTouched.get(key);
  if (seen && now - seen < TOUCH_INTERVAL_MS) {
    return;
  }
  lastTouched.set(key, now);
  try {
    await db
      .update(mcpOauthRefreshTokens)
      .set({ lastUsedAt: new Date(now) })
      .where(
        and(
          eq(mcpOauthRefreshTokens.userId, userId),
          eq(mcpOauthRefreshTokens.organizationId, organizationId),
          eq(mcpOauthRefreshTokens.clientId, clientId)
        )
      );
  } catch {
    // Liveness is not worth failing a call over.
  }
}

export async function getOrgMaxScope(
  organizationId: string
): Promise<string | null> {
  const rows = await db
    .select({ mcpMaxScope: organization.mcpMaxScope })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1);
  return rows[0]?.mcpMaxScope ?? null;
}

export async function setOrgMaxScope(
  organizationId: string,
  scope: OAuthScope | null
): Promise<void> {
  await db
    .update(organization)
    .set({ mcpMaxScope: scope })
    .where(eq(organization.id, organizationId));
}

/**
 * Connections in this organization that hold more than the ceiling allows.
 * Used to narrow them when a ceiling is lowered.
 */
export async function connectionsAboveCeiling(
  organizationId: string,
  ceiling: string
): Promise<McpConnection[]> {
  const rows = await listConnections(organizationId);
  return rows.filter((row) => exceedsCeiling(row.scope, ceiling));
}
