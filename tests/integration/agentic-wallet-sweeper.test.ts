/**
 * Integration tests for GET /api/cron/agentic-wallet-sweeper (Phase 37 fix B2/B3
 * Task 15).
 *
 * The sweeper runs every 5 minutes and has three jobs:
 *   1. UPDATE wallet_approval_requests SET status='expired', resolved_at=now()
 *      WHERE status='pending' AND expires_at < now().  The status='pending'
 *      guard mirrors the Task 13 race fix: a row already resolved to approved
 *      or rejected out-of-band must NOT be overwritten to expired just because
 *      its TTL elapsed.
 *   2. DELETE terminal rows (expired/approved/rejected) whose resolved_at is
 *      older than 7 days.
 *   3. DELETE agentic_wallet_rate_limits rows whose bucket_start is older
 *      than 24h.
 *
 * Auth: the internal-service HMAC scheme (X-KH-Caller/Timestamp/Signature,
 * signed with INTERNAL_SERVICE_HMAC_SECRET) via authenticateInternalService,
 * scoped to caller "scheduler". Runs in every environment (no NODE_ENV
 * bypass). The verdict is mocked here, like the security-behavioral-scan
 * test, so these cases assert the route's handling of the verdict, not the
 * HMAC verification itself.
 *
 * Strategy: mirror the mock pattern from
 * tests/integration/agentic-wallet-approval-lifecycle.test.ts -- hoisted vi.fn
 * slots backing an in-memory store, with db.update/db.delete chains returning
 * the "rows affected" arrays the sweeper expects from `.returning(...)`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InternalServiceAuthResult } from "@/lib/internal-service-auth";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

type ApprovalRow = {
  id: string;
  status: "pending" | "approved" | "rejected" | "expired";
  expiresAt: Date;
  resolvedAt: Date | null;
};

type RateLimitRow = {
  key: string;
  bucketStart: Date;
};

// Fix-pack-2 R1: daily-spend rows are pruned by a fourth delete chain in the
// sweeper. dayUtc is a YYYY-MM-DD string matching the Postgres date column.
type DailySpendRow = {
  subOrgId: string;
  dayUtc: string;
};

type DbStore = {
  approvals: ApprovalRow[];
  rateLimits: RateLimitRow[];
  dailySpend: DailySpendRow[];
};

const { store, schemaTables } = vi.hoisted(() => {
  const backing: DbStore = {
    approvals: [],
    rateLimits: [],
    dailySpend: [],
  };
  // Sentinel table refs. The sweeper calls `db.update(walletApprovalRequests)`
  // and `db.delete(walletApprovalRequests | agenticWalletRateLimits |
  // agenticWalletDailySpend)`; the mock branches on identity so each chain
  // operates on the right slice of the in-memory store.
  const tables = {
    walletApprovalRequests: { __table: "walletApprovalRequests" as const },
    agenticWalletRateLimits: { __table: "agenticWalletRateLimits" as const },
    agenticWalletDailySpend: { __table: "agenticWalletDailySpend" as const },
  };
  return { store: backing, schemaTables: tables };
});

vi.mock("@/lib/db/schema", () => ({
  walletApprovalRequests: {
    ...schemaTables.walletApprovalRequests,
    id: "id",
    status: "status",
    expiresAt: "expires_at",
    resolvedAt: "resolved_at",
  },
  agenticWalletRateLimits: {
    ...schemaTables.agenticWalletRateLimits,
    key: "key",
    bucketStart: "bucket_start",
  },
  agenticWalletDailySpend: {
    ...schemaTables.agenticWalletDailySpend,
    subOrgId: "sub_org_id",
    dayUtc: "day_utc",
  },
}));

// drizzle-orm helpers used by the route. The sweeper's behaviour does not
// depend on *how* these compose the WHERE clause -- only that the rows the
// mock chain returns are correct. Returning plain markers is enough.
vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]): { __op: "and"; args: unknown[] } => ({
    __op: "and",
    args,
  }),
  or: (...args: unknown[]): { __op: "or"; args: unknown[] } => ({
    __op: "or",
    args,
  }),
  eq: (a: unknown, b: unknown): { __op: "eq"; a: unknown; b: unknown } => ({
    __op: "eq",
    a,
    b,
  }),
  lt: (a: unknown, b: unknown): { __op: "lt"; a: unknown; b: unknown } => ({
    __op: "lt",
    a,
    b,
  }),
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "DATABASE" },
  logSystemError: vi.fn(),
}));

// authenticateInternalService returns a discriminated union; reassign
// mockAuthResult per-test to drive the route's handling of each verdict.
let mockAuthResult: InternalServiceAuthResult = {
  authenticated: true,
  caller: "scheduler",
  scheme: "hmac",
};
vi.mock("@/lib/internal-service-auth", () => ({
  authenticateInternalService: vi.fn(() => Promise.resolve(mockAuthResult)),
}));

// ---------------------------------------------------------------------------
// DB mock: per-table update/delete chains backed by the in-memory store.
//
// The sweeper calls three chains (in order):
//   db.update(walletApprovalRequests).set({...}).where(...).returning({id})
//   db.delete(walletApprovalRequests).where(...).returning({id})
//   db.delete(agenticWalletRateLimits).where(...).returning({key})
//
// Each resolves using the store snapshot + the set of rules the sweeper
// expects (see top-of-file comment).
// ---------------------------------------------------------------------------

type UpdateChain = {
  set: (patch: Partial<ApprovalRow>) => {
    where: () => { returning: () => Promise<Array<{ id: string }>> };
  };
};

type DeleteApprovalsChain = {
  where: () => { returning: () => Promise<Array<{ id: string }>> };
};

type DeleteRateLimitsChain = {
  where: () => { returning: () => Promise<Array<{ key: string }>> };
};

type DeleteDailySpendChain = {
  where: () => { returning: () => Promise<Array<{ subOrgId: string }>> };
};

function buildUpdateChain(now: Date): UpdateChain {
  // The sweeper's only UPDATE targets walletApprovalRequests with
  //   status='expired', resolvedAt=now
  // where status='pending' AND expires_at < now.
  return {
    set: (patch) => ({
      where: () => ({
        returning: (): Promise<Array<{ id: string }>> => {
          const flipped: Array<{ id: string }> = [];
          for (const row of store.approvals) {
            if (row.status === "pending" && row.expiresAt < now) {
              row.status = patch.status ?? row.status;
              row.resolvedAt = patch.resolvedAt ?? row.resolvedAt ?? now;
              flipped.push({ id: row.id });
            }
          }
          return Promise.resolve(flipped);
        },
      }),
    }),
  };
}

function buildDeleteApprovalsChain(now: Date): DeleteApprovalsChain {
  // Delete terminal rows whose resolved_at is older than 7 days.
  const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  return {
    where: () => ({
      returning: (): Promise<Array<{ id: string }>> => {
        const pruned: Array<{ id: string }> = [];
        const kept: ApprovalRow[] = [];
        for (const row of store.approvals) {
          const isTerminal =
            row.status === "expired" ||
            row.status === "approved" ||
            row.status === "rejected";
          if (isTerminal && row.resolvedAt && row.resolvedAt < cutoff) {
            pruned.push({ id: row.id });
          } else {
            kept.push(row);
          }
        }
        store.approvals = kept;
        return Promise.resolve(pruned);
      },
    }),
  };
}

function buildDeleteRateLimitsChain(now: Date): DeleteRateLimitsChain {
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return {
    where: () => ({
      returning: (): Promise<Array<{ key: string }>> => {
        const pruned: Array<{ key: string }> = [];
        const kept: RateLimitRow[] = [];
        for (const row of store.rateLimits) {
          if (row.bucketStart < cutoff) {
            pruned.push({ key: row.key });
          } else {
            kept.push(row);
          }
        }
        store.rateLimits = kept;
        return Promise.resolve(pruned);
      },
    }),
  };
}

// Fix-pack-2 R1: the sweeper prunes daily-spend rows whose `day_utc` is
// more than 2 calendar days before today. Cutoff is a YYYY-MM-DD string
// that matches the route's JS-side computation.
function buildDeleteDailySpendChain(now: Date): DeleteDailySpendChain {
  const cutoffDate = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  return {
    where: () => ({
      returning: (): Promise<Array<{ subOrgId: string }>> => {
        const pruned: Array<{ subOrgId: string }> = [];
        const kept: DailySpendRow[] = [];
        for (const row of store.dailySpend) {
          if (row.dayUtc < cutoffDate) {
            pruned.push({ subOrgId: row.subOrgId });
          } else {
            kept.push(row);
          }
        }
        store.dailySpend = kept;
        return Promise.resolve(pruned);
      },
    }),
  };
}

vi.mock("@/lib/db", () => ({
  db: {
    update: (table: { __table: string }): UpdateChain => {
      if (table.__table !== "walletApprovalRequests") {
        throw new Error(
          `Unexpected update() target in sweeper test: ${table.__table}`
        );
      }
      return buildUpdateChain(new Date());
    },
    delete: (table: {
      __table: string;
    }):
      | DeleteApprovalsChain
      | DeleteRateLimitsChain
      | DeleteDailySpendChain => {
      const now = new Date();
      if (table.__table === "walletApprovalRequests") {
        return buildDeleteApprovalsChain(now);
      }
      if (table.__table === "agenticWalletRateLimits") {
        return buildDeleteRateLimitsChain(now);
      }
      if (table.__table === "agenticWalletDailySpend") {
        return buildDeleteDailySpendChain(now);
      }
      throw new Error(
        `Unexpected delete() target in sweeper test: ${table.__table}`
      );
    },
  },
}));

const { GET } = await import("@/app/api/cron/agentic-wallet-sweeper/route");

// ---------------------------------------------------------------------------
// Test env helpers
// ---------------------------------------------------------------------------

function resetStore(): void {
  store.approvals = [];
  store.rateLimits = [];
  store.dailySpend = [];
}

function makeGetRequest(headers: Record<string, string> = {}): Request {
  return new Request("https://example.com/api/cron/agentic-wallet-sweeper", {
    method: "GET",
    headers,
  });
}

describe("agentic-wallet-sweeper", () => {
  beforeEach(() => {
    resetStore();
    // Reset the auth verdict to an authenticated scheduler; the auth-specific
    // tests below override it per case.
    mockAuthResult = {
      authenticated: true,
      caller: "scheduler",
      scheme: "hmac",
    };
  });

  it("flips pending rows past expires_at to expired", async () => {
    store.approvals.push({
      id: "ar_stale_pending",
      status: "pending",
      expiresAt: new Date(Date.now() - 60_000),
      resolvedAt: null,
    });

    const res = await GET(makeGetRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      expired: number;
      pruned: number;
      prunedBuckets: number;
      prunedDailySpend: number;
    };
    expect(body).toEqual({
      expired: 1,
      pruned: 0,
      prunedBuckets: 0,
      prunedDailySpend: 0,
    });

    const row = store.approvals.find((r) => r.id === "ar_stale_pending");
    expect(row?.status).toBe("expired");
    expect(row?.resolvedAt).not.toBeNull();
  });

  it("does not touch pending rows whose expires_at is still in the future", async () => {
    store.approvals.push({
      id: "ar_fresh_pending",
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000),
      resolvedAt: null,
    });

    const res = await GET(makeGetRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { expired: number };
    expect(body.expired).toBe(0);

    const row = store.approvals.find((r) => r.id === "ar_fresh_pending");
    expect(row?.status).toBe("pending");
    expect(row?.resolvedAt).toBeNull();
  });

  it("respects the status='pending' guard (race-fix parity): does not re-flip an already-approved row past TTL", async () => {
    // Simulate the race: caller B's resolveApprovalRequest committed
    // status='approved' before the TTL elapsed. The sweeper must NOT
    // overwrite the terminal row to 'expired'.
    const resolvedAt = new Date(Date.now() - 2 * 60_000);
    store.approvals.push({
      id: "ar_resolved_approved",
      status: "approved",
      expiresAt: new Date(Date.now() - 60_000),
      resolvedAt,
    });

    const res = await GET(makeGetRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { expired: number };
    expect(body.expired).toBe(0);

    const row = store.approvals.find((r) => r.id === "ar_resolved_approved");
    expect(row?.status).toBe("approved");
    expect(row?.resolvedAt).toEqual(resolvedAt);
  });

  it("deletes terminal rows older than 7 days", async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    store.approvals.push({
      id: "ar_old_approved",
      status: "approved",
      expiresAt: new Date(eightDaysAgo.getTime() - 60_000),
      resolvedAt: eightDaysAgo,
    });

    const res = await GET(makeGetRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      expired: number;
      pruned: number;
    };
    expect(body.pruned).toBe(1);

    const row = store.approvals.find((r) => r.id === "ar_old_approved");
    expect(row).toBeUndefined();
  });

  it("does not delete terminal rows younger than 7 days", async () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    store.approvals.push({
      id: "ar_recent_rejected",
      status: "rejected",
      expiresAt: threeDaysAgo,
      resolvedAt: threeDaysAgo,
    });

    const res = await GET(makeGetRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pruned: number };
    expect(body.pruned).toBe(0);

    const row = store.approvals.find((r) => r.id === "ar_recent_rejected");
    expect(row?.status).toBe("rejected");
  });

  it("deletes rate-limit buckets older than 24h", async () => {
    const oldBucket = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const freshBucket = new Date(Date.now() - 60_000);
    store.rateLimits.push(
      { key: "provision:1.2.3.4", bucketStart: oldBucket },
      { key: "provision:5.6.7.8", bucketStart: freshBucket }
    );

    const res = await GET(makeGetRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { prunedBuckets: number };
    expect(body.prunedBuckets).toBe(1);
    expect(store.rateLimits.map((r) => r.key)).toEqual(["provision:5.6.7.8"]);
  });

  // Fix-pack-2 R1: daily-spend rows whose `day_utc` is more than 2 calendar
  // days behind today are pruned; today's + yesterday's rows are retained.
  it("deletes daily-spend rows older than 2 days", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    store.dailySpend.push(
      { subOrgId: "sub-today", dayUtc: today },
      { subOrgId: "sub-yesterday", dayUtc: yesterday },
      { subOrgId: "sub-old", dayUtc: threeDaysAgo }
    );

    const res = await GET(makeGetRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { prunedDailySpend: number };
    expect(body.prunedDailySpend).toBe(1);
    expect(store.dailySpend.map((r) => r.subOrgId).sort()).toEqual([
      "sub-today",
      "sub-yesterday",
    ]);
  });

  it("returns 401 when the internal-service auth rejects", async () => {
    mockAuthResult = { authenticated: false, error: "denied", status: 401 };

    const res = await GET(makeGetRequest());
    expect(res.status).toBe(401);
  });

  it("returns 401 when authenticated as a non-scheduler caller", async () => {
    mockAuthResult = { authenticated: true, caller: "mcp", scheme: "hmac" };

    const res = await GET(makeGetRequest());
    expect(res.status).toBe(401);
  });

  it("runs when authenticated as the scheduler caller", async () => {
    mockAuthResult = {
      authenticated: true,
      caller: "scheduler",
      scheme: "hmac",
    };

    const res = await GET(makeGetRequest());
    expect(res.status).toBe(200);
  });
});
