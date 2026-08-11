CREATE TABLE "public_tags" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "public_tags_name_unique" UNIQUE("name"),
	CONSTRAINT "public_tags_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_public_tags" (
	"workflow_id" text NOT NULL,
	"public_tag_id" text NOT NULL,
	CONSTRAINT "workflow_public_tags_workflow_id_public_tag_id_pk" PRIMARY KEY("workflow_id","public_tag_id")
);
--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "tag_id" text;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_public_tags" ADD CONSTRAINT "workflow_public_tags_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_public_tags" ADD CONSTRAINT "workflow_public_tags_public_tag_id_public_tags_id_fk" FOREIGN KEY ("public_tag_id") REFERENCES "public"."public_tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_tags_org" ON "tags" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_public_tags_workflow" ON "workflow_public_tags" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_public_tags_tag" ON "workflow_public_tags" USING btree ("public_tag_id");--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" DROP COLUMN IF EXISTS "category";--> statement-breakpoint
ALTER TABLE "workflows" DROP COLUMN IF EXISTS "protocol";