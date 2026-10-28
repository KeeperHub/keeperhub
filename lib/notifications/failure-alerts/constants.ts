/**
 * Numbers that define workflow failure notifications, in one place so the
 * settings API, the evaluator, the UI and the tests cannot drift apart.
 */

/** Every organization gets this until an owner or admin changes it. */
export const DEFAULT_THRESHOLD = 5;
export const MIN_THRESHOLD = 1;
export const MAX_THRESHOLD = 20;

/** The optional "or failing for" limit. Off unless someone turns it on. */
export const TIME_LIMIT_OPTIONS_MINUTES = [60, 360, 1440] as const;
export type TimeLimitMinutes = (typeof TIME_LIMIT_OPTIONS_MINUTES)[number];

/** A mute can never be permanent: a broken workflow must not be forgotten. */
export const MAX_MUTE_DAYS = 30;

/** Reminders while a workflow keeps failing. */
export const REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Free plan: alert emails accepted by the provider per org per UTC month. */
export const FREE_PLAN_MONTHLY_EMAILS = 100;

/**
 * How long a temporary failure is retried before the backup channels are
 * used. PagerDuty is the on-call path, so it gets two minutes, not fifteen.
 */
export const BACKUP_AFTER_MS = {
  email: 15 * 60 * 1000,
  slack: 15 * 60 * 1000,
  discord: 15 * 60 * 1000,
  telegram: 15 * 60 * 1000,
  pagerduty: 2 * 60 * 1000,
} as const;

/** Retries keep going after the backups fire, until this much time passes. */
export const GIVE_UP_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Delay before attempt N+1 (index N-1). The last value repeats. The evaluator
 * runs every minute, so anything shorter waits for the next run.
 */
export const RETRY_DELAYS_MS = [
  60 * 1000,
  2 * 60 * 1000,
  5 * 60 * 1000,
  15 * 60 * 1000,
  30 * 60 * 1000,
  60 * 60 * 1000,
] as const;

/** A row left in "sending" this long belongs to an evaluator that died. */
export const STALE_SENDING_MS = 2 * 60 * 1000;

/** Rows drained per evaluator run, to keep one run inside its minute. */
export const MAX_DELIVERIES_PER_RUN = 200;
export const MAX_WORKFLOWS_PER_RUN = 500;

/** Workflows opening incidents in one org in one run beyond this are grouped. */
export const GROUP_ALERTS_FROM = 3;

/** Test buttons. */
export const TESTS_PER_MINUTE_PER_USER = 5;
export const TESTS_PER_DAY_PER_ORG = 30;

/** Silent channel checks. */
export const HEALTH_CHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/** History shown on the Notifications page. */
export const HISTORY_PAGE_SIZE = 50;
