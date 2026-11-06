import { describe, expect, it } from "vitest";
import { parseEndTime } from "@/lib/notifications/failure-alerts/constants";

describe("parseEndTime", () => {
  it("reads a time with no zone as UTC", () => {
    expect(parseEndTime("2026-11-07T00:22:38")?.toISOString()).toBe(
      "2026-11-07T00:22:38.000Z"
    );
  });

  it("keeps an explicit zone", () => {
    expect(parseEndTime("2026-11-07T10:00:00+14:00")?.toISOString()).toBe(
      "2026-11-06T20:00:00.000Z"
    );
    expect(parseEndTime("2026-11-07T10:00:00.000Z")?.toISOString()).toBe(
      "2026-11-07T10:00:00.000Z"
    );
  });

  it("refuses anything that is not an ISO date-time", () => {
    for (const raw of [
      "Nov 8 2026",
      "2026-11-08",
      "tomorrow",
      "",
      "2026-13-40T99:99",
    ]) {
      expect(parseEndTime(raw)).toBeNull();
    }
  });
});
