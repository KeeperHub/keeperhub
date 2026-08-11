CREATE TABLE "direct_executions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"api_key_id" text NOT NULL,
	"type" text NOT NULL,
	"input" jsonb,
	"output" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"transaction_hash" text,
	"network" text NOT NULL,
	"error" text,
	"gas_used_wei" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "organization_spend_caps" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"daily_cap_wei" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "organization_spend_caps_organization_id_unique" UNIQUE("organization_id")
);
--> statement-breakpoint
ALTER TABLE "direct_executions" ADD CONSTRAINT "direct_executions_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_spend_caps" ADD CONSTRAINT "organization_spend_caps_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_direct_executions_org" ON "direct_executions" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_direct_executions_status" ON "direct_executions" USING btree ("status");