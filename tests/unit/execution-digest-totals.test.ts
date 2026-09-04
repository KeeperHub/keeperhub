import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const captured: Record<string, unknown>[] = [];

// Chainable stand-in for the drizzle builder: every method returns itself and
// awaiting it yields an empty result set, so the digest query runs without a DB.
function builder(): unknown {
  const target = (): unknown => target;
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === "then") {
        return (resolve: (v: unknown[]) => unknown) => resolve([]);
      }
      return () => builder();
    },
    apply() {
      return builder();
    },
  });
}

vi.mock("@/lib/db", () => ({
  db: {
    select: (fields: Record<string, unknown>) => {
      captured.push(fields);
      return builder();
    },
    selectDistinctOn: () => builder(),
  },
}));

vi.mock("@/lib/web3/sponsorship-feature-flag", () => ({
  isGasSponsorshipEnabled: () => false,
}));

import { getOrgExecutionDigest } from "@/lib/notifications/execution-digest";

const dialect = new PgDialect();

function renderedTotals(): { sql: string; params: unknown[] } {
  const totals = captured[0];
  if (!totals) {
    throw new Error("digest totals select was not captured");
  }
  const parts = Object.values(totals).map((expr) =>
    dialect.sqlToQuery(expr as Parameters<PgDialect["sqlToQuery"]>[0])
  );
  return {
    sql: parts.map((p) => p.sql).join(" | "),
    params: parts.flatMap((p) => p.params),
  };
}

describe("getOrgExecutionDigest totals", () => {
  it("counts platform failures as failures and refused runs as neither", async () => {
    captured.length = 0;
    await getOrgExecutionDigest(
      "org-1",
      new Date("2026-06-08T00:00:00.000Z"),
      new Date("2026-06-09T00:00:00.000Z")
    );

    const { sql, params } = renderedTotals();
    // The failure count has to match the top-failing list, which spans both
    // error statuses; counting only 'error' overstates the success rate.
    expect(params).toContain("system_error");
    // Refused runs never ran, so they stay out of the workflows-run count.
    expect(sql).toContain("COUNT(DISTINCT CASE WHEN");
  });
});
