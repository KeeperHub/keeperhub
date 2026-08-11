ALTER TABLE "mcp_oauth_clients" ADD COLUMN IF NOT EXISTS "token_endpoint_auth_method" text NOT NULL DEFAULT 'none';
