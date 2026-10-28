-- Better Auth 1.7.3 went back to the 1.6 account model and no longer writes
-- accounts.issuer, so with the column NOT NULL every new account insert fails
-- (credential sign-up, SIWE, OAuth link). Existing values are kept.
ALTER TABLE "accounts" ALTER COLUMN "issuer" DROP NOT NULL;
