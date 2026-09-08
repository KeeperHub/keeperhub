import { createHash } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  mcpOauthAuthCodes,
  mcpOauthClients,
  mcpOauthRefreshTokens,
} from "@/lib/db/schema";

const AUTH_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type AuthorizationCode = {
  code: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  userId: string;
  organizationId: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  expiresAt: number;
};

export type RefreshTokenEntry = {
  token: string;
  clientId: string;
  userId: string;
  organizationId: string;
  scope: string;
  expiresAt: number;
  /**
   * When the person first consented. Refreshing rotates the row, so this is
   * carried across rotations to keep the connection's age truthful; absent
   * only on the first issue, where the row's own creation time is it.
   */
  connectedAt?: number;
};

export type OAuthClient = {
  clientId: string;
  clientSecretHash: string;
  tokenEndpointAuthMethod: string;
  clientName: string;
  redirectUris: string[];
  scopes: string[];
  grantTypes: string[];
  organizationId: string | null;
  createdAt: number;
};

export async function storeAuthCode(entry: AuthorizationCode): Promise<void> {
  await db.insert(mcpOauthAuthCodes).values({
    code: hashToken(entry.code),
    clientId: entry.clientId,
    redirectUri: entry.redirectUri,
    scope: entry.scope,
    userId: entry.userId,
    organizationId: entry.organizationId,
    codeChallenge: entry.codeChallenge,
    codeChallengeMethod: entry.codeChallengeMethod,
    expiresAt: new Date(entry.expiresAt),
  });
}

export async function getAuthCode(
  code: string
): Promise<AuthorizationCode | undefined> {
  const codeHash = hashToken(code);
  const rows = await db
    .select()
    .from(mcpOauthAuthCodes)
    .where(eq(mcpOauthAuthCodes.code, codeHash))
    .limit(1);

  const row = rows[0];
  if (!row) {
    return undefined;
  }

  if (Date.now() > row.expiresAt.getTime()) {
    await db
      .delete(mcpOauthAuthCodes)
      .where(eq(mcpOauthAuthCodes.code, codeHash));
    return undefined;
  }

  return {
    code,
    clientId: row.clientId,
    redirectUri: row.redirectUri,
    scope: row.scope,
    userId: row.userId,
    organizationId: row.organizationId,
    codeChallenge: row.codeChallenge,
    codeChallengeMethod: row.codeChallengeMethod,
    expiresAt: row.expiresAt.getTime(),
  };
}

export async function deleteAuthCode(code: string): Promise<void> {
  await db
    .delete(mcpOauthAuthCodes)
    .where(eq(mcpOauthAuthCodes.code, hashToken(code)));
}

export async function cleanupExpiredAuthCodes(): Promise<void> {
  await db
    .delete(mcpOauthAuthCodes)
    .where(lt(mcpOauthAuthCodes.expiresAt, new Date()));
}

export async function storeOAuthClient(client: OAuthClient): Promise<void> {
  await db.insert(mcpOauthClients).values({
    clientId: client.clientId,
    clientSecretHash: client.clientSecretHash,
    tokenEndpointAuthMethod: client.tokenEndpointAuthMethod,
    clientName: client.clientName,
    redirectUris: client.redirectUris,
    scopes: client.scopes,
    grantTypes: client.grantTypes,
    organizationId: client.organizationId,
  });
}

export async function getOAuthClient(
  clientId: string
): Promise<OAuthClient | undefined> {
  const rows = await db
    .select()
    .from(mcpOauthClients)
    .where(eq(mcpOauthClients.clientId, clientId))
    .limit(1);

  const row = rows[0];
  if (!row) {
    return undefined;
  }

  return {
    clientId: row.clientId,
    clientSecretHash: row.clientSecretHash,
    tokenEndpointAuthMethod: row.tokenEndpointAuthMethod,
    clientName: row.clientName,
    redirectUris: row.redirectUris,
    scopes: row.scopes,
    grantTypes: row.grantTypes,
    organizationId: row.organizationId ?? null,
    createdAt: row.createdAt.getTime(),
  };
}

export async function storeRefreshToken(
  entry: RefreshTokenEntry
): Promise<void> {
  const tokenHash = hashToken(entry.token);
  await db.insert(mcpOauthRefreshTokens).values({
    tokenHash,
    clientId: entry.clientId,
    userId: entry.userId,
    organizationId: entry.organizationId,
    scope: entry.scope,
    expiresAt: new Date(entry.expiresAt),
    connectedAt: entry.connectedAt ? new Date(entry.connectedAt) : new Date(),
  });
}

export async function getRefreshToken(
  token: string
): Promise<RefreshTokenEntry | undefined> {
  const tokenHash = hashToken(token);
  const rows = await db
    .select()
    .from(mcpOauthRefreshTokens)
    .where(eq(mcpOauthRefreshTokens.tokenHash, tokenHash))
    .limit(1);

  const row = rows[0];
  if (!row) {
    return undefined;
  }

  if (Date.now() > row.expiresAt.getTime()) {
    await db
      .delete(mcpOauthRefreshTokens)
      .where(eq(mcpOauthRefreshTokens.tokenHash, tokenHash));
    return undefined;
  }

  return {
    token,
    clientId: row.clientId,
    userId: row.userId,
    organizationId: row.organizationId,
    scope: row.scope,
    expiresAt: row.expiresAt.getTime(),
    connectedAt: (row.connectedAt ?? row.createdAt).getTime(),
  };
}

export async function deleteRefreshToken(token: string): Promise<void> {
  const tokenHash = hashToken(token);
  await db
    .delete(mcpOauthRefreshTokens)
    .where(eq(mcpOauthRefreshTokens.tokenHash, tokenHash));
}

/**
 * Revoke every MCP OAuth refresh token a user holds for a given organization.
 * Used when a user leaves or is removed from an org so their renewable 30-day
 * credential cannot be cycled into fresh org-scoped access once membership ends.
 */
export async function revokeRefreshTokensForUserOrg(
  userId: string,
  organizationId: string
): Promise<void> {
  await db
    .delete(mcpOauthRefreshTokens)
    .where(
      and(
        eq(mcpOauthRefreshTokens.userId, userId),
        eq(mcpOauthRefreshTokens.organizationId, organizationId)
      )
    );
}

export { AUTH_CODE_TTL_MS, REFRESH_TOKEN_TTL_MS };
