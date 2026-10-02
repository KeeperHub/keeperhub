/**
 * Workflow-scoped key-value state (#2288).
 *
 * Durable per-workflow store for the values a workflow computes and needs on
 * its next run - the monitor cursor pattern ("last block I scanned", "the
 * transactions I have already alerted on"). Backed by the org Postgres the
 * app already operates, so the user provisions nothing. The best-effort Redis
 * tier (lib/redis.ts) is deliberately not used: it documents itself as "never
 * a source of truth" (null client when REDIS_HOST is unset, fail-fast
 * commands), and a lost cursor is exactly the visible-failure case this store
 * exists to prevent.
 *
 * Isolation is structural: every operation scopes by workflowId, which the
 * step callers take from the execution context, never from node config - the
 * same rule the circuit-breaker steps apply. No API surface takes a workflow
 * id, so one workflow cannot address another workflow's keys, and a workflow
 * belongs to exactly one org.
 *
 * Concurrency: every write is a single atomic statement. For the
 * read-modify-write case (cursor += n), get returns `version` and set accepts
 * `expectedVersion` - a compare-and-set that fails with a structured conflict
 * error instead of silently losing the race.
 *
 * Expiry: expires_at is filtered on read, so an expired key reads as
 * missing. Its row is kept until the next write to that key overwrites it:
 * deleting on read could remove a value a concurrent write had just revived,
 * and would restart the key's version at 1, letting a stale compare-and-set
 * match again. There is no sweeper. Size/count limits are enforced here, not
 * documented.
 */
import "server-only";

import { and, eq, gt, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { workflowState } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import type { StepContext } from "@/lib/workflow/executor/step-handler";

// biome-ignore lint/suspicious/noExplicitAny: accept either the app db handle or an open transaction, mirroring value-ledger's Executor alias
type Executor = any;

/** Enforced limits for the per-workflow store. This is a KV store, not a database. */
export const WORKFLOW_STATE_LIMITS = {
  MAX_KEY_LENGTH: 256,
  MAX_VALUE_BYTES: 8 * 1024,
  MAX_KEYS_PER_WORKFLOW: 100,
  MIN_TTL_SECONDS: 1,
  // A cursor should live as long as the monitor does; a year covers any real
  // schedule while still guaranteeing abandoned keys eventually go away.
  MAX_TTL_SECONDS: 365 * 24 * 60 * 60,
} as const;

export type WorkflowStateScope = {
  workflowId: string;
};

export type WorkflowStateFailureReason =
  | "invalid"
  | "limit"
  | "conflict"
  | "storage";

export type WorkflowStateGetResult =
  | { success: true; exists: true; value: unknown; version: number }
  | { success: true; exists: false; value: null; version: 0 }
  | { success: false; error: string; reason: WorkflowStateFailureReason };

export type WorkflowStateSetResult =
  | { success: true; created: boolean; version: number }
  | { success: false; error: string; reason: WorkflowStateFailureReason };

/**
 * Resolve the workflow scope from a step's execution context. Steps call this
 * rather than reading config, so a config value named workflowId is ignored
 * and a step can only ever touch the state of the workflow it runs in.
 */
export function scopeFromStepContext(
  context: StepContext | undefined
): WorkflowStateScope | null {
  const workflowId = context?.workflowId;
  if (!workflowId) {
    return null;
  }
  return { workflowId };
}

function failure(
  error: string,
  reason: WorkflowStateFailureReason
): { success: false; error: string; reason: WorkflowStateFailureReason } {
  return { success: false, error, reason };
}

/** Validate a state key. Returns the trimmed key or an error string. */
export function validateStateKey(
  key: unknown
): { key: string } | { error: string } {
  if (typeof key !== "string" || key.trim() === "") {
    return { error: "State key must be a non-empty string" };
  }
  const trimmed = key.trim();
  if (trimmed.length > WORKFLOW_STATE_LIMITS.MAX_KEY_LENGTH) {
    return {
      error: `State key exceeds the ${WORKFLOW_STATE_LIMITS.MAX_KEY_LENGTH}-character limit`,
    };
  }
  return { key: trimmed };
}

/**
 * Resolve the `ttl` config value into a clamped expiry in seconds. Accepts
 * numbers (MCP callers) and numeric strings (the visual editor), rejects
 * anything else. null means "no expiry".
 */
export function resolveTtlSeconds(
  ttl: unknown
): { seconds: number | null } | { error: string } {
  if (ttl === undefined || ttl === null || ttl === "") {
    return { seconds: null };
  }
  const parsed = typeof ttl === "number" ? ttl : Number(ttl);
  if (!Number.isFinite(parsed)) {
    return { error: "ttl must be a number of seconds" };
  }
  if (parsed < WORKFLOW_STATE_LIMITS.MIN_TTL_SECONDS) {
    return {
      error: `ttl must be at least ${WORKFLOW_STATE_LIMITS.MIN_TTL_SECONDS} second`,
    };
  }
  return {
    seconds: Math.min(
      Math.trunc(parsed),
      WORKFLOW_STATE_LIMITS.MAX_TTL_SECONDS
    ),
  };
}

/**
 * Resolve the `expectedVersion` compare-and-set value. Accepts numbers and
 * numeric strings; must be a non-negative integer. 0 means "the key must not
 * exist", matching the version State Get reports for a missing key.
 * undefined means "no CAS".
 */
export function resolveExpectedVersion(
  expectedVersion: unknown
): { version?: number } | { error: string } {
  if (
    expectedVersion === undefined ||
    expectedVersion === null ||
    expectedVersion === ""
  ) {
    return {};
  }
  const parsed =
    typeof expectedVersion === "number"
      ? expectedVersion
      : Number(expectedVersion);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return { error: "expectedVersion must be a non-negative integer" };
  }
  return { version: parsed };
}

