-- Owner-set org switch requiring members to carry a second factor while this
-- org is their active context. Bites for wallet (SIWE) members, who are
-- otherwise MFA-exempt. enforced_mfa_factors lists which factors satisfy the
-- requirement (e.g. ["totp"], ["email"], or both); null means no extra gate.
ALTER TABLE "organization" ADD COLUMN "enforce_mfa" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "enforced_mfa_factors" jsonb;
