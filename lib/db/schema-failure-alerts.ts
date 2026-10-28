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

// Failure alerts. A DB trigger queues workflows (runs end in ~10 code paths);
// the cron evaluator in lib/notifications/failure-alerts/ reads from there.

export type FailureAlertChannelKind =
  | "slack"
  | "discord"
  | "telegram"
  | "pagerduty";

/** "always" gets every alert; "backup" only when another channel failed. */
export type FailureAlertChannelRole = "always" | "backup";

/** Org-wide policy; no row means the defaults. countingSince hides older failures. */
export const orgFailureAlertSettings = pgTable(
  "alert_settings",
  {
    organizationId: text("organization_id").primaryKey(),
    threshold: integer("threshold").notNull().default(5),
    // Null: no time limit. Otherwise alert once a streak has lasted this long.
    timeLimitMinutes: integer("time_limit_minutes").default(360),
    remindDaily: boolean("remind_daily").notNull().default(true),
    notifyRecovery: boolean("notify_recovery").notNull().default(true),
    // Null: the owners. Otherwise these members, re-filtered at send time.
    recipientUserIds: jsonb("recipient_user_ids").$type<string[] | null>(),
    countingSince: timestamp("counting_since"),
    launchNoticeSentAt: timestamp("launch_notice_sent_at"),
    // Org-wide pause (maintenance): no alerts until then.
    pausedUntil: timestamp("paused_until"),
    pauseReason: text("pause_reason"),
    pausedBy: text("paused_by"),
    // Bumped on every save; a save sent with an older one is refused.
    version: integer("version").notNull().default(0),
    updatedBy: text("updated_by"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: "alert_settings_org_fk",
    }).onDelete("cascade"),
  ]
);

/** Chat/PagerDuty channel. No FK on integrationId, on purpose: pause and tell, never cascade. */
export const failureAlertChannels = pgTable(
  "alert_methods",
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
    // Set after a permanent error or a day of failed retries; a good test clears it.
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
      name: "alert_methods_org_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.workflowId],
      foreignColumns: [workflows.id],
      name: "alert_methods_workflow_fk",
    }).onDelete("cascade"),
    uniqueIndex("uq_alert_methods_destination").on(
      table.organizationId,
      sql`coalesce(${table.workflowId}, '')`,
      table.integrationId,
      table.destination
    ),
    index("idx_alert_methods_workflow").on(table.workflowId),
  ]
);

/** Per-workflow override; a null field follows the org. */
export const workflowFailureAlertOverrides = pgTable(
  "alert_overrides",
  {
    workflowId: text("workflow_id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    threshold: integer("threshold"),
    // Null follows the org; 0 turns the time limit off for this workflow.
    timeLimitMinutes: integer("time_limit_minutes"),
    recipientUserIds: jsonb("recipient_user_ids").$type<string[] | null>(),
    // True: use this workflow's alert_methods rows instead of the org's.
    customChannels: boolean("custom_channels").notNull().default(false),
    mutedUntil: timestamp("muted_until"),
    muteUntilSuccess: boolean("mute_until_success").notNull().default(false),
    muteReason: text("mute_reason"),
    mutedBy: text("muted_by"),
    // Per workflow only: an org-wide switch could stop every automation at once.
    pauseWorkflow: boolean("pause_workflow").notNull().default(false),
    // Bumped on every save; a save sent with an older one is refused.
    version: integer("version").notNull().default(0),
    updatedBy: text("updated_by"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.workflowId],
      foreignColumns: [workflows.id],
      name: "alert_overrides_workflow_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: "alert_overrides_org_fk",
    }).onDelete("cascade"),
  ]
);

/** Workflows to evaluate, one row each; written by the run trigger and time-limit rechecks. */
export const workflowFailureAlertQueue = pgTable(
  "alert_queue",
  {
    workflowId: text("workflow_id").primaryKey(),
    dueAt: timestamp("due_at").notNull().defaultNow(),
  },
  (table) => [index("idx_alert_queue_due").on(table.dueAt)]
);

export type FailureIncidentResolution =
  | "success"
  | "ran"
  | "disabled"
  | "deleted"
  | "manual_trigger";

