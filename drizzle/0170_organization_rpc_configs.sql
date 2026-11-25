CREATE TABLE "organization_rpc_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"chain_id" integer NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"encrypted_urls" text NOT NULL,
	"masked_urls" jsonb NOT NULL,
	"verification" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_rpc_policy" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"own_rpc_only" boolean DEFAULT false NOT NULL,
	"changed_by" text,
	"changed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_rpc_usage_hourly" (
	"organization_id" text NOT NULL,
	"config_id" text,
	"origin" text NOT NULL,
	"chain_id" integer NOT NULL,
	"transport" text NOT NULL,
	"hour" timestamp NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"errors" integer DEFAULT 0 NOT NULL,
	"timeouts" integer DEFAULT 0 NOT NULL,
	"rate_limited" integer DEFAULT 0 NOT NULL,
	"failovers" integer DEFAULT 0 NOT NULL,
	"latency_ms_sum" bigint DEFAULT 0 NOT NULL,
	"latency_ms_max" integer DEFAULT 0 NOT NULL,
	"ws_connects" integer DEFAULT 0 NOT NULL,
	"ws_reconnects" integer DEFAULT 0 NOT NULL,
	"events_received" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "uq_org_rpc_usage_bucket" UNIQUE NULLS NOT DISTINCT("organization_id","config_id","origin","chain_id","transport","hour")
);
--> statement-breakpoint
ALTER TABLE "organization_rpc_configs" ADD CONSTRAINT "organization_rpc_configs_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "organization_rpc_policy" ADD CONSTRAINT "organization_rpc_policy_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "organization_rpc_usage_hourly" ADD CONSTRAINT "organization_rpc_usage_hourly_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_org_rpc_configs_default" ON "organization_rpc_configs" USING btree ("organization_id","chain_id") WHERE "organization_rpc_configs"."is_default";
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_org_rpc_configs_name" ON "organization_rpc_configs" USING btree ("organization_id","chain_id","name");
--> statement-breakpoint
CREATE INDEX "idx_org_rpc_configs_org_chain" ON "organization_rpc_configs" USING btree ("organization_id","chain_id");
--> statement-breakpoint
CREATE INDEX "idx_org_rpc_usage_org_hour" ON "organization_rpc_usage_hourly" USING btree ("organization_id","hour");
