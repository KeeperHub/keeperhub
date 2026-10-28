import { sql } from "drizzle-orm";
import {
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organization, workflows } from "@/lib/db/schema";
import { generateId } from "@/lib/utils/id";

/**
 * Workflow failure notifications: tell an organization when a workflow that
 * runs on its own keeps failing.
 *
 * Detection never hooks the code that ends a run (about ten places do). A
 * trigger on workflow_executions marks the workflow in
 * workflow_failure_alert_queue, and the evaluator (an internal cron route)
 * reads run history from there. See lib/notifications/failure-alerts/.
 */

export type FailureAlertChannelKind =
  | "slack"
  | "discord"
  | "telegram"
  | "pagerduty";

/** "always" gets every alert; "backup" only when another channel failed. */
export type FailureAlertChannelRole = "always" | "backup";

/**
 * Org-wide policy. An organization with no row gets DEFAULT_FAILURE_ALERT_POLICY
 * (5 failed runs in a row, email the owners), so nothing is backfilled for
 * existing organizations.
 *
 * `countingSince` is written the first time the evaluator sees the org with
 * the feature on. Failures before it never count, so switching the feature on
 * does not email every owner about workflows that have been failing for weeks.
 */
export const orgFailureAlertSettings = pgTable(
  "org_failure_alert_settings",
  {
    organizationId: text("organization_id").primaryKey(),
    threshold: integer("threshold").notNull().default(5),
    // Null: no time limit. Otherwise alert once a streak has lasted this long.
    timeLimitMinutes: integer("time_limit_minutes"),
    remindDaily: boolean("remind_daily").notNull().default(true),
    notifyRecovery: boolean("notify_recovery").notNull().default(true),
    // Null: the organization's owners. Otherwise these members, filtered to
    // current members with a deliverable address at send time.
    recipientUserIds: jsonb("recipient_user_ids").$type<string[] | null>(),
    countingSince: timestamp("counting_since"),
    launchNoticeSentAt: timestamp("launch_notice_sent_at"),
    updatedBy: text("updated_by"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: "org_failure_alert_settings_org_fk",
    }).onDelete("cascade"),
  ]
);

/**
 * A chat or PagerDuty destination. `workflowId` null is an org-wide channel;
 * set, it belongs to that workflow's custom channel list.
 *
 * Health lives on the row so settings can show it and the evaluator can skip a
 * paused channel without reading the delivery log.
 *
 * `integrationId` deliberately has no foreign key: deleting a connection must
 * not delete the channel silently. The next send finds the connection gone,
 * pauses the channel and tells the org, which a cascade would skip.
 */
export const failureAlertChannels = pgTable(
  "failure_alert_channels",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    organizationId: text("organization_id").notNull(),
    workflowId: text("workflow_id"),
    kind: text("kind").notNull().$type<FailureAlertChannelKind>(),
    integrationId: text("integration_id").notNull(),
    // Slack channel, Telegram chat id or PagerDuty service id. Empty for Discord.
    destination: text("destination").notNull().default(""),
    role: text("role")
      .notNull()
      .default("always")
      .$type<FailureAlertChannelRole>(),
    // Set after a permanent error or a day of failed retries; cleared by a
    // successful test.
    pausedAt: timestamp("paused_at"),
    pausedReason: text("paused_reason"),
    lastDeliveredAt: timestamp("last_delivered_at"),
    lastFailedAt: timestamp("last_failed_at"),
    lastError: text("last_error"),
    lastTestedAt: timestamp("last_tested_at"),
    lastTestOk: boolean("last_test_ok"),
    lastHealthCheckAt: timestamp("last_health_check_at"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: "failure_alert_channels_org_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.workflowId],
      foreignColumns: [workflows.id],
      name: "failure_alert_channels_workflow_fk",
    }).onDelete("cascade"),
    uniqueIndex("uq_failure_alert_channels_destination").on(
      table.organizationId,
      sql`coalesce(${table.workflowId}, '')`,
      table.integrationId,
      table.destination
    ),
    index("idx_failure_alert_channels_workflow").on(table.workflowId),
  ]
);

/**
 * Per-workflow override. Every nullable field means "follow the org": a field
 * nobody touched keeps tracking later org changes.
 */
export const workflowFailureAlertOverrides = pgTable(
  "workflow_failure_alert_overrides",
  {
    workflowId: text("workflow_id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    threshold: integer("threshold"),
    // Null follows the org; 0 turns the time limit off for this workflow.
    timeLimitMinutes: integer("time_limit_minutes"),
    recipientUserIds: jsonb("recipient_user_ids").$type<string[] | null>(),
    // True: use this workflow's rows in failure_alert_channels instead of the
    // org's.
    customChannels: boolean("custom_channels").notNull().default(false),
    mutedUntil: timestamp("muted_until"),
    muteUntilSuccess: boolean("mute_until_success").notNull().default(false),
    muteReason: text("mute_reason"),
    mutedBy: text("muted_by"),
    updatedBy: text("updated_by"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.workflowId],
      foreignColumns: [workflows.id],
      name: "workflow_failure_alert_overrides_workflow_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: "workflow_failure_alert_overrides_org_fk",
    }).onDelete("cascade"),
  ]
);

/**
 * Workflows to evaluate. Written by the run-status trigger (due now) and by
 * the evaluator itself to re-check a streak when its time limit falls due.
 * One row per workflow however often it runs.
 */
export const workflowFailureAlertQueue = pgTable(
  "workflow_failure_alert_queue",
  {
    workflowId: text("workflow_id").primaryKey(),
    dueAt: timestamp("due_at").notNull().defaultNow(),
  },
  (table) => [index("idx_failure_alert_queue_due").on(table.dueAt)]
);

