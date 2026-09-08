-- MCP connection tracking and scope management.

-- Ceiling on what any MCP connection in an organization may hold. NULL means
-- no ceiling, so organizations that predate the setting are unaffected.
ALTER TABLE "organization" ADD COLUMN IF NOT EXISTS "mcp_max_scope" text;

-- When a connection was last used, so the list can tell a working agent from
-- one that has been idle for a month.
ALTER TABLE "mcp_oauth_refresh_tokens" ADD COLUMN IF NOT EXISTS "last_used_at" timestamp;

-- Refreshing rotates the row, so created_at tracks the current token rather
-- than the connection. This carries the original consent time across
-- rotations; existing rows take their created_at as the best available answer.
ALTER TABLE "mcp_oauth_refresh_tokens" ADD COLUMN IF NOT EXISTS "connected_at" timestamp;
UPDATE "mcp_oauth_refresh_tokens" SET "connected_at" = "created_at" WHERE "connected_at" IS NULL;

-- The connections list is read per organization.
CREATE INDEX IF NOT EXISTS "idx_mcp_refresh_tokens_org" ON "mcp_oauth_refresh_tokens" ("organization_id");

-- Invalidation counter for the stateless access tokens a person holds in one
-- organization. Signed into each token and compared on every call, so bumping
-- it retires tokens that would otherwise stay valid for their full hour.
CREATE TABLE IF NOT EXISTS "mcp_scope_epochs" (
  "user_id" text NOT NULL,
  "organization_id" text NOT NULL,
  "epoch" integer NOT NULL DEFAULT 0,
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "mcp_scope_epochs_pk" PRIMARY KEY ("user_id", "organization_id")
);

-- Every connection that already exists starts at epoch 0, which is also what a
-- token minted before this migration is treated as carrying. Tokens in flight
-- keep working until something is actually revoked or narrowed.
INSERT INTO "mcp_scope_epochs" ("user_id", "organization_id", "epoch")
SELECT DISTINCT "user_id", "organization_id", 0 FROM "mcp_oauth_refresh_tokens"
ON CONFLICT DO NOTHING;
