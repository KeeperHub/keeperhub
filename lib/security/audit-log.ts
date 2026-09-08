import deepDiff from "deep-diff";
import { db } from "@/lib/db";
import { securityAuditLog } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getMetricsCollector } from "@/lib/metrics";
import { MetricNames } from "@/lib/metrics/types";
import { alertHighRiskAudit } from "@/lib/security/audit-alerts";
import { notifyOwnersOfHighRiskAction } from "@/lib/security/audit-owner-alert";
import {
  getRequestCountry,
  getRequestSourceIp,
} from "@/lib/security/request-attribution";
import { generateId } from "@/lib/utils/id";

/**
 * Connection or open transaction an audit write runs on. A `Pick` of
 * `typeof db` lets a caller pass either the global `db` or a Drizzle `tx`
 * from `db.transaction(...)` without dragging in the full Drizzle generic
 * surface -- mirrors `PaymentRecorderDb` in lib/payments/x402/payment-gate.ts.
 */
export type AuditExecutor = Pick<typeof db, "insert">;

/** Possible outcomes for an audited operation. */
export type AuditOutcome = "succeeded" | "failed" | "partial";

/**
 * Durable record of a sensitive account/security action: who did it, what
 * changed, and from where. Pairs with the out-of-band email alerts -- the
 * email is the real-time signal, this is the queryable forensic history.
 *
 * Two write modes. By default (global `db`) a write is best-effort: a failure
 * is logged but never thrown, so a transient DB hiccup in the audit path can
 * never break the user action that triggered it. When a caller passes their
 * own `tx` as `executor`, the write instead composes into that transaction and
 * a failure re-throws so the whole operation rolls back atomically -- use that
 * mode when the audit row must be consistent with the action (e.g. a deletion
 * cascade that records each effect inside the same transaction).
 */

export type AuditActor = {
  /** The user who performed the action; null for unauthenticated/system paths. */
  userId: string | null;
  /** Org context for the action, if any. */
  organizationId: string | null;
  /** How the request authenticated: session | api-key | oauth | internal | unknown. */
  authMethod: string;
  /** The API key id when the action was performed via an API key. */
  apiKeyId?: string | null;
  /**
   * Denormalized actor identity (e.g. email or name) snapshotted at write
   * time. Survives deletion of the actor's user row, so deletion-cascade
   * events stay attributable even after their subject is gone.
   */
  actorLabel?: string | null;
  /** Denormalized org identity, durable across org deletion (see actorLabel). */
  organizationLabel?: string | null;
};

export type RecordAuditEventArgs = {
  actor: AuditActor;
  /** Dotted action name, e.g. "api_key.created", "api_key.revoked". */
  action: string;
  /** The kind of resource acted on, e.g. "api_key", "user", "workflow". */
  resourceType?: string | null;
  resourceId?: string | null;
  /**
   * Prior state for a mutation; omit for pure create events.
   *
   * REDACTION CONTRACT: `before`/`after` are deep-diffed and stored verbatim in
   * the `diff` JSONB column with no field filtering. Pass only curated,
   * non-secret fields (e.g. `{ name, keyPrefix }`) -- never a raw user row,
   * credential, token, or request body.
   */
  before?: unknown;
  /** New state for a mutation; omit for pure delete events. See `before` for the redaction contract. */
  after?: unknown;
  /** Request context (ip, userAgent) and any action-specific details. */
  metadata?: Record<string, unknown> | null;
  /**
   * Groups every event emitted by one logical operation (e.g. a deletion
   * cascade). Reuse the same id across the fan-out; omit for standalone events.
   */
  correlationId?: string | null;
  /** Operation outcome; defaults to "succeeded". */
  outcome?: AuditOutcome;
  /**
   * Connection the write runs on. Pass a `tx` to compose the audit row into
   * the action's own transaction (atomic). When an executor is passed, a
   * failed insert RE-THROWS so the surrounding transaction rolls back -- the
   * whole point of composing into a tx. With the default global `db` the
   * write stays best-effort and a failure is logged but never thrown, so a
   * transient audit-path hiccup can never break the user action.
   */
  executor?: AuditExecutor;
};

/** A fresh correlation id for grouping the events of one cascade/operation. */
export function newCorrelationId(): string {
  return generateId();
}

/**
 * Build an AuditActor from a resolved auth context (e.g. DualAuthContext),
 * collapsing the per-call-site object literal so callers can't drift on field
 * names or forget `apiKeyId`. Pass `identity` to snapshot the durable
 * actor/org labels (the auth context carries ids, not names).
 */
