-- Failure alerts mask a wallet member's step-up inbox by looking users up by
-- step_up_email (stepUpMasker), on every Sent alerts page and To filter. The
-- column had no index, so each lookup scanned users. Partial on
-- `step_up_email IS NOT NULL`: only wallet members with a step-up inbox have
-- one, so the index stays small. users is small, so a plain build takes
-- milliseconds (no @requires-db-prep needed).
CREATE INDEX IF NOT EXISTS "idx_users_step_up_email" ON "users" USING btree ("step_up_email") WHERE "users"."step_up_email" IS NOT NULL;
