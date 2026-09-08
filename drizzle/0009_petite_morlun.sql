CREATE TABLE "organization_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"chain_id" integer NOT NULL,
	"token_address" text NOT NULL,
	"symbol" text NOT NULL,
	"name" text NOT NULL,
	"decimals" integer NOT NULL,
	"logo_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_tokens" ADD CONSTRAINT "organization_tokens_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_org_tokens_org_chain" ON "organization_tokens" USING btree ("organization_id","chain_id");