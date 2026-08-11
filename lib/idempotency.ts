import "server-only";

import { createHash } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { db } from "@/lib/db";
import { idempotencyRecords } from "@/lib/db/schema-extensions";
import { generateId } from "@/lib/utils/id";

// A reserved record holds a short "lock" so a crashed request can't block a
// retry for long; the in-flight request heartbeats the lock so long fund-moving
// work (tx.wait beyond the base TTL) keeps it alive, and once the work finishes
// the record is extended to the full replay window.
// Exported so callers can bound a single request's worst-case runtime below the
// reservation TTL (a request must not outlive its own processing lock).
export const PROCESSING_TTL_MS = 10 * 60 * 1000; // 10 minutes
const COMPLETED_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
// Re-extend the processing lock well before it lapses so a retry never reclaims
// a slot whose original request is still broadcasting on chain.
const HEARTBEAT_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
const MAX_RACE_RETRIES = 3;

export type IdempotencyFinalizeArgs = {
  responseStatus: number;
  responseBody: unknown;
  resourceId?: string | null;
  // Whether the underlying execution actually succeeded. A completed record is
  // replayable; a failed one is kept (not deleted) so a retry sees the prior
  // outcome instead of re-broadcasting a tx that may already be on chain.
  succeeded: boolean;
};

export type IdempotencyOutcome =
  | {
      kind: "proceed";
      finalize: (args: IdempotencyFinalizeArgs) => Promise<void>;
      release: () => Promise<void>;
      heartbeat: () => Promise<boolean>;
    }
  | { kind: "replay"; responseStatus: number; responseBody: unknown }
  | { kind: "conflict"; originalResourceId: string | null }
  | { kind: "in_progress" };

// Deterministic JSON so two logically-equal request bodies hash identically
// regardless of key order.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

// Exported for tests: two logically-equal bodies must hash identically so a
// retry isn't mistaken for a conflicting request.
export function hashRequest(body: unknown): string {
  return createHash("sha256").update(stableStringify(body)).digest("hex");
}

// finalize/release/heartbeat all fence on (id, lockVersion) so a stale holder
// whose lock was reclaimed cannot clobber the new holder's row.
function buildProceed(
  recordId: string,
  lockVersion: number
): IdempotencyOutcome {
  const fence = and(
    eq(idempotencyRecords.id, recordId),
    eq(idempotencyRecords.lockVersion, lockVersion)
  );
  return {
    kind: "proceed",
    finalize: async ({
      responseStatus,
      responseBody,
      resourceId,
      succeeded,
    }) => {
      await db
        .update(idempotencyRecords)
        .set({
          status: succeeded ? "completed" : "failed",
          responseStatus,
          // biome-ignore lint/suspicious/noExplicitAny: jsonb column stores arbitrary response bodies
          responseBody: responseBody as any,
          resourceId: resourceId ?? null,
          expiresAt: new Date(Date.now() + COMPLETED_TTL_MS),
        })
        .where(fence);
    },
    release: async () => {
      await db.delete(idempotencyRecords).where(fence);
    },
    heartbeat: async () => {
      const extended = await db
        .update(idempotencyRecords)
        .set({ expiresAt: new Date(Date.now() + PROCESSING_TTL_MS) })
        .where(fence)
        .returning({ id: idempotencyRecords.id });
      return extended.length > 0;
    },
  };
}

export type BeginIdempotentArgs = {
  organizationId: string;
  scope: string;
  key: string;
  requestBody: unknown;
};

