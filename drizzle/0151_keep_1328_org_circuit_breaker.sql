ALTER TABLE "organization" ADD COLUMN "halted_at" timestamp;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "halted_reason" text;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "halted_by" text;