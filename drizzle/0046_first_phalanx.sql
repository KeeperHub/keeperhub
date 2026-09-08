DROP INDEX "idx_workflows_org_slug";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_workflows_listed_slug" ON "workflows" USING btree ("listed_slug") WHERE "workflows"."listed_slug" is not null;