/**
 * Coerce an editor-supplied value into the stored JSON value. Non-string
 * values (MCP callers) are stored as-is. The editor resolves every template
 * to text, so a string is parsed back when it is unambiguous: JSON
 * object/array text is stored parsed, "true"/"false" as booleans, and a
 * numeric string as a number only when the number prints back as the same
 * text - "4219" becomes 4219, while a wei amount past 2^53 or "007" stays a
 * string rather than losing digits. Anything else is stored as-is.
 */
export function coerceStateValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }
  if (trimmed === "true" || trimmed === "false") {
    return trimmed === "true";
  }
  const asNumber = Number(trimmed);
  if (
    trimmed !== "" &&
    Number.isFinite(asNumber) &&
    String(asNumber) === trimmed
  ) {
    return asNumber;
  }
  return value;
}

/** Serialize and size-check the value. Returns the serialized length or an error. */
export function serializedValueSize(
  value: unknown
): { bytes: number } | { error: string } {
  if (value === undefined) {
    return { error: "State value is required" };
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? "null";
  } catch {
    return { error: "State value is not JSON-serializable" };
  }
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > WORKFLOW_STATE_LIMITS.MAX_VALUE_BYTES) {
    return {
      error: `State value is ${bytes} bytes serialized; the limit is ${WORKFLOW_STATE_LIMITS.MAX_VALUE_BYTES} bytes. This is a per-workflow key-value store, not a database - store an id or a cursor and fetch the payload through the Database Query or HTTP Request node instead.`,
    };
  }
  return { bytes };
}

function scopeFilter(scope: WorkflowStateScope) {
  return eq(workflowState.workflowId, scope.workflowId);
}

/** Only rows that have not expired. Expired rows are invisible to reads. */
function liveFilter(now: Date) {
  return or(isNull(workflowState.expiresAt), gt(workflowState.expiresAt, now));
}

/**
 * Read one key from a workflow's own state. An expired row is reported as
 * not-existing, so a caller never sees stale data; the row itself is left for
 * the next write to overwrite.
 */
