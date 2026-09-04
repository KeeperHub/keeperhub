-- Better Auth 1.7 added a required `issuer` on the account model and now
-- matches credential sign-in on (providerId, issuer, accountId). Every row
-- written before 1.7 reads back with issuer NULL, so signInEmail treats it as
-- "User not found" and email/password sign-in fails outright.
--
-- The values below are the ones the 1.7 runtime writes, so backfilled rows and
-- newly created ones are indistinguishable:
--   credential -> createLocalAccountIssuer("credential")
--   siwe       -> createLocalAccountIssuer("siwe")
--   google     -> the provider declares accountIssuer "https://accounts.google.com"
--   otherwise  -> createOAuthAccountIssuer(providerId), i.e. "local:oauth:<id>"
--
-- Statements are ordered add / backfill / constrain so the column is never
-- NOT NULL while a row is still unpopulated. drizzle-kit runs the file in one
-- transaction, so a partial apply cannot leave the table half-migrated.
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "issuer" text;--> statement-breakpoint
UPDATE "accounts" SET "issuer" = 'local:credential' WHERE "issuer" IS NULL AND "provider_id" = 'credential';--> statement-breakpoint
UPDATE "accounts" SET "issuer" = 'local:siwe' WHERE "issuer" IS NULL AND "provider_id" = 'siwe';--> statement-breakpoint
UPDATE "accounts" SET "issuer" = 'https://accounts.google.com' WHERE "issuer" IS NULL AND "provider_id" = 'google';--> statement-breakpoint
-- Catch-all for every provider without an issuer of its own (github today).
-- Better Auth percent-encodes the provider id into this namespace; every id in
-- use is encode-identity, so plain concatenation reproduces it.
UPDATE "accounts" SET "issuer" = 'local:oauth:' || "provider_id" WHERE "issuer" IS NULL;--> statement-breakpoint
-- 1.7 also requires a credential account's accountId to equal the user id.
-- scripts/seed-load-test-users.ts wrote the email there instead, and it skips
-- any user that already exists, so re-running the seeder cannot repair the rows
-- it has already made. No application code reads accounts.account_id - only
-- better-auth does, through its own adapter - so realigning every credential
-- row is safe and makes any other off-convention row signable again.
UPDATE "accounts" SET "account_id" = "user_id" WHERE "provider_id" = 'credential' AND "account_id" <> "user_id";--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "issuer" SET NOT NULL;