export async function beginIdempotent(
  args: BeginIdempotentArgs,
  attempt = 0
): Promise<IdempotencyOutcome> {
  const requestHash = hashRequest(args.requestBody);
  const now = Date.now();
  const id = generateId();

  // Reserve the slot atomically: the unique (organization, scope, key) index
  // makes concurrent duplicates serialize on insert.
  const inserted = await db
    .insert(idempotencyRecords)
    .values({
      id,
      organizationId: args.organizationId,
      scope: args.scope,
      idempotencyKey: args.key,
      requestHash,
      status: "processing",
      lockVersion: 0,
      expiresAt: new Date(now + PROCESSING_TTL_MS),
    })
    .onConflictDoNothing()
    .returning({ id: idempotencyRecords.id });

  if (inserted.length > 0) {
    return buildProceed(id, 0);
  }

  const [existing] = await db
    .select()
    .from(idempotencyRecords)
    .where(
      and(
        eq(idempotencyRecords.organizationId, args.organizationId),
        eq(idempotencyRecords.scope, args.scope),
        eq(idempotencyRecords.idempotencyKey, args.key)
      )
    )
    .limit(1);

  // Lost a race with a concurrent delete (release or expiry sweep). Retry.
  if (!existing) {
    if (attempt >= MAX_RACE_RETRIES) {
      return { kind: "in_progress" };
    }
    return beginIdempotent(args, attempt + 1);
  }

  // A stale processing lock (crashed request) or an expired completed/failed
  // record: reclaim the slot for this fresh request, bumping lockVersion so the
  // prior holder can no longer write. The conditional update on expires_at
  // guards against a concurrent reclaim AND against a still-heartbeating holder.
  if (existing.expiresAt.getTime() <= now) {
    const nextVersion = existing.lockVersion + 1;
    const reclaimed = await db
      .update(idempotencyRecords)
      .set({
        requestHash,
        status: "processing",
        lockVersion: nextVersion,
        responseStatus: null,
        responseBody: null,
        resourceId: null,
        createdAt: new Date(now),
        expiresAt: new Date(now + PROCESSING_TTL_MS),
      })
      .where(
        and(
          eq(idempotencyRecords.id, existing.id),
          eq(idempotencyRecords.lockVersion, existing.lockVersion),
          lt(idempotencyRecords.expiresAt, new Date(now))
        )
      )
      .returning({ id: idempotencyRecords.id });
    if (reclaimed.length > 0) {
      return buildProceed(existing.id, nextVersion);
    }
    if (attempt >= MAX_RACE_RETRIES) {
      return { kind: "in_progress" };
    }
    return beginIdempotent(args, attempt + 1);
  }

  if (existing.requestHash !== requestHash) {
    return { kind: "conflict", originalResourceId: existing.resourceId };
  }

  // A completed OR failed record both replay: a failed record means the prior
  // attempt reached the broadcast path, so re-running could double-spend.
  if (existing.status === "completed" || existing.status === "failed") {
    return {
      kind: "replay",
      responseStatus: existing.responseStatus ?? 200,
      responseBody: existing.responseBody,
    };
  }

  return { kind: "in_progress" };
}

function pickString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

// How a reserved record should be settled once the work returns.
//   "success"      -> store a replayable completed record (2xx happy path).
//   "failed"       -> reached the broadcast/execution path but the work failed
//                     (tx revert as 202/200 success:false, /node 422, thrown
//                     mid-broadcast). Keep the row so a retry replays the
//                     failure instead of re-broadcasting.
//   "release"      -> provably pre-broadcast gating failure (reservation denied,
//                     requireWallet, validation 4xx): drop the row so the same
//                     key can be retried after the caller fixes the request.
export type IdempotencyDisposition = "success" | "failed" | "release";

// Derives the disposition from a response when the caller has no richer signal:
// 2xx is a success, anything else is a pre-broadcast gating failure. Routes that
// reach a broadcast path pass an explicit disposition instead.
function defaultDisposition(status: number): IdempotencyDisposition {
  return status >= 200 && status < 300 ? "success" : "release";
}

// Records the work's response against a reserved idempotency record. The
// finalize-vs-release decision is driven by the explicit disposition (the
// actual execution outcome), NOT the HTTP status envelope, so a fund-moving
// call that reached the broadcast path is never released and a retry can never
// re-broadcast it. Reads the response via clone() so the original is returned
// untouched. No-op when there is no reserved record (no key, or a
// replay/conflict outcome).
export async function recordIdempotentResponse<T extends Response>(
  outcome: IdempotencyOutcome | null,
  response: T,
  disposition?: IdempotencyDisposition
): Promise<T> {
  if (outcome?.kind !== "proceed") {
    return response;
  }

  const settle = disposition ?? defaultDisposition(response.status);

  if (settle === "release") {
    await outcome.release();
    return response;
  }

  let body: unknown = null;
  try {
    body = await response.clone().json();
  } catch {
    body = null;
  }

  if (settle === "failed") {
    await outcome.finalize({
      responseStatus: response.status,
      responseBody: body,
      resourceId: null,
      succeeded: false,
    });
    return response;
  }

  const record = (body ?? {}) as Record<string, unknown>;
  const resourceId =
    pickString(record.executionId) ??
    pickString(record.id) ??
    pickString(record.workflowId);
  await outcome.finalize({
    responseStatus: response.status,
    responseBody: body,
    resourceId,
    succeeded: true,
  });
  return response;
}

