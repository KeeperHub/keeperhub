-- Cascade revocation of user-scoped credentials when users.deactivated_at
-- is set. Fires only on the NULL -> non-NULL transition so reactivating
-- (deactivated_at -> NULL) is a no-op cascade-wise.
--
-- Covers every mutation path that can set the column (raw SQL, the
-- /api/user/delete endpoint, admin tooling, Drizzle Studio). Per-auth-path
-- gates in lib/api-key-auth.ts and lib/mcp/oauth-auth.ts already reject
-- API key and MCP token usage when users.deactivated_at IS NOT NULL; this
-- trigger plus the better-auth session.create.before hook in lib/auth.ts
-- close the equivalent gap for browser session cookies, which Better
-- Auth's getSession does not re-check on each request.
--
-- accounts rows are intentionally left intact so a later reactivation
-- retains the user's OAuth provider links. New session / account writes
-- after deactivation are blocked by the hooks in lib/auth.ts, so a
-- preserved accounts row is not exploitable on its own.

CREATE OR REPLACE FUNCTION public.cascade_user_deactivation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM sessions                 WHERE user_id = NEW.id;
  DELETE FROM api_keys                 WHERE user_id = NEW.id;
  DELETE FROM mcp_oauth_refresh_tokens WHERE user_id = NEW.id;
  DELETE FROM mcp_oauth_auth_codes     WHERE user_id = NEW.id;
  DELETE FROM device_code              WHERE user_id = NEW.id;

  UPDATE organization_api_keys
     SET revoked_at = NEW.deactivated_at
   WHERE created_by = NEW.id
     AND revoked_at IS NULL;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS cascade_user_deactivation ON users;

CREATE TRIGGER cascade_user_deactivation
  AFTER UPDATE OF deactivated_at ON users
  FOR EACH ROW
  WHEN (NEW.deactivated_at IS NOT NULL AND OLD.deactivated_at IS NULL)
  EXECUTE FUNCTION public.cascade_user_deactivation();
