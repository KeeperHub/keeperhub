ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "onboarding_completed" boolean DEFAULT false NOT NULL;