export type FailureIncidentResolution =
  | "success"
  | "disabled"
  | "deleted"
  | "manual_trigger";

/**
 * One failing streak that reached the threshold. At most one open per
 * workflow (partial unique index): whoever inserts it sends the alert, so two
 * evaluators can never both send.
 */
export const workflowFailureIncidents = pgTable(
  "workflow_failure_incidents",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    organizationId: text("organization_id").notNull(),
    workflowId: text("workflow_id").notNull(),
    openedAt: timestamp("opened_at").notNull().defaultNow(),
    // "count" or "time": which rule opened it, for the message wording.
    openedBy: text("opened_by").notNull().$type<"count" | "time">(),
    threshold: integer("threshold").notNull(),
    failureCount: integer("failure_count").notNull(),
    firstFailedAt: timestamp("first_failed_at").notNull(),
    lastFailedAt: timestamp("last_failed_at").notNull(),
    lastFailedExecutionId: text("last_failed_execution_id"),
    lastError: text("last_error"),
    reminderCount: integer("reminder_count").notNull().default(0),
    lastNotifiedAt: timestamp("last_notified_at").notNull().defaultNow(),
    // Set in the same transaction that queues the alert. An open incident
    // without it lost its alert (a crash between the two) and is re-queued.
    alertQueuedAt: timestamp("alert_queued_at"),
    resolvedAt: timestamp("resolved_at"),
    resolvedReason: text("resolved_reason").$type<FailureIncidentResolution>(),
    resolvingExecutionId: text("resolving_execution_id"),
  },
  (table) => [
    foreignKey({
      columns: [table.workflowId],
      foreignColumns: [workflows.id],
      name: "workflow_failure_incidents_workflow_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: "workflow_failure_incidents_org_fk",
    }).onDelete("cascade"),
    uniqueIndex("uq_workflow_failure_incidents_open")
      .on(table.workflowId)
      .where(sql`${table.resolvedAt} IS NULL`),
    index("idx_workflow_failure_incidents_org").on(table.organizationId),
    index("idx_workflow_failure_incidents_workflow").on(table.workflowId),
  ]
);

export type FailureAlertMessageKind =
  | "alert"
  | "reminder"
  | "recovery"
  | "channel_paused"
  | "launch_notice";

export type FailureAlertDeliveryChannel = "email" | FailureAlertChannelKind;

export type FailureAlertDeliveryState =
  | "pending"
  | "sending"
  | "delivered"
  | "retrying"
  | "failed"
  | "capped"
  | "skipped";

/**
 * The outbox: one row per message, channel and recipient. The evaluator only
 * inserts; the drain step sends, retries and records the outcome.
 *
 * `dedupKey` names the message (incident or group, kind, sequence, channel,
 * recipient, backup or not) and is unique, so a message can never be queued
 * twice. A unique index over the nullable incident_id could not do that:
 * Postgres treats NULLs as distinct, and grouped alerts and notices have none.
 */
export const failureAlertDeliveries = pgTable(
  "failure_alert_deliveries",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    dedupKey: text("dedup_key").notNull(),
    organizationId: text("organization_id").notNull(),
    incidentId: text("incident_id"),
    kind: text("kind").notNull().$type<FailureAlertMessageKind>(),
    // Reminder number, so each reminder is its own message.
    sequence: integer("sequence").notNull().default(0),
    channel: text("channel").notNull().$type<FailureAlertDeliveryChannel>(),
    // failure_alert_channels.id for chat and PagerDuty; null for email.
    channelId: text("channel_id"),
    // Email address, or the channel's destination for display.
    recipient: text("recipient").notNull(),
    // True when sent because another channel failed.
    isBackup: boolean("is_backup").notNull().default(false),
    state: text("state")
      .notNull()
      .default("pending")
      .$type<FailureAlertDeliveryState>(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at").notNull().defaultNow(),
    // When the backups fire if this has still not been delivered.
    backupAt: timestamp("backup_at"),
    backupSentAt: timestamp("backup_sent_at"),
    lastStatus: integer("last_status"),
    lastError: text("last_error"),
    // Extra content the message needs (backup reason, grouped workflows).
    context: jsonb("context").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at"),
  },
  (table) => [
    foreignKey({
      columns: [table.incidentId],
      foreignColumns: [workflowFailureIncidents.id],
      name: "failure_alert_deliveries_incident_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: "failure_alert_deliveries_org_fk",
    }).onDelete("cascade"),
    uniqueIndex("uq_failure_alert_deliveries_dedup").on(table.dedupKey),
    index("idx_failure_alert_deliveries_incident").on(table.incidentId),
    // Only rows that may still need plan B, so delivered primaries (most of
    // the table) never sit in it.
    index("idx_failure_alert_deliveries_backup_due")
      .on(table.backupAt)
      .where(
        sql`${table.isBackup} = false AND ${table.backupSentAt} IS NULL AND ${table.state} IN ('pending', 'retrying', 'sending', 'failed', 'capped')`
      ),
    index("idx_failure_alert_deliveries_due")
      .on(table.nextAttemptAt)
      .where(sql`${table.state} IN ('pending', 'retrying', 'sending')`),
    index("idx_failure_alert_deliveries_org_created").on(
      table.organizationId,
      table.createdAt.desc()
    ),
  ]
);

/** Alert emails accepted by the provider per org per UTC month (Free cap). */
export const failureAlertEmailUsage = pgTable(
  "failure_alert_email_usage",
  {
    organizationId: text("organization_id").notNull(),
    periodStart: timestamp("period_start").notNull(),
    sent: integer("sent").notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.periodStart] }),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: "failure_alert_email_usage_org_fk",
    }).onDelete("cascade"),
  ]
);