// Runs `work` while heartbeating the reserved lock so a long-running, fund-
// moving execution keeps its slot reserved past the base TTL. The interval is
// cleared once the work settles; if a heartbeat finds the lock was reclaimed
// (fence miss) it stops quietly -- finalize/release are no-ops in that case.
export async function withIdempotencyHeartbeat<T>(
  outcome: IdempotencyOutcome | null,
  work: () => Promise<T>
): Promise<T> {
  if (outcome?.kind !== "proceed") {
    return await work();
  }
  const timer = setInterval(() => {
    // Fire-and-forget: a fence-miss or DB hiccup must not crash the request.
    outcome.heartbeat().catch(() => {
      // ignore -- the lock either lapses or is reclaimed safely.
    });
  }, HEARTBEAT_INTERVAL_MS);
  // Let the process exit even if a timer is pending in a worker context.
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

// Convenience: reads the `Idempotency-Key` header and reserves a slot, or
// returns null when the client did not opt in to idempotency.
export async function beginIdempotentFromRequest(args: {
  request: Request;
  organizationId: string;
  scope: string;
  requestBody: unknown;
}): Promise<IdempotencyOutcome | null> {
  const key = args.request.headers.get("Idempotency-Key")?.trim();
  if (!key) {
    return null;
  }
  return await beginIdempotent({
    organizationId: args.organizationId,
    scope: args.scope,
    key,
    requestBody: args.requestBody,
  });
}

export type IdempotencyEarlyResponse = {
  status: number;
  body: unknown;
};

// Marks a replayed body so the caller can tell a cached prior outcome apart
// from a fresh one. A replayed failure is otherwise indistinguishable from a
// live failure: it carries the original contract-shaped error and nothing else,
// so a retry loop reads "still reverting" when in fact no transaction was sent.
// The flag rides in the body rather than a header because the common consumer
// is an agent reading a tool result, where response headers are not surfaced.
// Only plain objects are annotated -- arrays and primitives are returned
// untouched so a stored response shape is never corrupted.
function annotateReplay(body: unknown): unknown {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return body;
  }
  return { ...(body as Record<string, unknown>), idempotentReplay: true };
}

// Maps a non-proceed outcome to the response the caller should return as-is.
// Returns null for `proceed` (the caller does the work, then calls finalize).
//
// `conflict` and `in_progress` both answer 409 but mean opposite things, and
// only the `code` separates them. A client that classifies on status alone
// reads `in_progress` as a permanent failure, and for a fund-moving call that
// is the worst available reading: the original request still holds its
// processing lock and is very likely to land on chain, so the caller reports a
// payment failed while it is in fact succeeding.
//
// `retryable` answers exactly one question, and it is narrower than the name
// suggests: IS IT SAFE TO SEND THIS AGAIN UNDER THE SAME KEY?
//
//   in_progress -> true.  The first request holds the lock; the same key is the
//                         only safe way to retry, and it returns the guard now
//                         and the real outcome as a replay once that finishes.
//   conflict    -> false. The key is bound to a different body, and stays bound
//                         for as long as the record lives, so resending this
//                         body under this key can never succeed.
//
// `false` does not mean abandon the call. It also does not mean "rotate and
// resend", and on a fund-moving route that distinction is the whole thing. A
// conflict says one thing only: this body is not the body the key was bound to.
// There are two reasons for that and they want opposite responses.
//
//   genuinely different work -> rotate. That is what a new key is for.
//
//   the same intent, whose body was re-serialized -> the body drifted, not the
//   intent. `hashRequest` normalizes key order but not values, so "0.1" against
//   "0.10", `network` for `chainId`, or a reworded memo all land here. Rotating
//   escapes the in-flight guard on a request that may already have broadcast,
//   and pays twice. Canonicalize the body and keep the key.
//
// Do not read this field as a general "is this error retryable": a 429 on these
// routes is retryable and carries no `retryable` field at all, because the field
// exists only on these two codes.
//
// It rides in the body for the same reason `idempotentReplay` does: the common
// consumer is an agent reading a tool result, where response headers are not
// surfaced.
export function idempotencyEarlyResponse(
  outcome: IdempotencyOutcome
): IdempotencyEarlyResponse | null {
  switch (outcome.kind) {
    case "replay":
      return {
        status: outcome.responseStatus,
        body: annotateReplay(outcome.responseBody),
      };
    case "conflict":
      return {
        status: 409,
        body: {
          error:
            "Idempotency-Key was reused with a different request payload. Use a new key for a different request.",
          code: "idempotency_conflict",
          originalExecutionId: outcome.originalResourceId,
          retryable: false,
        },
      };
    case "in_progress":
      return {
        status: 409,
        body: {
          error:
            "A request with this Idempotency-Key is already being processed. Retry the same key shortly; do not rotate it.",
          code: "idempotency_in_progress",
          retryable: true,
        },
      };
    default:
      return null;
  }
}