export async function getWorkflowStateValue(
  scope: WorkflowStateScope,
  key: string,
  executor: Executor = db
): Promise<WorkflowStateGetResult> {
  const validated = validateStateKey(key);
  if ("error" in validated) {
    return failure(validated.error, "invalid");
  }

  try {
    const [row] = await executor
      .select({
        value: workflowState.value,
        version: workflowState.version,
        expiresAt: workflowState.expiresAt,
      })
      .from(workflowState)
      .where(and(scopeFilter(scope), eq(workflowState.key, validated.key)))
      .limit(1);

    if (!row) {
      return { success: true, exists: false, value: null, version: 0 };
    }

    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
      return { success: true, exists: false, value: null, version: 0 };
    }

    return {
      success: true,
      exists: true,
      value: row.value,
      version: row.version,
    };
  } catch (error) {
    // The driver's message names tables and constraints; it goes to logs,
    // not to the step output the workflow author sees.
    logSystemError(
      ErrorCategory.DATABASE,
      "[WorkflowState] Failed to read workflow state",
      error,
      { operation: "get" }
    );
    return failure("Failed to read workflow state", "storage");
  }
}

/**
 * Serialize every write that can make a key live in this workflow. The lock is
 * held until the transaction commits and is re-entrant, so a caller may take
 * it before its own checks and again through checkKeyCeiling.
 */
