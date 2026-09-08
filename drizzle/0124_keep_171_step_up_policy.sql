-- Wallet-only per-action step-up policy. Maps a sensitive action to the extra
-- factors a wallet user opted into (e.g. {"wallet_withdraw":["totp"]}). Null
-- means defaults apply (wallet signature only). Email/TOTP users always use
-- dual-factor and ignore this column.
ALTER TABLE "users" ADD COLUMN "step_up_policy" jsonb;
--> statement-breakpoint
-- Verified step-up email a wallet user added for email-OTP (written only after
-- code verification; distinct from the synthetic SIWE login email).
ALTER TABLE "users" ADD COLUMN "step_up_email" text;
