-- Defense-in-depth backstop for the deactivated-user auth bypass.
--
-- The app-layer gate (lib/auth-deactivation-guard.ts -> better-auth
-- session.create.before / account.create.before) already aborts session
-- creation when the owning user has deactivated_at set. This trigger is the
-- last line of defense at the DB layer: it rejects ANY insert into sessions
-- whose owning user is deactivated, including paths that bypass the app gate
-- (future OAuth providers, direct db.insert(sessions) call sites, or a
-- regression in the hooks).
--
-- Complements the cascade trigger from 0085_cascade_user_deactivation.sql:
-- that deletes existing sessions when a user is deactivated; this prevents
-- new ones from being minted afterwards.
--
-- Limitation: this is a backstop, not an airtight guarantee. The check reads
-- the committed deactivated_at under READ COMMITTED, so a session insert that
-- races a not-yet-committed deactivation (landing after 0085's cascade DELETE
-- but before the deactivating transaction commits) can still succeed. The
-- app-layer gate is the primary control; this closes the common case.
--
-- Detection signal contract (consumed by the future detection layer):
--   SQLSTATE 'KH001'
--   MESSAGE  'Session owner is deactivated; new sessions are not allowed.'
-- A dedicated custom SQLSTATE (not the 42501 the incident triggers reuse) so a
-- deactivated-session rejection is unambiguously identifiable by error code
-- alone, without parsing the message text.

CREATE OR REPLACE FUNCTION public.block_sessions_for_deactivated_users()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_owner_deactivated_at timestamp;
BEGIN
  SELECT u.deactivated_at
    INTO v_owner_deactivated_at
  FROM public.users u
  WHERE u.id = NEW.user_id;

  IF v_owner_deactivated_at IS NOT NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'Session owner is deactivated; new sessions are not allowed.',
      ERRCODE = 'KH001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS block_sessions_for_deactivated_users ON sessions;

CREATE TRIGGER block_sessions_for_deactivated_users
  BEFORE INSERT ON sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.block_sessions_for_deactivated_users();
