import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Shared mutable test state lives in vi.hoisted so the hoisted vi.mock factories
// below can reference it. `store.rows` is an in-memory stand-in for the
// idempotency_records table; the fake db evaluates predicate-style WHERE clauses
// against it.
type Row = Record<string, unknown>;
type Predicate = (row: Row) => boolean;

const h = vi.hoisted(() => {
  const state = { rows: [] as Row[], idSeq: 0 };
  return { state };
});

vi.mock("drizzle-orm", () => ({
  and:
    (...preds: Predicate[]): Predicate =>
    (row: Row) =>
      preds.every((p) => p(row)),
  eq:
    (column: { _name: string }, value: unknown): Predicate =>
    (row: Row) =>
      row[column._name] === value,
  lt:
    (column: { _name: string }, value: unknown): Predicate =>
    (row: Row) =>
      (row[column._name] as Date).getTime() < (value as Date).getTime(),
}));

vi.mock("@/lib/db/schema-extensions", () => {
  const c = (name: string) => ({ _name: name });
  return {
    idempotencyRecords: {
      id: c("id"),
      organizationId: c("organizationId"),
      scope: c("scope"),
      idempotencyKey: c("idempotencyKey"),
      requestHash: c("requestHash"),
      status: c("status"),
      lockVersion: c("lockVersion"),
      responseStatus: c("responseStatus"),
      responseBody: c("responseBody"),
      resourceId: c("resourceId"),
      createdAt: c("createdAt"),
      expiresAt: c("expiresAt"),
    },
  };
});

vi.mock("@/lib/utils/id", () => ({
  generateId: () => `id_${++h.state.idSeq}`,
}));

vi.mock("@/lib/db", () => ({
  db: {
    insert: () => ({
      values: (vals: Row) => ({
        onConflictDoNothing: () => ({
          returning: () => {
            const conflict = h.state.rows.some(
              (r) =>
                r.organizationId === vals.organizationId &&
                r.scope === vals.scope &&
                r.idempotencyKey === vals.idempotencyKey
            );
            if (conflict) {
              return Promise.resolve([] as Row[]);
            }
            h.state.rows.push({ ...vals });
            return Promise.resolve([{ id: vals.id }]);
          },
        }),
      }),
    }),
    select: () => ({
      from: () => ({
        where: (pred: Predicate) => ({
          limit: () => Promise.resolve(h.state.rows.filter(pred).slice(0, 1)),
        }),
      }),
    }),
    update: () => ({
      set: (vals: Row) => ({
        where: (pred: Predicate) => {
          const matched = h.state.rows.filter(pred);
          for (const r of matched) {
            Object.assign(r, vals);
          }
          return {
            returning: () =>
              Promise.resolve(matched.map((r) => ({ id: r.id }))),
          };
        },
      }),
    }),
    delete: () => ({
      where: (pred: Predicate) => {
        const keep = h.state.rows.filter((r) => !pred(r));
        h.state.rows.length = 0;
        h.state.rows.push(...keep);
        return Promise.resolve();
      },
    }),
  },
}));

import {
  beginIdempotent,
  hashRequest,
  type IdempotencyOutcome,
  idempotencyEarlyResponse,
  recordIdempotentResponse,
} from "@/lib/idempotency";

const rows = h.state.rows;

beforeEach(() => {
  h.state.rows.length = 0;
  h.state.idSeq = 0;
});

function proceedFns(): Extract<IdempotencyOutcome, { kind: "proceed" }> & {
  finalize: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
  heartbeat: ReturnType<typeof vi.fn>;
} {
  return {
    kind: "proceed",
    finalize: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(undefined),
    heartbeat: vi.fn().mockResolvedValue(true),
  };
}

describe("hashRequest", () => {
  it("is independent of object key order", () => {
    expect(hashRequest({ a: 1, b: 2 })).toBe(hashRequest({ b: 2, a: 1 }));
  });

  it("is independent of nested key order", () => {
    expect(hashRequest({ x: { a: 1, b: 2 }, y: [1, 2] })).toBe(
      hashRequest({ y: [1, 2], x: { b: 2, a: 1 } })
    );
  });

  it("differs when a value changes", () => {
    expect(hashRequest({ a: 1 })).not.toBe(hashRequest({ a: 2 }));
  });

  it("differs when array order changes", () => {
    expect(hashRequest([1, 2])).not.toBe(hashRequest([2, 1]));
  });
});

