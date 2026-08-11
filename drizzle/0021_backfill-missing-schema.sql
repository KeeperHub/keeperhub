-- Backfill schema items that were applied via db:push but never had migration SQL.
-- Uses IF NOT EXISTS / DO blocks so this is safe on environments where they already exist.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'api_keys') THEN
    CREATE TABLE "api_keys" (
      "id" text PRIMARY KEY NOT NULL,
      "user_id" text NOT NULL,
      "name" text,
      "key_hash" text NOT NULL,
      "key_prefix" text NOT NULL,
      "created_at" timestamp DEFAULT now() NOT NULL,
      "last_used_at" timestamp
    );
    ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN IF NOT EXISTS "visibility" text DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN IF NOT EXISTS "featured" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN IF NOT EXISTS "featured_order" integer DEFAULT 0;