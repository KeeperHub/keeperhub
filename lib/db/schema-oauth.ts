import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { generateId } from "../utils/id";

export const mcpOauthAuthCodes = pgTable("mcp_oauth_auth_codes", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => generateId()),
  code: text("code").notNull().unique(),
  clientId: text("client_id").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  scope: text("scope").notNull(),
  userId: text("user_id").notNull(),
  organizationId: text("organization_id").notNull(),
  codeChallenge: text("code_challenge").notNull(),
  codeChallengeMethod: text("code_challenge_method").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type McpOauthAuthCode = typeof mcpOauthAuthCodes.$inferSelect;
export type NewMcpOauthAuthCode = typeof mcpOauthAuthCodes.$inferInsert;

export const mcpOauthClients = pgTable("mcp_oauth_clients", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => generateId()),
  clientId: text("client_id").notNull().unique(),
  clientSecretHash: text("client_secret_hash").notNull(),
  // RFC 7591 token_endpoint_auth_method the client registered with. "none"
  // means a public PKCE client (no usable secret); any other value is a
  // confidential client whose client_secret is verified on token grants.
  // Existing rows predate this column and default to "none" so they keep
  // working without secret verification.
  tokenEndpointAuthMethod: text("token_endpoint_auth_method")
    .notNull()
    .default("none"),
  clientName: text("client_name").notNull(),
  redirectUris: jsonb("redirect_uris").notNull().$type<string[]>(),
  scopes: jsonb("scopes").notNull().$type<string[]>(),
  grantTypes: jsonb("grant_types").notNull().$type<string[]>(),
  organizationId: text("organization_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type McpOauthClient = typeof mcpOauthClients.$inferSelect;
export type NewMcpOauthClient = typeof mcpOauthClients.$inferInsert;

export const mcpOauthRefreshTokens = pgTable(
  "mcp_oauth_refresh_tokens",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    tokenHash: text("token_hash").notNull().unique(),
    clientId: text("client_id").notNull(),
    userId: text("user_id").notNull(),
    organizationId: text("organization_id").notNull(),
    scope: text("scope").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    // When this connection last proved itself, so the list can say whether an
    // agent is still working or has been idle for a month. Written at most
    // once a minute per row, never once per call.
    lastUsedAt: timestamp("last_used_at"),
    // When the person first consented. Refreshing rotates the row, so
    // createdAt is the age of the current token rather than of the
    // connection; this is carried forward across rotations.
    connectedAt: timestamp("connected_at"),
  },
  (table) => [
    index("idx_mcp_refresh_tokens_client").on(table.clientId),
    index("idx_mcp_refresh_tokens_user").on(table.userId),
    index("idx_mcp_refresh_tokens_org").on(table.organizationId),
  ]
);

export type McpOauthRefreshToken = typeof mcpOauthRefreshTokens.$inferSelect;
export type NewMcpOauthRefreshToken = typeof mcpOauthRefreshTokens.$inferInsert;

/**
 * Invalidation counter for the stateless access tokens a person holds in one
 * organization.
 *
 * Access tokens are self-contained JWTs carrying their own scope, so nothing
 * about them can be taken back once minted. The epoch is signed into the token
 * and compared on every call: bumping it here retires every token already out
 * there, which is what makes revoking and narrowing a scope mean anything
 * before the token would have expired on its own.
 */
export const mcpScopeEpochs = pgTable(
  "mcp_scope_epochs",
  {
    userId: text("user_id").notNull(),
    organizationId: text("organization_id").notNull(),
    epoch: integer("epoch").notNull().default(0),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.organizationId] })]
);

export type McpScopeEpoch = typeof mcpScopeEpochs.$inferSelect;
