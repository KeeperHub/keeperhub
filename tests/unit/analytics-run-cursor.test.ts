import { describe, expect, it } from "vitest";
import {
  cursorAfter,
  type KeyedRun,
  mergeKeyedRuns,
  parseRunCursor,
} from "@/lib/analytics/run-cursor";
import type { RunSource, UnifiedRun } from "@/lib/analytics/types";

function keyed(source: RunSource, id: string, at: string): KeyedRun {
  return { at, run: { id, source } as UnifiedRun };
}

describe("run cursor", () => {
  it("round-trips the time to the microsecond, the source and the id", () => {
    const row = keyed(
      "notification",
      "abc_DEF-123",
      "2026-10-01T10:00:00.123456"
    );
    expect(parseRunCursor(cursorAfter(row))).toEqual({
      at: "2026-10-01T10:00:00.123456",
      source: "notification",
      id: "abc_DEF-123",
    });
  });

  it("still reads the plain ISO cursor the listing minted before", () => {
    expect(parseRunCursor("2026-09-01T12:34:56.789Z")).toEqual({
      at: "2026-09-01T12:34:56.789",
      source: null,
      id: null,
    });
  });

  it("refuses anything the listing never minted", () => {
    const bad = (text: string): string =>
      Buffer.from(text, "utf8").toString("base64url");
    for (const raw of [
      null,
      "",
      "abc",
      "1",
      "2026-13-45T00:00:00.000Z",
      "0000-01-01T00:00:00.000Z",
      bad("2026-10-01T10:00:00.123456~telepathy~id"),
      bad("2026-10-01T10:00:00.123~workflow~id"),
      bad("2026-02-31T10:00:00.123456~workflow~id"),
      bad("2026-10-01T10:00:00.123456~workflow~id with space"),
      bad("2026-10-01T10:00:00.123456~workflow"),
    ]) {
      expect(parseRunCursor(raw), String(raw)).toBeUndefined();
    }
  });
});

describe("mergeKeyedRuns", () => {
  it("orders by time, then source, keeping each source's own id order", () => {
    const t1 = "2026-10-01T10:00:00.000002";
    const t0 = "2026-10-01T10:00:00.000001";
    const merged = mergeKeyedRuns([
      [keyed("workflow", "w", t0)],
      [keyed("direct", "d", t1)],
      // Already in Postgres's order for this source: kept, not re-sorted.
      [keyed("notification", "n_b", t1), keyed("notification", "n_a", t1)],
    ]);
    expect(merged.map((row) => row.run.id)).toEqual(["d", "n_b", "n_a", "w"]);
  });
});
