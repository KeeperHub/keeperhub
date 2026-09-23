/**
 * Integration tests for GET /api/workflows/[workflowId]/executions: the
 * unchanged full list and the `view=summary` page with keyset pagination
 * and ETag revalidation.
 */

import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  mockGetDualAuthContext,
  mockGetWorkflowAccess,
  mockFindFirst,
  mockFindMany,
  mockSelect,
} = vi.hoisted(() => ({
  mockGetDualAuthContext: vi.fn(),
  mockGetWorkflowAccess: vi.fn(),
  mockFindFirst: vi.fn(),
  mockFindMany: vi.fn(),
  mockSelect: vi.fn(),
}));

vi.mock("@/lib/middleware/auth-helpers", () => ({
  getDualAuthContext: (...args: unknown[]) => mockGetDualAuthContext(...args),
  authFailureResponse: (ctx: { error: string; status: number }) =>
    Response.json({ error: ctx.error }, { status: ctx.status }),
}));

vi.mock("@/lib/middleware/require-scope", () => ({
  requireScope: () => null,
}));

vi.mock("@/lib/mcp/oauth-scopes", () => ({
  SCOPE_MCP_WRITE: "mcp:write",
}));

vi.mock("@/lib/workflow/access", () => ({
  getWorkflowAccess: (...args: unknown[]) => mockGetWorkflowAccess(...args),
}));

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      workflows: { findFirst: mockFindFirst },
      workflowExecutions: { findMany: mockFindMany },
    },
    select: (...args: unknown[]) => mockSelect(...args),
    update: vi.fn(),
  },
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "DATABASE" },
  logSystemError: vi.fn(),
}));

import { PgDialect } from "drizzle-orm/pg-core";
import {
  GET,
  MAX_COUNTED_RUNS,
} from "@/app/api/workflows/[workflowId]/executions/route";
import { decodeExecutionsCursor } from "@/lib/workflow/executions-cursor";

const WORKFLOW_ID = "wf_1";
const HISTORY_ROWS = [
  { version: 3, contentHash: "hash-a", createdAt: new Date("2026-01-01") },
];

type Row = Record<string, unknown> & { id: string; startedAtKey: string };

function makeRow(index: number, overrides: Partial<Row> = {}): Row {
  const second = String(index).padStart(2, "0");
  return {
    id: `exec_${index}`,
    workflowId: WORKFLOW_ID,
    userId: "user_1",
    status: "success",
    input: { trigger: "manual" },
    output: { results: "x".repeat(64) },
    executionTrace: ["trigger", "action"],
    executedWorkflowHash: "hash-a",
    startedAt: new Date(`2026-09-23T00:00:${second}.123Z`),
    startedAtKey: `2026-09-23 00:00:${second}.123456`,
    completedAt: null,
    duration: null,
    totalSteps: "3",
    completedSteps: "2",
    error: null,
    ...overrides,
  };
}

function makeRows(count: number): Row[] {
  return Array.from({ length: count }, (_, i) => makeRow(59 - i));
}

/**
 * Stand in for the relational query: rows come back without the columns the
 * caller excluded and with a field per `extras` key, the way Drizzle returns
 * them, so the route is shown to rely on the database shape rather than
 * stripping or adding fields afterwards.
 */
function setRows(rows: Row[]): void {
  mockFindMany.mockImplementation(
    (args: {
      columns?: Record<string, boolean>;
      extras?: Record<string, unknown>;
    }) => {
      const excluded = Object.entries(args.columns ?? {})
        .filter(([, included]) => included === false)
        .map(([column]) => column);
      return Promise.resolve(
        rows.map((row) => {
          const copy: Record<string, unknown> = { ...row };
          for (const column of excluded) {
            delete copy[column];
          }
          for (const extra of Object.keys(args.extras ?? {})) {
            copy[extra] = row[extra];
          }
          return copy;
        })
      );
    }
  );
}

function request(query = "", headers?: HeadersInit): Request {
  return new Request(
    `http://localhost:3000/api/workflows/${WORKFLOW_ID}/executions${query}`,
    { headers }
  );
}

function call(query = "", headers?: HeadersInit): Promise<Response> {
  return GET(request(query, headers), {
    params: Promise.resolve({ workflowId: WORKFLOW_ID }),
  });
}

// What the count query saw: the LIMIT on the counted subquery, the source
// the count ran over, and the number it returns.
let countLimit: number | null = null;
let countedSource: { alias: string } | null = null;
let countRows: Array<{ total: number }> = [{ total: 46 }];

/**
 * Stand in for the three select shapes the route issues: the bounded
 * subquery of run ids (select id ... limit n ... as alias), the count over
 * that subquery, and the history lookup for ran versions.
 */