async function lockWorkflowState(
  tx: Executor,
  scope: WorkflowStateScope
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${scope.workflowId}))`
  );
}

/**
 * Gate a write that is about to make `key` live. Takes the per-workflow lock,
 * so the count and the write that follows are atomic together: without it,
 * two writers at 99 keys both read 99 and the workflow ends at 101. Counts
 * live keys other than `key`, so a concurrent write that made the same key
 * live first is not mistaken for growth.
 */
async function checkKeyCeiling(
  tx: Executor,
  scope: WorkflowStateScope,
  key: string,
  now: Date
): Promise<{
  success: false;
  error: string;
  reason: WorkflowStateFailureReason;
} | null> {
  await lockWorkflowState(tx, scope);
  const [countRow] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(workflowState)
    .where(
      and(scopeFilter(scope), liveFilter(now), ne(workflowState.key, key))
    );

  if ((countRow?.count ?? 0) >= WORKFLOW_STATE_LIMITS.MAX_KEYS_PER_WORKFLOW) {
    return failure(
      `Workflow state is limited to ${WORKFLOW_STATE_LIMITS.MAX_KEYS_PER_WORKFLOW} keys per workflow; reuse an existing key or let other keys expire`,
      "limit"
    );
  }
  return null;
}

/**
 * Write one key to a workflow's own state.
 *
 * Plain mode is an atomic upsert. With `expectedVersion` it becomes a
 * compare-and-set: the write applies only if the key's current version still
 * matches what the caller read; on mismatch (or a missing/expired key) the
 * call fails with a structured conflict error instead of losing the race.
 * `expectedVersion: 0` writes only if the key does not exist (or has
 * expired), so the first write of a read-modify-write is protected too.
 *
 * The key-count ceiling gates every write that makes a key live - a new key
 * or an expired one being revived. Overwriting a live key never grows the
 * store, so it is never blocked.
 */
export async function setWorkflowStateValue(
  scope: WorkflowStateScope,
  key: string,
  options: {
    value: unknown;
    ttlSeconds?: number | null;
    expectedVersion?: number;
    executionId?: string | null;
  },
  executor: Executor = db
): Promise<WorkflowStateSetResult> {
  const validated = validateStateKey(key);
  if ("error" in validated) {
    return failure(validated.error, "invalid");
  }

  const size = serializedValueSize(options.value);
  if ("error" in size) {
    return failure(size.error, "limit");
  }

  const expiresAt = options.ttlSeconds
    ? new Date(Date.now() + options.ttlSeconds * 1000)
    : null;
  const now = new Date();

  const writeSet = {
    value: options.value,
    version: sql`${workflowState.version} + 1`,
    expiresAt,
    updatedAt: now,
    updatedByExecutionId: options.executionId ?? null,
  };

  try {
    return await executor.transaction(async (tx: Executor) => {
      if (options.expectedVersion === 0) {
        // Every write that makes a key live holds this lock, so once it is
        // held no other writer can create the key before the insert below.
        await lockWorkflowState(tx, scope);
        const [current] = await tx
          .select({
            version: workflowState.version,
            expiresAt: workflowState.expiresAt,
          })
          .from(workflowState)
          .where(and(scopeFilter(scope), eq(workflowState.key, validated.key)))
          .limit(1);

        if (
          current &&
          !(current.expiresAt && current.expiresAt.getTime() <= now.getTime())
        ) {
          return failure(
            `Compare-and-set failed: key "${validated.key}" already exists (expected version 0, current ${current.version}); the next run re-reads it with State Get`,
            "conflict"
          );
        }

        const overCeiling = await checkKeyCeiling(
          tx,
          scope,
          validated.key,
          now
        );
        if (overCeiling) {
          return overCeiling;
        }

        // An expired row is overwritten in place, continuing its version.
        const inserted = await tx
          .insert(workflowState)
          .values({
            workflowId: scope.workflowId,
            key: validated.key,
            value: options.value,
            version: 1,
            expiresAt,
            updatedByExecutionId: options.executionId ?? null,
          })
          .onConflictDoUpdate({
            target: [workflowState.workflowId, workflowState.key],
            set: writeSet,
          })
          .returning({ version: workflowState.version });
        return { success: true, created: true, version: inserted[0].version };
      }

      if (options.expectedVersion !== undefined) {
        const updated = await tx
          .update(workflowState)
          .set(writeSet)
          .where(
            and(
              scopeFilter(scope),
              eq(workflowState.key, validated.key),
              eq(workflowState.version, options.expectedVersion),
              liveFilter(now)
            )
          )
          .returning({ version: workflowState.version });

        if (updated[0]) {
          return { success: true, created: false, version: updated[0].version };
        }

        // Distinguish "the key is gone" from "someone else wrote first" so
        // the caller knows whether a re-read can help.
        const [current] = await tx
          .select({
            version: workflowState.version,
            expiresAt: workflowState.expiresAt,
          })
          .from(workflowState)
          .where(and(scopeFilter(scope), eq(workflowState.key, validated.key)))
          .limit(1);

        if (
          !current ||
          (current.expiresAt && current.expiresAt.getTime() <= now.getTime())
        ) {
          return failure(
            `Compare-and-set failed: key "${validated.key}" does not exist (or has expired); nothing to update`,
            "conflict"
          );
        }
        return failure(
          `Compare-and-set failed: key "${validated.key}" changed since it was read (expected version ${options.expectedVersion}, current ${current.version}); the next run re-reads it with State Get`,
          "conflict"
        );
      }

      // Plain upsert: an existing live row is updated in place.
      const updated = await tx
        .update(workflowState)
        .set(writeSet)
        .where(
          and(
            scopeFilter(scope),
            eq(workflowState.key, validated.key),
            liveFilter(now)
          )
        )
        .returning({ version: workflowState.version });

      if (updated[0]) {
        return { success: true, created: false, version: updated[0].version };
      }

      // The key has no row at all, or its row is expired (invisible to the
      // update). Either way this write makes the key live, so it is gated.
      const [existing] = await tx
        .select({ expiresAt: workflowState.expiresAt })
        .from(workflowState)
        .where(and(scopeFilter(scope), eq(workflowState.key, validated.key)))
        .limit(1);

      const overCeiling = await checkKeyCeiling(tx, scope, validated.key, now);
      if (overCeiling) {
        return overCeiling;
      }

      const inserted = await tx
        .insert(workflowState)
        .values({
          workflowId: scope.workflowId,
          key: validated.key,
          value: options.value,
          version: 1,
          expiresAt,
          updatedByExecutionId: options.executionId ?? null,
        })
        .onConflictDoUpdate({
          target: [workflowState.workflowId, workflowState.key],
          set: writeSet,
        })
        .returning({ version: workflowState.version });

      // The conflict arm covers a concurrent insert of the same key between
      // our UPDATE and INSERT (read committed): the DO UPDATE applies to the
      // winning row, so the write is still atomic and versioned. Overwriting
      // an expired row counts as creating the key, since a read just before
      // reported it as not existing; losing the insert race does not.
      const replacedExpired =
        existing?.expiresAt != null &&
        existing.expiresAt.getTime() <= now.getTime();
      return {
        success: true,
        created: inserted[0].version === 1 || replacedExpired,
        version: inserted[0].version,
      };
    });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[WorkflowState] Failed to write workflow state",
      error,
      { operation: "set" }
    );
    return failure("Failed to write workflow state", "storage");
  }
}
