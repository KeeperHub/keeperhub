-- Device code table for Better Auth device authorization plugin (CLI auth flow)
CREATE TABLE IF NOT EXISTS "device_code" (
	"id" text PRIMARY KEY NOT NULL,
	"device_code" text NOT NULL,
	"user_code" text NOT NULL,
	"user_id" text,
	"expires_at" timestamp NOT NULL,
	"status" text NOT NULL,
	"last_polled_at" timestamp,
	"polling_interval" integer,
	"client_id" text,
	"scope" text,
	"created_at" timestamp,
	"updated_at" timestamp
);
--> statement-breakpoint
-- Billing tables (previously added via db:push, included here for fresh DB compatibility)
CREATE TABLE IF NOT EXISTS "billing_events" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_event_id" text NOT NULL,
	"type" text NOT NULL,
	"data" jsonb,
	"processed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "billing_events_provider_event_id_unique" UNIQUE("provider_event_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "execution_debt" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"overage_record_id" text NOT NULL,
	"provider_invoice_id" text,
	"debt_executions" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"enforced_at" timestamp NOT NULL,
	"cleared_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "execution_debt_overage_record_id_unique" UNIQUE("overage_record_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "organization_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"provider_customer_id" text,
	"provider_subscription_id" text,
	"provider_price_id" text,
	"plan" text DEFAULT 'free' NOT NULL,
	"tier" text,
	"status" text DEFAULT 'active' NOT NULL,
	"current_period_start" timestamp,
	"current_period_end" timestamp,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"billing_alert" text,
	"billing_alert_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "organization_subscriptions_organization_id_unique" UNIQUE("organization_id"),
	CONSTRAINT "organization_subscriptions_provider_customer_id_unique" UNIQUE("provider_customer_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "overage_billing_records" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"period_start" timestamp NOT NULL,
	"period_end" timestamp NOT NULL,
	"execution_limit" integer NOT NULL,
	"total_executions" integer NOT NULL,
	"overage_count" integer NOT NULL,
	"overage_rate_cents" integer NOT NULL,
	"total_charge_cents" integer NOT NULL,
	"provider_invoice_item_id" text,
	"provider_invoice_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "overage_billing_org_period" UNIQUE("organization_id","period_start","period_end")
);
--> statement-breakpoint
-- Duration column type changes (previously applied via db:push)
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'workflow_execution_logs' AND column_name = 'duration' AND data_type = 'text'
  ) THEN
    ALTER TABLE "workflow_execution_logs" ALTER COLUMN "duration" SET DATA TYPE numeric USING "duration"::numeric;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'workflow_executions' AND column_name = 'duration' AND data_type = 'text'
  ) THEN
    ALTER TABLE "workflow_executions" ALTER COLUMN "duration" SET DATA TYPE numeric USING "duration"::numeric;
  END IF;
END $$;
--> statement-breakpoint
-- Foreign keys (using DO blocks for idempotency)
DO $$ BEGIN
  ALTER TABLE "device_code" ADD CONSTRAINT "device_code_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "execution_debt" ADD CONSTRAINT "execution_debt_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "execution_debt" ADD CONSTRAINT "execution_debt_overage_record_id_overage_billing_records_id_fk" FOREIGN KEY ("overage_record_id") REFERENCES "public"."overage_billing_records"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "organization_subscriptions" ADD CONSTRAINT "organization_subscriptions_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "overage_billing_records" ADD CONSTRAINT "overage_billing_records_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_execution_debt_org_status" ON "execution_debt" USING btree ("organization_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_execution_debt_invoice" ON "execution_debt" USING btree ("provider_invoice_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_org_subscriptions_org" ON "organization_subscriptions" USING btree ("organization_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_org_subscriptions_provider_sub" ON "organization_subscriptions" USING btree ("provider_subscription_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_overage_billing_org" ON "overage_billing_records" USING btree ("organization_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_overage_billing_status" ON "overage_billing_records" USING btree ("status");
