CREATE TABLE "disbursement_legs" (
	"organization_id" text NOT NULL,
	"run_key" text NOT NULL,
	"leg_index" integer NOT NULL,
	"chain_id" integer NOT NULL,
	"asset" text NOT NULL,
	"recipient" text NOT NULL,
	"amount" text NOT NULL,
	"status" text NOT NULL,
	"claim_token" text,
	"claimed_at" timestamp DEFAULT now() NOT NULL,
	"execution_id" text,
	"node_id" text,
	"transaction_hash" text,
	"send_transaction_status_id" text,
	"last_error" text,
	"settled_at" timestamp,
	"resolved_by" text,
	"resolution_note" text,
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "disbursement_legs_pk" PRIMARY KEY("organization_id","run_key","leg_index"),
	CONSTRAINT "disbursement_legs_status_check" CHECK ("disbursement_legs"."status" IN ('claimed', 'sending', 'settled', 'failed', 'unknown')),
	CONSTRAINT "disbursement_legs_leg_index_check" CHECK ("disbursement_legs"."leg_index" >= 0)
);
--> statement-breakpoint
ALTER TABLE "disbursement_legs" ADD CONSTRAINT "disbursement_legs_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disbursement_legs" ADD CONSTRAINT "disbursement_legs_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;