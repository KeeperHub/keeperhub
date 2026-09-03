/**
 * getLastFinishedExecutionAgeSecondsFromDb() feeds the fast "zero finished
 * executions" alert, so what it counts as finished is load-bearing. The
 * finalizer stamps completed_at on `unconfirmed` rows even though they have not
 * finished, so those rows must be excluded or a pipeline producing nothing but
 * unconfirmed rows would keep reading as healthy.
 *
 * The predicate is asserted on the SQL the query would run, rendered through
 * PgDialect, because the exclusion is invisible in the returned value.
 */

import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

let capturedWhere: SQL | undefined;
let queryRows: unknown[] = [];

vi.mock("@/lib/db", () => {
  const select = () => ({
    from: () => ({
      where: (condition: SQL) => {
        capturedWhere = condition;
        return Promise.resolve(queryRows);
      },
    }),
  });
  return { db: { select }, metricsDb: { select } };
});

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "database" },
  logSystemWarn: vi.fn(),
}));

import { getLastFinishedExecutionAgeSecondsFromDb } from "@/lib/metrics/db-metrics";

const dialect = new PgDialect();

beforeEach(() => {
  capturedWhere = undefined;
  queryRows = [{ ageSeconds: 12 }];
});

describe("getLastFinishedExecutionAgeSecondsFromDb", () => {
  it("excludes unconfirmed rows from the finished set", async () => {
    await getLastFinishedExecutionAgeSecondsFromDb();

    if (!capturedWhere) {
      throw new Error("expected the query to carry a where clause");
    }
    const { sql, params } = dialect.sqlToQuery(capturedWhere);
    expect(sql).toContain('"workflow_executions"."completed_at" IS NOT NULL');
    expect(sql).toMatch(/"workflow_executions"\."status" <> \$\d+/);
    expect(params).toEqual(["unconfirmed"]);
  });

  it("returns the age when the query answers", async () => {
    expect(await getLastFinishedExecutionAgeSecondsFromDb()).toBe(12);
  });

  it("returns null when no row has finished yet", async () => {
    queryRows = [{ ageSeconds: null }];

    expect(await getLastFinishedExecutionAgeSecondsFromDb()).toBeNull();
  });
});
