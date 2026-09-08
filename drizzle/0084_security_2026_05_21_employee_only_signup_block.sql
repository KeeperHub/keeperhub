-- Security incident 2026-05-21 follow-up: codify the user-signup lockout that
-- was applied directly to prod during incident response.
--
-- The trigger refuses any INSERT on users whose email does not match the
-- employee allowlist (techops.services or keeperhub.com). It was installed live
-- to prevent attacker-controlled accounts from being recreated while
-- containment work was still in flight, and remains active today.
--
-- This migration brings the migration history into sync with prod. The trigger
-- and function already exist on the prod DB; the IF EXISTS / OR REPLACE guards
-- make this a no-op there, but reinstate the same protection in any fresh DB
-- built from migrations (CI, ephemeral envs, dev resets, disaster recovery).
--
-- Only INSERT is gated. Existing user rows are unaffected; UPDATE and DELETE
-- of existing users continue to work for routine maintenance.
--
-- Disposition: this is a codification step only. The lockout currently blocks
-- all real customer signups. A separate migration is needed to either retire
-- this trigger once app-layer signup gating is verified, or convert it to a
-- non-blocking audit signal.

CREATE OR REPLACE FUNCTION public.block_user_signup_security_2026_05_21()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.email !~* '@(techops\.services|keeperhub\.com)$' THEN
    RAISE EXCEPTION USING
      MESSAGE = 'Signup paused (security incident 2026-05-21). Contact security team.',
      ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS block_user_signup_security_2026_05_21 ON users;

CREATE TRIGGER block_user_signup_security_2026_05_21
  BEFORE INSERT ON users
  FOR EACH ROW
  EXECUTE FUNCTION public.block_user_signup_security_2026_05_21();
