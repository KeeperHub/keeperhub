CREATE TABLE "event_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"event_type" text NOT NULL,
	"execution_id" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"dispatched_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "event_outbox" ADD CONSTRAINT "event_outbox_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_event_outbox_dedupe_key" ON "event_outbox" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "idx_event_outbox_undispatched" ON "event_outbox" USING btree ("created_at") WHERE "event_outbox"."dispatched_at" IS NULL;