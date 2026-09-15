import { pgSchema, text, timestamp, varchar } from "drizzle-orm/pg-core";

/**
 * The Workflow DevKit runtime tables the DevKit run retention job reads.
 *
 * Declared here and not in lib/db/schema.ts on purpose. @workflow/world-postgres
 * creates and migrates the `workflow` schema itself, and drizzle.config.ts only
 * manages `public`, so these are query builders and nothing more. Only the
 * columns the job touches are listed.
 */
const workflowSchema = pgSchema("workflow");

export const devkitRuns = workflowSchema.table("workflow_runs", {
  id: varchar("id").primaryKey(),
  status: text("status").notNull(),
  createdAt: timestamp("created_at").notNull(),
});

export const devkitSteps = workflowSchema.table("workflow_steps", {
  stepId: varchar("step_id").primaryKey(),
  runId: varchar("run_id").notNull(),
});

export const devkitEvents = workflowSchema.table("workflow_events", {
  id: varchar("id").primaryKey(),
  runId: varchar("run_id").notNull(),
});