function selectChain(fields: Record<string, unknown>) {
  if ("total" in fields) {
    return {
      from: (source: { alias: string }) => {
        countedSource = source;
        return Promise.resolve(countRows);
      },
    };
  }
  if ("id" in fields) {
    return {
      from: () => ({
        where: () => ({
          limit: (n: number) => {
            countLimit = n;
            return { as: (alias: string) => ({ alias }) };
          },
        }),
      }),
    };
  }
  return { from: () => ({ where: () => Promise.resolve(HISTORY_ROWS) }) };
}

describe("GET /api/workflows/[workflowId]/executions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDualAuthContext.mockResolvedValue({
      userId: "user_1",
      organizationId: "org_1",
      authMethod: "session",
    });
    mockFindFirst.mockResolvedValue({ id: WORKFLOW_ID, deletedAt: null });
    mockGetWorkflowAccess.mockResolvedValue({
      hasFullAccess: true,
      isDeleted: false,
    });
    mockSelect.mockImplementation(selectChain);
    countLimit = null;
    countedSource = null;
    countRows = [{ total: 46 }];
    setRows(makeRows(3));
  });

  describe("default view", () => {
    it("still returns the bare array with every column", async () => {
      const response = await call();
      const body = (await response.json()) as Record<string, unknown>[];

      expect(response.status).toBe(200);
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(3);
      expect(body[0]).toMatchObject({
        id: "exec_59",
        output: { results: "x".repeat(64) },
        input: { trigger: "manual" },
        executionTrace: ["trigger", "action"],
        totalSteps: 3,
        completedSteps: 2,
        ranVersion: 3,
      });
      expect(response.headers.get("etag")).toBeNull();
    });

    it("keeps the 50-row query, with input and output bounded at the database", () => {
      return call().then(() => {
        const [args] = mockFindMany.mock.calls[0] as [Record<string, unknown>];
        expect(args.limit).toBe(50);
        expect(args.columns).toEqual({ input: false, output: false });
        expect(Object.keys(args.extras as object).sort()).toEqual([
          "input",
          "output",
        ]);
      });
    });

    it("hands an oversized run's marker through unchanged", async () => {
      const marker = {
        _truncated: true,
        originalSize: 184_421_952,
        preview: '{"count":3,"results":[',
      };
      setRows([makeRow(59, { output: marker }), makeRow(58)]);
      const response = await call();
      const body = (await response.json()) as Record<string, unknown>[];
      expect(body[0]?.output).toEqual(marker);
      expect(body[1]?.output).toEqual({ results: "x".repeat(64) });
    });
  });

  describe("view=summary", () => {
    it("returns a page without input, output or executionTrace", async () => {
      const response = await call("?view=summary");
      const body = (await response.json()) as {
        executions: Record<string, unknown>[];
        nextCursor: string | null;
        total: number;
      };

      expect(response.status).toBe(200);
      expect(body.total).toBe(46);
      expect(body.nextCursor).toBeNull();
      expect(body.executions).toHaveLength(3);
      for (const execution of body.executions) {
        expect(execution).not.toHaveProperty("input");
        expect(execution).not.toHaveProperty("output");
        expect(execution).not.toHaveProperty("executionTrace");
        expect(execution).not.toHaveProperty("startedAtKey");
      }
      expect(body.executions[0]).toMatchObject({
        id: "exec_59",
        totalSteps: 3,
        completedSteps: 2,
        ranVersion: 3,
      });
    });

    it("excludes the heavy columns at the query and over-fetches one row", async () => {
      await call("?view=summary");
      const [args] = mockFindMany.mock.calls[0] as [Record<string, unknown>];
      expect(args.columns).toEqual({
        input: false,
        output: false,
        executionTrace: false,
      });
      expect(args.limit).toBe(21);
      expect(args.extras).toHaveProperty("startedAtKey");
    });

    it("renders the cursor key in a fixed format, not the session DateStyle", async () => {
      await call("?view=summary");
      const [args] = mockFindMany.mock.calls[0] as [
        { extras: { startedAtKey: { sql: SQL } } },
      ];
      const { sql } = new PgDialect().sqlToQuery(args.extras.startedAtKey.sql);
      expect(sql).toBe(
        'to_char("workflow_executions"."started_at", \'YYYY-MM-DD HH24:MI:SS.US\')'
      );
    });

    it("counts over a bounded subquery and reports the total as exact up to the bound", async () => {
      await call("?view=summary");
      expect(countLimit).toBe(MAX_COUNTED_RUNS + 1);
      expect(countedSource?.alias).toBe("counted_runs");

      countRows = [{ total: MAX_COUNTED_RUNS + 1 }];
      const capped = await call("?view=summary");
      const body = (await capped.json()) as { total: number };
      expect(body.total).toBe(MAX_COUNTED_RUNS);
    });

    it.each([
      ["1000", 101],
      ["abc", 21],
      ["5", 6],
      ["0", 2],
    ])("clamps limit=%s to a fetch of %i rows", async (limit, fetched) => {
      await call(`?view=summary&limit=${limit}`);
      const [args] = mockFindMany.mock.calls[0] as [Record<string, unknown>];
      expect(args.limit).toBe(fetched);
    });

    it("hands back a cursor for the last returned row when more exist", async () => {
      const rows = makeRows(21);
      setRows(rows);

      const response = await call("?view=summary");
      const body = (await response.json()) as {
        executions: Array<{ id: string }>;
        nextCursor: string | null;
      };

      expect(body.executions).toHaveLength(20);
      expect(body.executions.at(-1)?.id).toBe(rows[19]?.id);
      expect(body.nextCursor).not.toBeNull();
      expect(decodeExecutionsCursor(body.nextCursor as string)).toEqual({
        startedAt: rows[19]?.startedAtKey,
        id: rows[19]?.id,
      });
    });

    it("returns a null cursor on the last page", async () => {
      setRows(makeRows(20));
      const response = await call("?view=summary");
      const body = (await response.json()) as { nextCursor: string | null };
      expect(body.nextCursor).toBeNull();
    });

    it("rejects an invalid cursor before touching the runs", async () => {
      const response = await call("?view=summary&cursor=nope");
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Invalid cursor" });
      expect(mockFindMany).not.toHaveBeenCalled();
      expect(mockFindFirst).not.toHaveBeenCalled();
    });

    it("accepts a cursor it issued and keeps the total unscoped", async () => {
      setRows(makeRows(21));
      const first = (await (await call("?view=summary")).json()) as {
        nextCursor: string;
      };

      mockFindMany.mockClear();
      mockSelect.mockClear();
      setRows(makeRows(2));
      const response = await call(
        `?view=summary&cursor=${encodeURIComponent(first.nextCursor)}`
      );
      const body = (await response.json()) as {
        executions: unknown[];
        total: number;
      };

      expect(response.status).toBe(200);
      expect(body.executions).toHaveLength(2);
      expect(body.total).toBe(46);
      expect(mockFindMany).toHaveBeenCalledTimes(1);
      expect(mockSelect).toHaveBeenCalledWith(
        expect.objectContaining({ total: expect.anything() })
      );
    });

    it("rejects any other view", async () => {
      const response = await call("?view=foo");
      expect(response.status).toBe(400);
      expect(mockFindMany).not.toHaveBeenCalled();
    });

    it("applies the same 404 as the full view when access is refused", async () => {
      mockGetWorkflowAccess.mockResolvedValue({
        hasFullAccess: false,
        isDeleted: false,
      });
      const response = await call("?view=summary");
      expect(response.status).toBe(404);
      expect(mockFindMany).not.toHaveBeenCalled();
    });

    it("applies the same 404 as the full view when the workflow is soft-deleted", async () => {
      mockGetWorkflowAccess.mockResolvedValue({
        hasFullAccess: true,
        isDeleted: true,
      });
      const response = await call("?view=summary");
      expect(response.status).toBe(404);
    });

    it("rejects unauthenticated callers before reading params", async () => {
      mockGetDualAuthContext.mockResolvedValue({
        error: "Unauthorized",
        status: 401,
      });
      const response = await call("?view=summary&cursor=nope");
      expect(response.status).toBe(401);
    });
  });

  describe("ETag revalidation", () => {
    it("tags the summary response and marks it private and revalidated", async () => {
      const response = await call("?view=summary");
      expect(response.headers.get("etag")).toMatch(/^W\/"[A-Za-z0-9_-]+"$/);
      expect(response.headers.get("cache-control")).toBe("private, no-cache");
    });

    it("answers 304 with no body when the page is unchanged", async () => {
      const first = await call("?view=summary");
      const etag = first.headers.get("etag") as string;

      const replay = await call("?view=summary", { "if-none-match": etag });
      expect(replay.status).toBe(304);
      expect(replay.headers.get("etag")).toBe(etag);
      expect(replay.headers.get("cache-control")).toBe("private, no-cache");
      expect(await replay.text()).toBe("");
    });

    it("matches the tag in weak, strong and list forms", async () => {
      const first = await call("?view=summary");
      const etag = first.headers.get("etag") as string;
      const strong = etag.replace(/^W\//, "");

      expect(
        (await call("?view=summary", { "if-none-match": strong })).status
      ).toBe(304);
      expect(
        (await call("?view=summary", { "if-none-match": `"stale", ${etag}` }))
          .status
      ).toBe(304);
      expect(
        (await call("?view=summary", { "if-none-match": "*" })).status
      ).toBe(304);
      expect(
        (await call("?view=summary", { "if-none-match": '"stale"' })).status
      ).toBe(200);
    });

    it("issues a new tag and a full body once a run changes", async () => {
      const first = await call("?view=summary");
      const etag = first.headers.get("etag") as string;

      setRows([makeRow(59, { status: "error" }), makeRow(58), makeRow(57)]);
      const changed = await call("?view=summary", { "if-none-match": etag });
      expect(changed.status).toBe(200);
      expect(changed.headers.get("etag")).not.toBe(etag);
      const body = (await changed.json()) as {
        executions: Array<{ status: string }>;
      };
      expect(body.executions[0]?.status).toBe("error");
    });
  });
});
