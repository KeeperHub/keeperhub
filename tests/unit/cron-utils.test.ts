// KEEP-581: direct unit coverage of parseIntervalSeconds. The
// schedule-service tests exercise the parser transitively via
// extractScheduleConfig, which couples the assertions to a downstream
// function's behaviour ("falls back to cron when ..."). These tests
// pin the parser's own contract -- absent, garbage, negative, zero,
// sub-floor (throws), at-floor (accepts), above-floor (accepts) --
// so the parser can be refactored without breaking unrelated test
// names if the caller's fallback semantics ever change.

import { describe, expect, it } from "vitest";
import {
  IntervalTooSmallError,
  MIN_INTERVAL_SECONDS,
  parseIntervalSeconds,
} from "@/lib/cron-utils";

describe("parseIntervalSeconds", () => {
  describe("absence -> null", () => {
    it("returns null for undefined", () => {
      expect(parseIntervalSeconds(undefined)).toBeNull();
    });

    it("returns null for null", () => {
      expect(parseIntervalSeconds(null)).toBeNull();
    });

    it("returns null for empty string", () => {
      expect(parseIntervalSeconds("")).toBeNull();
    });
  });

  describe("unusable input -> null", () => {
    it("returns null for non-numeric strings", () => {
      expect(parseIntervalSeconds("abc")).toBeNull();
    });

    it("returns null for NaN", () => {
      expect(parseIntervalSeconds(Number.NaN)).toBeNull();
    });

    it("returns null for Infinity", () => {
      expect(parseIntervalSeconds(Number.POSITIVE_INFINITY)).toBeNull();
    });

    it("returns null for zero", () => {
      expect(parseIntervalSeconds(0)).toBeNull();
    });

    it("returns null for negative numbers", () => {
      expect(parseIntervalSeconds(-10)).toBeNull();
    });

    it("returns null for objects", () => {
      expect(parseIntervalSeconds({})).toBeNull();
    });
  });

  describe("sub-floor -> throws IntervalTooSmallError", () => {
    it("throws for 30 (well below the floor)", () => {
      expect(() => parseIntervalSeconds(30)).toThrow(IntervalTooSmallError);
    });

    it("throws for 59 (one below the floor)", () => {
      expect(() => parseIntervalSeconds(59)).toThrow(IntervalTooSmallError);
    });

    it('throws for a numeric string at the boundary ("59")', () => {
      expect(() => parseIntervalSeconds("59")).toThrow(IntervalTooSmallError);
    });

    it("throws for a fractional value that floors below 60 (59.9)", () => {
      // KEEP-581: floor happens before the < MIN check, so 59.9 -> 59 -> throw.
      expect(() => parseIntervalSeconds(59.9)).toThrow(IntervalTooSmallError);
    });

    it("populates raw and minimum on the thrown error", () => {
      try {
        parseIntervalSeconds(45);
        expect.fail("expected IntervalTooSmallError to be thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(IntervalTooSmallError);
        if (error instanceof IntervalTooSmallError) {
          expect(error.raw).toBe(45);
          expect(error.minimum).toBe(MIN_INTERVAL_SECONDS);
        }
      }
    });
  });

  describe("at and above floor -> floored integer", () => {
    it("accepts exactly the floor (60)", () => {
      expect(parseIntervalSeconds(60)).toBe(60);
    });

    it('accepts a numeric string at the floor ("60")', () => {
      expect(parseIntervalSeconds("60")).toBe(60);
    });

    it("accepts values above the floor (3300)", () => {
      expect(parseIntervalSeconds(3300)).toBe(3300);
    });

    it("floors fractional values that land >= floor (60.7 -> 60)", () => {
      expect(parseIntervalSeconds(60.7)).toBe(60);
    });

    it("accepts large values (1 day in seconds)", () => {
      expect(parseIntervalSeconds(86_400)).toBe(86_400);
    });
  });
});
