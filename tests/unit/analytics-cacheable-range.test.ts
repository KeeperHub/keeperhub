import { describe, expect, it, vi } from "vitest";

// queries.ts is a server-only module that also pulls in the db client; stub
// both so the pure isCacheableRange predicate can be imported under vitest
// without resolving the server-only marker or opening a DB connection.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));

import { isCacheableRange } from "@/lib/analytics/queries";

describe("isCacheableRange", () => {
  it("caches named ranges with no custom window", () => {
    expect(isCacheableRange("1h")).toBe(true);
    expect(isCacheableRange("24h")).toBe(true);
    expect(isCacheableRange("7d")).toBe(true);
    expect(isCacheableRange("30d")).toBe(true);
  });

  it("never caches the custom range", () => {
    expect(isCacheableRange("custom")).toBe(false);
    expect(isCacheableRange("custom", "2026-01-01", "2026-02-01")).toBe(false);
  });

  it("does not cache a named range carrying a custom start or end", () => {
    // The unbounded key dimension is the caller-supplied window, so any
    // start/end present must bypass the cache regardless of the range label.
    expect(isCacheableRange("7d", "2026-01-01", undefined)).toBe(false);
    expect(isCacheableRange("7d", undefined, "2026-02-01")).toBe(false);
  });
});
