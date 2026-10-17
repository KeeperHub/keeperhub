import {
  DirectExecutionStatus,
  type DirectExecutionTerminalStatus,
} from "@/lib/errors/execution-status";

/**
 * Outbound webhook event types for direct executions: the single source of
 * truth for the names stored in `event_outbox.event_type`, matched by
 * subscriptions and listed in the event catalog.
 *
 * Dependency-free so the relay, the delivery worker and client components can
 * import it outside the app's server-only import chain.
 */
export const DIRECT_EXECUTION_EVENT_TYPES = {
  succeeded: "direct_execution.succeeded",
  failed: "direct_execution.failed",
} as const;

export type DirectExecutionEventType =
  (typeof DIRECT_EXECUTION_EVENT_TYPES)[keyof typeof DIRECT_EXECUTION_EVENT_TYPES];

/**
 * The event each final status emits. Keyed by every terminal status, so adding
 * one to DIRECT_EXECUTION_TERMINAL_STATUSES fails to compile until it is given
 * an event here.
 */
export const DIRECT_EXECUTION_EVENT_TYPE_BY_STATUS: Record<
  DirectExecutionTerminalStatus,
  DirectExecutionEventType
> = {
  [DirectExecutionStatus.COMPLETED]: DIRECT_EXECUTION_EVENT_TYPES.succeeded,
  [DirectExecutionStatus.FAILED]: DIRECT_EXECUTION_EVENT_TYPES.failed,
};

/**
 * Prefix of a direct execution's `event_outbox.dedupe_key`. The key is the
 * prefix plus the execution id, with no status in it, so an execution emits at
 * most one final event.
 */
export const DIRECT_EXECUTION_DEDUPE_KEY_PREFIX = "direct_execution:";