describe("idempotencyEarlyResponse", () => {
  it("returns null for a proceed outcome", () => {
    expect(idempotencyEarlyResponse(proceedFns())).toBeNull();
  });

  it("maps replay to the stored status and body, marked as a replay", () => {
    expect(
      idempotencyEarlyResponse({
        kind: "replay",
        responseStatus: 202,
        responseBody: { executionId: "e1" },
      })
    ).toEqual({
      status: 202,
      body: { executionId: "e1", idempotentReplay: true },
    });
  });

  // A replayed failure is the case that actually misleads a caller: without the
  // marker it is indistinguishable from a fresh revert, so a retry loop keeps
  // reading "still failing" while no transaction is being sent at all.
  it("marks a replayed failure so it is distinguishable from a fresh one", () => {
    const early = idempotencyEarlyResponse({
      kind: "replay",
      responseStatus: 200,
      responseBody: {
        success: false,
        error: "Contract call failed: Error(LK: not yet due)",
      },
    });
    const body = early?.body as Record<string, unknown>;
    expect(body.idempotentReplay).toBe(true);
    // The original payload is preserved untouched alongside the marker.
    expect(body.error).toBe("Contract call failed: Error(LK: not yet due)");
    expect(body.success).toBe(false);
  });

  it("leaves non-object replay bodies untouched", () => {
    for (const stored of [null, "raw text", 42, [1, 2, 3]]) {
      const early = idempotencyEarlyResponse({
        kind: "replay",
        responseStatus: 200,
        responseBody: stored,
      });
      expect(early?.body).toEqual(stored);
    }
  });

  it("does not mark a fresh conflict or in_progress response as a replay", () => {
    const conflict = idempotencyEarlyResponse({
      kind: "conflict",
      originalResourceId: "e1",
    });
    const inProgress = idempotencyEarlyResponse({ kind: "in_progress" });
    expect(conflict?.body).not.toHaveProperty("idempotentReplay");
    expect(inProgress?.body).not.toHaveProperty("idempotentReplay");
  });

  it("maps conflict to 409 with the original execution id", () => {
    const early = idempotencyEarlyResponse({
      kind: "conflict",
      originalResourceId: "e1",
    });
    const body = early?.body as { code?: string; originalExecutionId?: string };
    expect(early?.status).toBe(409);
    expect(body.code).toBe("idempotency_conflict");
    expect(body.originalExecutionId).toBe("e1");
  });

  it("maps in_progress to 409", () => {
    const early = idempotencyEarlyResponse({ kind: "in_progress" });
    const body = early?.body as { code?: string };
    expect(early?.status).toBe(409);
    expect(body.code).toBe("idempotency_in_progress");
  });

  // The two 409s mean opposite things and a caller that reads only the status
  // cannot tell them apart. For a fund-moving call, reading `in_progress` as
  // terminal reports a failure while the original request is still on its way
  // to the chain.
  it("marks in_progress retryable and conflict not, so status alone is never the signal", () => {
    const inProgress = idempotencyEarlyResponse({ kind: "in_progress" });
    const conflict = idempotencyEarlyResponse({
      kind: "conflict",
      originalResourceId: "e1",
    });

    const inProgressBody = inProgress?.body as { retryable?: boolean };
    const conflictBody = conflict?.body as { retryable?: boolean };

    expect(inProgress?.status).toBe(conflict?.status);
    expect(inProgressBody.retryable).toBe(true);
    expect(conflictBody.retryable).toBe(false);
  });

  // Rotating the key on `in_progress` escapes the in-flight guard and can
  // broadcast the same action twice, so the message must not leave a caller to
  // guess which habit applies.
  it("tells the caller to keep the same key while a request is in flight", () => {
    const body = idempotencyEarlyResponse({ kind: "in_progress" })?.body as {
      error?: string;
    };
    expect(body.error).toMatch(/same key/i);
    expect(body.error).toMatch(/do not rotate/i);
  });

  it("leaves a replayed body free of a disposition it did not carry", () => {
    const early = idempotencyEarlyResponse({
      kind: "replay",
      responseStatus: 200,
      responseBody: { success: true },
    });
    // A replay is the real prior outcome, not a disposition about retrying.
    expect(early?.body).not.toHaveProperty("retryable");
  });
});

describe("recordIdempotentResponse", () => {
  it("finalizes a 2xx as success with the extracted execution id", async () => {
    const outcome = proceedFns();
    const res = Response.json(
      { executionId: "exec_1", status: "completed" },
      { status: 202 }
    );

    const returned = await recordIdempotentResponse(outcome, res);

    expect(returned).toBe(res);
    expect(outcome.release).not.toHaveBeenCalled();
    expect(outcome.finalize).toHaveBeenCalledWith({
      responseStatus: 202,
      responseBody: { executionId: "exec_1", status: "completed" },
      resourceId: "exec_1",
      succeeded: true,
    });
  });

  it("releases on a default non-2xx (pre-broadcast gating)", async () => {
    const outcome = proceedFns();
    await recordIdempotentResponse(
      outcome,
      Response.json({ error: "Spending cap exceeded" }, { status: 403 })
    );
    expect(outcome.finalize).not.toHaveBeenCalled();
    expect(outcome.release).toHaveBeenCalledTimes(1);
  });

  it("releases when disposition is release even on a 2xx", async () => {
    const outcome = proceedFns();
    await recordIdempotentResponse(
      outcome,
      Response.json({ ok: true }, { status: 200 }),
      "release"
    );
    expect(outcome.release).toHaveBeenCalledTimes(1);
    expect(outcome.finalize).not.toHaveBeenCalled();
  });

  it("finalizes-as-failed (not released) for a post-broadcast failure", async () => {
    const outcome = proceedFns();
    // A /node 422 or a 202 success:false reached the broadcast path.
    await recordIdempotentResponse(
      outcome,
      Response.json(
        { executionId: "exec_2", status: "failed", error: "revert" },
        { status: 422 }
      ),
      "failed"
    );
    expect(outcome.release).not.toHaveBeenCalled();
    expect(outcome.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ succeeded: false, responseStatus: 422 })
    );
  });

  it("is a no-op when there is no reserved record", async () => {
    const res = Response.json({ ok: true });
    expect(await recordIdempotentResponse(null, res)).toBe(res);
  });

  it("falls back to id for the resource id (workflow create)", async () => {
    const outcome = proceedFns();
    await recordIdempotentResponse(outcome, Response.json({ id: "wf_1" }));
    expect(outcome.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: "wf_1" })
    );
  });
});

