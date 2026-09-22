/**
 * Millisecond time units.
 *
 * `24 * 60 * 60 * 1000` was spelled out in eighteen production files under ten
 * names (DAY_MS, MS_PER_DAY, TTL_MS, GRACE_MS, CACHE_TTL_MS, COMPLETED_TTL_MS,
 * DROPPED_AFTER_MS, RATE_LIMIT_RETENTION_MS, STUCK_PENDING_TX_CEILING_MS,
 * NEW_SIGNUP_NOTIFICATION_WINDOW_MS), once more as the literal 86_400_000, and
 * lib/analytics/time-range.ts managed to declare it twice within one file:
 * as MS_PER_DAY at the top and as DAY_MS a hundred lines down.
 *
 * Only the units belong here. A timeout, TTL or retention window that happens
 * to equal a day keeps its own name and is expressed in these units, so
 * shortening one policy cannot silently move an unrelated one.
 */

export const SECOND_MS = 1000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
export const WEEK_MS = 7 * DAY_MS;
