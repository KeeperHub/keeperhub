-- KEEP-696: normalize workflows.is_anonymous to false.
--
-- The flag encoded "created by a logged-out session with no org" - a state
-- that no longer exists: every account (anonymous sessions included) has an
-- organization and workflows.organization_id is NOT NULL (0100). New
-- anon-session workflows already insert is_anonymous = false because an org
-- is always present at create time. Legacy rows backfilled into orgs by 0100
-- still carry is_anonymous = true, which wrongly hides them from their own
-- org's workflow listing (the list query filters is_anonymous = false).
--
-- After this migration the flag is constant false and DEPRECATED; the column
-- drop (plus the retired claim route and its dialog) is a follow-up.

UPDATE workflows SET is_anonymous = false WHERE is_anonymous = true;