describe("beginIdempotent", () => {
  const base = {
    organizationId: "org_1",
    key: "k1",
    requestBody: { amount: "1" },
  };

  it("reserves a fresh slot and proceeds", async () => {
    const outcome = await beginIdempotent({
      ...base,
      scope: "execute:transfer",
    });
    expect(outcome.kind).toBe("proceed");
    expect(rows).toHaveLength(1);
    expect(rows[0].lockVersion).toBe(0);
  });

  it("does not collide across distinct per-action scopes (B1)", async () => {
    const a = await beginIdempotent({
      ...base,
      scope: "execute:compound-v3/supply",
    });
    const b = await beginIdempotent({
      ...base,
      scope: "execute:compound-v3/withdraw",
    });
    expect(a.kind).toBe("proceed");
    // Different scope, same key + body -> independent reservation, not a replay.
    expect(b.kind).toBe("proceed");
    expect(rows).toHaveLength(2);
  });

  it("replays a completed record within the same scope", async () => {
    const first = await beginIdempotent({ ...base, scope: "execute:transfer" });
    if (first.kind !== "proceed") {
      throw new Error("expected proceed");
    }
    await first.finalize({
      responseStatus: 202,
      responseBody: { executionId: "exec_1" },
      resourceId: "exec_1",
      succeeded: true,
    });

    const replay = await beginIdempotent({
      ...base,
      scope: "execute:transfer",
    });
    expect(replay).toEqual({
      kind: "replay",
      responseStatus: 202,
      responseBody: { executionId: "exec_1" },
    });
  });

  it("replays a failed record so a retry cannot re-broadcast (H1/H2)", async () => {
    const first = await beginIdempotent({ ...base, scope: "execute:transfer" });
    if (first.kind !== "proceed") {
      throw new Error("expected proceed");
    }
    await first.finalize({
      responseStatus: 422,
      responseBody: { status: "failed" },
      resourceId: null,
      succeeded: false,
    });

    const replay = await beginIdempotent({
      ...base,
      scope: "execute:transfer",
    });
    expect(replay.kind).toBe("replay");
  });

  it("returns in_progress while a live (heartbeated) lock is held", async () => {
    await beginIdempotent({ ...base, scope: "execute:transfer" });
    // The first request is still processing and its lock has not expired.
    const second = await beginIdempotent({
      ...base,
      scope: "execute:transfer",
    });
    expect(second.kind).toBe("in_progress");
    expect(rows).toHaveLength(1);
  });

  it("reclaims only after the lock expires and bumps the fence (H3)", async () => {
    const first = await beginIdempotent({ ...base, scope: "execute:transfer" });
    if (first.kind !== "proceed") {
      throw new Error("expected proceed");
    }
    // Force the lock to look expired.
    rows[0].expiresAt = new Date(Date.now() - 1000);

    const second = await beginIdempotent({
      ...base,
      scope: "execute:transfer",
    });
    expect(second.kind).toBe("proceed");
    expect(rows[0].lockVersion).toBe(1);

    // The stale first holder's finalize/release/heartbeat are fenced no-ops.
    await first.finalize({
      responseStatus: 200,
      responseBody: { stale: true },
      resourceId: null,
      succeeded: true,
    });
    // Reclaim reset responseBody to null; the stale finalize did not write it.
    expect(rows[0].responseBody).toBeNull();
    expect(rows[0].status).toBe("processing");

    const stillAlive =
      first.kind === "proceed" ? await first.heartbeat() : false;
    expect(stillAlive).toBe(false);
  });

  it("conflicts when the same key carries a different body", async () => {
    await beginIdempotent({ ...base, scope: "execute:transfer" });
    const conflict = await beginIdempotent({
      ...base,
      scope: "execute:transfer",
      requestBody: { amount: "999" },
    });
    expect(conflict.kind).toBe("conflict");
  });

  it("heartbeat keeps the reclaimer's lock alive (B2)", async () => {
    const first = await beginIdempotent({ ...base, scope: "execute:transfer" });
    if (first.kind !== "proceed") {
      throw new Error("expected proceed");
    }
    const before = (rows[0].expiresAt as Date).getTime();
    rows[0].expiresAt = new Date(Date.now() - 1000);
    const beat = await first.heartbeat();
    // Lock version still 0, so heartbeat extends it.
    expect(beat).toBe(true);
    expect((rows[0].expiresAt as Date).getTime()).toBeGreaterThan(
      before - 1000
    );
  });
});
