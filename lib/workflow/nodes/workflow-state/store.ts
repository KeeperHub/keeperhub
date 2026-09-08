/**
 * Workflow-scoped key-value state (KEEP-1036, #2288).
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
 * Isolation is structural: every operation scopes by (organizationId,
 * workflowId), and the step callers take both ids from the execution context,
 * never from node config - the same rule the circuit-breaker steps apply.
 * No API surface takes a workflow id, so one workflow cannot address another
 * workflow's keys and organizations cannot see each other.
 *
 * Concurrency: every write is a single atomic statement. For the
 * read-modify-write case (cursor += n), get returns `version` and set accepts
 * `expectedVersion` - a compare-and-set that fails with a structured conflict
 * error instead of silently losing the race.
 *
 * Eviction: expires_at is filtered on read and expired rows are deleted on
 * touch, so abandoned keys do not accumulate and no background job is needed
 * for correctness. Size/count limits are enforced here, not documented.
 */
import "server-only";

import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { workflowState } from "@/lib/db/schema";

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
  organizationId: string;
  workflowId: string;
};

export type WorkflowStateFailureReason =
  | "invalid"
  | "limit"
  | "conflict"
  | "storage";

export type WorkflowStateGetResult =
  | { success: true; exists: true; value: unknown; version: number }
  | { success: true; exists: false; value: null }
  | { success: false; error: string; reason: WorkflowStateFailureReason };

export type WorkflowStateSetResult =
  | { success: true; created: boolean; version: number }
  | { success: false; error: string; reason: WorkflowStateFailureReason };

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
 * numeric strings; must be a positive integer. undefined means "no CAS".
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
  if (!Number.isInteger(parsed) || parsed < 1) {
    return { error: "expectedVersion must be a positive integer" };
  }
  return { version: parsed };
}

/**
 * Coerce an editor-supplied value into the stored JSON value. Objects, arrays,
 * numbers and booleans from template references to node outputs are stored
 * as-is. A string that is JSON object/array text (a literal pasted into the
 * editor, or a template that resolved to JSON text) is stored parsed; strings
 * that do not parse are stored as-is.
 */
export function coerceStateValue(value: unknown): unknown {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return value;
      }
    }
    return value;
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
  return and(
    eq(workflowState.organizationId, scope.organizationId),
    eq(workflowState.workflowId, scope.workflowId)
  );
}

/** Only rows that have not expired. Expired rows are invisible to reads. */
function liveFilter(now: Date) {
  return or(isNull(workflowState.expiresAt), gt(workflowState.expiresAt, now));
}

/**
 * Read one key from a workflow's own state. An expired row is evicted on
 * touch and reported as not-existing, so a caller never sees stale data.
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
      return { success: true, exists: false, value: null };
    }

    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
      await executor
        .delete(workflowState)
        .where(and(scopeFilter(scope), eq(workflowState.key, validated.key)));
      return { success: true, exists: false, value: null };
    }

    return {
      success: true,
      exists: true,
      value: row.value,
      version: row.version,
    };
  } catch (error) {
    return failure(
      error instanceof Error ? error.message : "Failed to read workflow state",
      "storage"
    );
  }
}

/**
 * Write one key to a workflow's own state.
 *
 * Plain mode is an atomic upsert. With `expectedVersion` it becomes a
 * compare-and-set: the write applies only if the key's current version still
 * matches what the caller read; on mismatch (or a missing/expired key) the
 * call fails with a structured conflict error instead of losing the race.
 *
 * The key-count ceiling only gates writes that create a new row - overwriting
 * an existing key (live or expired) never grows the store, so it is never
 * blocked.
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
          `Compare-and-set failed: key "${validated.key}" changed since it was read (expected version ${options.expectedVersion}, current ${current.version}); re-read with State Get and retry`,
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
      // update). An expired row is about to be overwritten, so it does not
      // count against the ceiling; only a genuinely new key can grow the
      // store, and that is the path the limit gates.
      const [existing] = await tx
        .select({ key: workflowState.key })
        .from(workflowState)
        .where(and(scopeFilter(scope), eq(workflowState.key, validated.key)))
        .limit(1);

      if (!existing) {
        const [countRow] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(workflowState)
          .where(and(scopeFilter(scope), liveFilter(now)));

        if (
          (countRow?.count ?? 0) >= WORKFLOW_STATE_LIMITS.MAX_KEYS_PER_WORKFLOW
        ) {
          return failure(
            `Workflow state is limited to ${WORKFLOW_STATE_LIMITS.MAX_KEYS_PER_WORKFLOW} keys per workflow; reuse an existing key or let expired keys be evicted`,
            "limit"
          );
        }
      }

      const inserted = await tx
        .insert(workflowState)
        .values({
          organizationId: scope.organizationId,
          workflowId: scope.workflowId,
          key: validated.key,
          value: options.value,
          version: 1,
          expiresAt,
          updatedByExecutionId: options.executionId ?? null,
        })
        .onConflictDoUpdate({
          target: [
            workflowState.organizationId,
            workflowState.workflowId,
            workflowState.key,
          ],
          set: writeSet,
        })
        .returning({ version: workflowState.version });

      // The conflict arm covers a concurrent insert of the same key between
      // our UPDATE and INSERT (read committed): the DO UPDATE applies to the
      // winning row, so the write is still atomic and versioned.
      return {
        success: true,
        created: !existing,
        version: inserted[0].version,
      };
    });
  } catch (error) {
    return failure(
      error instanceof Error ? error.message : "Failed to write workflow state",
      "storage"
    );
  }
}