/** What opened an incident: N failures, a time limit, or a schedule that did not run. */
export type FailureIncidentTrigger = "count" | "time" | "missed" | "funding";

/** A streak over threshold; one open per workflow, so only the inserter sends. */
export const workflowFailureIncidents = pgTable(
  "alert_incidents",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    organizationId: text("organization_id").notNull(),
    workflowId: text("workflow_id").notNull(),
    openedAt: timestamp("opened_at").notNull().defaultNow(),
    openedBy: text("opened_by").notNull().$type<FailureIncidentTrigger>(),
    threshold: integer("threshold").notNull(),
    failureCount: integer("failure_count").notNull(),
    firstFailedAt: timestamp("first_failed_at").notNull(),
    lastFailedAt: timestamp("last_failed_at").notNull(),
    lastFailedExecutionId: text("last_failed_execution_id"),
    lastError: text("last_error"),
    reminderCount: integer("reminder_count").notNull().default(0),
    lastNotifiedAt: timestamp("last_notified_at").notNull().defaultNow(),
    // Set with the alert's queueing; an open incident without it gets re-queued.
    alertQueuedAt: timestamp("alert_queued_at"),
    // While the workflow stays off, the incident stays open: stopped is not fixed.
    workflowPausedAt: timestamp("workflow_paused_at"),
    // Set by a trigger on workflows.enabled; an older pause no longer holds the incident.
    workflowResumedAt: timestamp("workflow_resumed_at"),
    resolvedAt: timestamp("resolved_at"),
    resolvedReason: text("resolved_reason").$type<FailureIncidentResolution>(),
    resolvingExecutionId: text("resolving_execution_id"),
  },
  (table) => [
    foreignKey({
      columns: [table.workflowId],
      foreignColumns: [workflows.id],
      name: "alert_incidents_workflow_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: "alert_incidents_org_fk",
    }).onDelete("cascade"),
    uniqueIndex("uq_alert_incidents_open")
      .on(table.workflowId)
      .where(sql`${table.resolvedAt} IS NULL`),
    index("idx_alert_incidents_org").on(table.organizationId),
    index("idx_alert_incidents_workflow").on(table.workflowId),
  ]
);

export type FailureAlertMessageKind =
  | "alert"
  | "reminder"
  | "recovery"
  | "channel_paused"
  | "launch_notice"
  | "alerts_paused"
  | "alerts_resumed"
  | "cap_warning";

export type FailureAlertDeliveryChannel = "email" | FailureAlertChannelKind;

export type FailureAlertDeliveryState =
  | "pending"
  | "sending"
  | "delivered"
  | "retrying"
  | "failed"
  | "capped"
  | "skipped";

/** Outbox, one row per message and recipient; dedupKey is unique since incident_id can be null. */
export const failureAlertDeliveries = pgTable(
  "alert_deliveries",
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
    // alert_methods.id for chat and PagerDuty; null for email.
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
      name: "alert_deliveries_incident_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: "alert_deliveries_org_fk",
    }).onDelete("cascade"),
    uniqueIndex("uq_alert_deliveries_dedup").on(table.dedupKey),
    index("idx_alert_deliveries_incident").on(table.incidentId),
    // Partial: delivered primaries (most rows) stay out of it.
    index("idx_alert_deliveries_backup_due")
      .on(table.backupAt)
      .where(
        sql`${table.isBackup} = false AND ${table.backupSentAt} IS NULL AND ${table.state} IN ('pending', 'retrying', 'sending', 'failed', 'capped')`
      ),
    index("idx_alert_deliveries_due")
      .on(table.nextAttemptAt)
      .where(sql`${table.state} IN ('pending', 'retrying', 'sending')`),
    index("idx_alert_deliveries_org_created").on(
      table.organizationId,
      table.createdAt.desc()
    ),
  ]
);

/** Alert emails accepted by the provider per org per UTC month (Free cap). */
export const failureAlertEmailUsage = pgTable(
  "alert_email_usage",
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
      name: "alert_email_usage_org_fk",
    }).onDelete("cascade"),
  ]
);
