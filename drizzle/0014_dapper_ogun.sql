CREATE TABLE "address_book_entry" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"label" text NOT NULL,
	"address" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"created_by" text
);
--> statement-breakpoint
ALTER TABLE "address_book_entry" ADD CONSTRAINT "address_book_entry_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "address_book_entry" ADD CONSTRAINT "address_book_entry_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_address_book_org" ON "address_book_entry" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_address_book_org_address" ON "address_book_entry" USING btree ("organization_id","address");--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "featured" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "featured_order" integer DEFAULT 0;