// Shared numbers, so the API, evaluator, UI and tests cannot drift apart.

/** Every organization gets this until an owner or admin changes it. */
export const DEFAULT_THRESHOLD = 5;
export const MIN_THRESHOLD = 1;
export const MAX_THRESHOLD = 20;

/** The optional "or failing for" limit. Off unless someone turns it on. */
export const TIME_LIMIT_OPTIONS_MINUTES = [60, 360, 1440] as const;

/** A mute can never be permanent: a broken workflow must not be forgotten. */
export const MAX_MUTE_DAYS = 30;

/** Reminders while a workflow keeps failing. */
export const REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Reminders stop after a week; the in-app notice and Runs still show it. */
export const MAX_REMINDERS = 7;

/** Free plan: alert emails accepted by the provider per org per UTC month. */
export const FREE_PLAN_MONTHLY_EMAILS = 100;

/** Retry window before backups fire; PagerDuty is on-call, so only two minutes. */
export const BACKUP_AFTER_MS = {
  email: 15 * 60 * 1000,
  slack: 15 * 60 * 1000,
  discord: 15 * 60 * 1000,
  telegram: 15 * 60 * 1000,
  pagerduty: 2 * 60 * 1000,
} as const;

/** A message not sent within this long of first being due is dropped: it would only confuse. */
export const STALE_DELIVERY_MS = 60 * 60 * 1000;
/** A PagerDuty resolve is never news, only cleanup: it keeps retrying this long. */
export const PAGERDUTY_RESOLVE_STALE_MS = 24 * 60 * 60 * 1000;
/** A resolve waits this long after a page still being sent, so it lands second. */
export const PAGERDUTY_IN_FLIGHT_MS = 2 * 60 * 1000;

/** Delay before attempt N+1 (index N-1); the last repeats. Under a minute waits a cycle. */
export const RETRY_DELAYS_MS = [
  60 * 1000,
  2 * 60 * 1000,
  5 * 60 * 1000,
  15 * 60 * 1000,
  30 * 60 * 1000,
  60 * 60 * 1000,
] as const;

/** A row "sending" this long was claimed by a dead evaluator; live ones finish far sooner. */
export const STALE_SENDING_MS = 5 * 60 * 1000;

/** Both drains share this budget so a cycle ends within its minute; unreached rows go back. */
export const DELIVERY_BATCH = 25;
export const DELIVERY_BUDGET_MS = 40 * 1000;
export const MAX_WORKFLOWS_PER_RUN = 500;
/** Queue batches are claimed until this runs out, leaving the minute's rest to delivery. */
export const EVALUATE_BUDGET_MS = 15 * 1000;

/** "Or when it has been failing for 6 hours", on by default. */
export const DEFAULT_TIME_LIMIT_MINUTES = 360;
/** The time rule needs this many failures in a row; one failed run is not a streak. */
export const MIN_TIME_RULE_FAILURES = 2;
/** Two shortfalls in a row alert at once (and turn it off if set): waiting only burns runs. */
export const OUT_OF_FUNDS_THRESHOLD = 2;

/** A success holds its incident this long before it is announced; a failure inside it continues the incident. */
export const RECOVERY_HOLD_MS = 30 * 60 * 1000;

/** Longest org-wide pause, extensions included, so a forgotten one cannot silence alerts for long. */
export const MAX_ORG_PAUSE_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_PAUSE_REASON = 200;

/** A scheduled workflow this late with no run counts as not running. */
export const MISSED_RUN_GRACE_MS = 10 * 60 * 1000;
/** Schedules checked for a missed run per cycle. */
export const MISSED_SCAN_LIMIT = 2000;
/** This many late schedules at once points at the scheduler: page our on-call. */
export const MISSED_RUNS_PLATFORM_ALERT = 20;
/** Queue or outbox rows waiting this long mean the evaluator is not running. */
export const BACKLOG_ALERT_MS = 10 * 60 * 1000;

/** An open incident with no alert queued after this long lost it in a crash. */
export const ALERT_REQUEUE_AFTER_MS = 2 * 60 * 1000;

/** Delivery history and resolved incidents are kept this long. */
export const RETENTION_DAYS = 90;

/** Workflows opening incidents in one org in one run beyond this are grouped. */
export const GROUP_ALERTS_FROM = 3;

/** Test buttons. */
export const TESTS_PER_MINUTE_PER_USER = 5;
export const TESTS_PER_DAY_PER_ORG = 30;

/** Silent channel checks. */
export const HEALTH_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Silent checks run at once on save, so a long list cannot burst a bot token. */
export const CHANNEL_CHECK_CONCURRENCY = 4;

/** Chat and PagerDuty methods per org, and per workflow with its own list. */
export const MAX_CHANNELS = 20;

/** History rows per page, on the Alerts page and the workflow panel. */
export const HISTORY_PAGE_SIZE = 50;