export function buildActor(
  auth: {
    userId: string | null;
    organizationId: string | null;
    authMethod: string;
    apiKeyId?: string | null;
  },
  identity?: { actorLabel?: string | null; organizationLabel?: string | null }
): AuditActor {
  return {
    userId: auth.userId,
    organizationId: auth.organizationId,
    authMethod: auth.authMethod,
    apiKeyId: auth.apiKeyId ?? null,
    actorLabel: identity?.actorLabel ?? null,
    organizationLabel: identity?.organizationLabel ?? null,
  };
}

/**
 * Build the structured diff stored in the `diff` column. Returns null when
 * there is nothing to diff (create/delete events, or identical states) so the
 * column stays meaningfully empty rather than holding `undefined`.
 */
function buildDiff(before: unknown, after: unknown): unknown {
  if (before === undefined && after === undefined) {
    return null;
  }
  const changes = deepDiff.diff(before, after);
  return changes ?? null;
}

/**
 * Build the standard request-context metadata (ip, country, user agent) for an
 * audit event so the "from where" question is answerable. Individual fields
 * are null when the proxy did not supply them.
 */
export function buildAuditMetadata(request: Request): Record<string, unknown> {
  return {
    ip: getRequestSourceIp(request),
    country: getRequestCountry(request),
    userAgent: request.headers.get("user-agent"),
  };
}

/** Map a record-event request to the row inserted into security_audit_log. */
function toInsertValues(
  args: RecordAuditEventArgs
): typeof securityAuditLog.$inferInsert {
  const { actor } = args;
  return {
    actorUserId: actor.userId,
    actorLabel: actor.actorLabel ?? null,
    organizationId: actor.organizationId,
    organizationLabel: actor.organizationLabel ?? null,
    authMethod: actor.authMethod,
    apiKeyId: actor.apiKeyId ?? null,
    action: args.action,
    resourceType: args.resourceType ?? null,
    resourceId: args.resourceId ?? null,
    diff: buildDiff(args.before, args.after),
    metadata: args.metadata ?? null,
    correlationId: args.correlationId ?? null,
    outcome: args.outcome ?? "succeeded",
  };
}

export async function recordAuditEvent(
  args: RecordAuditEventArgs
): Promise<void> {
  const executor = args.executor ?? db;
  // A passed executor means the caller is composing this row into their own
  // transaction and wants it to be atomic with the action -- so a failure
  // must surface (re-throw) to roll the transaction back. The default global
  // db path stays best-effort: log and swallow.
  const composed = args.executor !== undefined;
  try {
    await executor.insert(securityAuditLog).values(toInsertValues(args));
    // Surface irreversible / fund-moving actions actively. Skip the composed
    // path: that row is inside the caller's transaction and may still roll
    // back, so alerting waits for the standalone (committed) write.
    if (!composed) {
      alertHighRiskAudit({
        action: args.action,
        actorUserId: args.actor.userId,
        actorLabel: args.actor.actorLabel ?? null,
        organizationId: args.actor.organizationId,
        resourceType: args.resourceType ?? null,
        resourceId: args.resourceId ?? null,
      });
      // Out-of-band: email the org's owners for high-risk actions so they
      // learn promptly, not only on a later trail review. Fire-and-forget.
      notifyOwnersOfHighRiskAction({
        action: args.action,
        organizationId: args.actor.organizationId,
        actorUserId: args.actor.userId,
        actorLabel: args.actor.actorLabel ?? null,
        resourceType: args.resourceType ?? null,
        when: new Date(),
      });
    }
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to record security audit event",
      error,
      { action: args.action }
    );
    getMetricsCollector().incrementCounter(
      MetricNames.SECURITY_AUDIT_WRITE_FAILED,
      { action: args.action }
    );
    if (composed) {
      throw error;
    }
  }
}

/**
 * Record many events in one insert -- the fan-out of a single cascade. Pass a
 * shared `correlationId` on each so the operation reads back as one unit.
 * Like `recordAuditEvent`, a passed `executor` makes the write atomic and
 * re-throws on failure; the default global-db path is best-effort.
 */
export async function recordAuditEvents(
  events: RecordAuditEventArgs[],
  executor: AuditExecutor = db
): Promise<void> {
  if (events.length === 0) {
    return;
  }
  const composed = executor !== db;
  try {
    await executor
      .insert(securityAuditLog)
      .values(events.map((event) => toInsertValues(event)));
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to record security audit events",
      error,
      { count: String(events.length) }
    );
    getMetricsCollector().incrementCounter(
      MetricNames.SECURITY_AUDIT_WRITE_FAILED,
      { scope: "batch" }
    );
    if (composed) {
      throw error;
    }
  }
}
