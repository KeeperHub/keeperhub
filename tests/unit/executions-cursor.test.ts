import { describe, expect, it } from "vitest";
import {
  decodeExecutionsCursor,
  encodeExecutionsCursor,
} from "@/lib/workflow/executions-cursor";

const URL_SAFE_RE = /^[A-Za-z0-9_-]+$/;

describe("executions cursor", () => {
  it("round-trips a microsecond timestamp and id unchanged", () => {
    const cursor = {
      startedAt: "2026-09-23 00:03:07.272123",
      id: "rjfg6x8x5e6avtgpz67z0",
    };
    expect(decodeExecutionsCursor(encodeExecutionsCursor(cursor))).toEqual(
      cursor
    );
  });

  it("round-trips a timestamp without a fractional part", () => {
    const cursor = { startedAt: "2026-09-23 00:03:07", id: "abc" };
    expect(decodeExecutionsCursor(encodeExecutionsCursor(cursor))).toEqual(
      cursor
    );
  });

  it("produces a URL-safe token", () => {
    const token = encodeExecutionsCursor({
      startedAt: "2026-09-23 00:03:07.272123",
      id: "id-with_odd~chars",
    });
    expect(token).toMatch(URL_SAFE_RE);
  });

  it("distinguishes runs that share a start timestamp", () => {
    const startedAt = "2026-09-23 00:03:07.272123";
    const a = encodeExecutionsCursor({ startedAt, id: "a" });
    const b = encodeExecutionsCursor({ startedAt, id: "b" });
    expect(a).not.toBe(b);
    expect(decodeExecutionsCursor(a)?.id).toBe("a");
    expect(decodeExecutionsCursor(b)?.id).toBe("b");
  });

  it.each([
    ["garbage", "not-a-cursor!!"],
    [
      "valid base64 of a non-array",
      Buffer.from('{"a":1}').toString("base64url"),
    ],
    [
      "wrong arity",
      Buffer.from('["2026-09-23 00:03:07"]').toString("base64url"),
    ],
    [
      "non-string id",
      Buffer.from('["2026-09-23 00:03:07", 5]').toString("base64url"),
    ],
    [
      "empty id",
      Buffer.from('["2026-09-23 00:03:07", ""]').toString("base64url"),
    ],
    [
      "ISO timestamp instead of the Postgres text form",
      Buffer.from('["2026-09-23T00:03:07.272Z", "id"]').toString("base64url"),
    ],
    [
      "timestamp with trailing sql",
      Buffer.from('["2026-09-23 00:03:07 or 1=1", "id"]').toString("base64url"),
    ],
    [
      "well-formed but impossible fields, which Postgres would reject",
      Buffer.from('["2026-13-45 99:99:99", "id"]').toString("base64url"),
    ],
    [
      "a day the month does not have",
      Buffer.from('["2026-02-30 00:00:00", "id"]').toString("base64url"),
    ],
    [
      "hour 24",
      Buffer.from('["2026-09-23 24:00:00", "id"]').toString("base64url"),
    ],
    ["empty string", ""],
  ])("rejects %s", (_label, raw) => {
    expect(decodeExecutionsCursor(raw)).toBeNull();
  });

  it("accepts the last instant of a leap day and of a year", () => {
    for (const startedAt of [
      "2028-02-29 23:59:59.999999",
      "2026-12-31 23:59:59",
    ]) {
      expect(
        decodeExecutionsCursor(encodeExecutionsCursor({ startedAt, id: "x" }))
      ).toEqual({ startedAt, id: "x" });
    }
  });
});
