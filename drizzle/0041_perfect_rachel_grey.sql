CREATE TABLE "workflow_ratings" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"user_id" text NOT NULL,
	"rating" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_workflow_ratings_workflow_user" UNIQUE("workflow_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "source_workflow_id" text;--> statement-breakpoint
ALTER TABLE "workflow_ratings" ADD CONSTRAINT "workflow_ratings_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_ratings" ADD CONSTRAINT "workflow_ratings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_workflow_ratings_workflow" ON "workflow_ratings" USING btree ("workflow_id");