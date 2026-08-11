/**
 * Unit tests for getDailyCapMicros env-var parsing.
 *
 * Fix-pack-3 N-4: BigInt() accepts hex-prefixed strings, so without a
 * decimal-only regex guard, a typo like `AGENTIC_WALLET_DAILY_CAP_MICROS=0x10`
 * would silently cap the entire feature at 16 micros/day.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Pure function — import directly with no mocks.
import {
  DEFAULT_DAILY_CAP_MICROS,
  getDailyCapMicros,
} from "@/lib/agentic-wallet/daily-spend";

const ENV_VAR = "AGENTIC_WALLET_DAILY_CAP_MICROS";

describe("getDailyCapMicros", () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[ENV_VAR];
    delete process.env[ENV_VAR];
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env[ENV_VAR];
    } else {
      process.env[ENV_VAR] = original;
    }
  });

  it("returns the default when env var is unset", () => {
    expect(getDailyCapMicros()).toBe(DEFAULT_DAILY_CAP_MICROS);
  });

  it("returns the default for empty string", () => {
    process.env[ENV_VAR] = "";
    expect(getDailyCapMicros()).toBe(DEFAULT_DAILY_CAP_MICROS);
  });

  it("parses a valid decimal integer", () => {
    process.env[ENV_VAR] = "500000000";
    expect(getDailyCapMicros()).toBe(BigInt(500_000_000));
  });

  it("rejects hex-prefixed strings and returns default", () => {
    // Without the regex guard BigInt("0x10") parses to 16 micros and
    // silently throttles every /sign for the day.
    process.env[ENV_VAR] = "0x10";
    expect(getDailyCapMicros()).toBe(DEFAULT_DAILY_CAP_MICROS);
  });

  it("rejects signed integers and returns default", () => {
    process.env[ENV_VAR] = "-1";
    expect(getDailyCapMicros()).toBe(DEFAULT_DAILY_CAP_MICROS);
  });

  it("rejects scientific notation and returns default", () => {
    process.env[ENV_VAR] = "1e6";
    expect(getDailyCapMicros()).toBe(DEFAULT_DAILY_CAP_MICROS);
  });

  it("rejects floats and returns default", () => {
    process.env[ENV_VAR] = "3.14";
    expect(getDailyCapMicros()).toBe(DEFAULT_DAILY_CAP_MICROS);
  });

  it("rejects whitespace and returns default", () => {
    process.env[ENV_VAR] = " 100 ";
    expect(getDailyCapMicros()).toBe(DEFAULT_DAILY_CAP_MICROS);
  });

  it("rejects zero and returns default", () => {
    process.env[ENV_VAR] = "0";
    expect(getDailyCapMicros()).toBe(DEFAULT_DAILY_CAP_MICROS);
  });

  it("rejects garbage strings and returns default", () => {
    process.env[ENV_VAR] = "not-a-number";
    expect(getDailyCapMicros()).toBe(DEFAULT_DAILY_CAP_MICROS);
  });
});
