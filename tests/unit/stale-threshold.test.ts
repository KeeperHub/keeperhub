import { afterEach, describe, expect, it, vi } from "vitest";

const logWarn = vi.hoisted(() => vi.fn());
vi.mock("@/lib/logging", () => ({ logWarn }));

import { staleExecutionThresholdMinutes } from "@/lib/reaper/stale-threshold";

describe("staleExecutionThresholdMinutes", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    logWarn.mockClear();
  });

  it.each([
    [undefined, 30, false],
    ["", 30, false],
    ["60", 60, false],
    ["1", 1, false],
    ["1440", 1440, false],
    ["2880", 1440, true],
    ["0", 30, true],
    ["-5", 30, true],
    ["1e9", 30, true],
    ["30abc", 30, true],
    ["abc", 30, true],
  ])("reads %s as %i minutes (warns: %s)", (value, minutes, warns) => {
    vi.stubEnv("STALE_EXECUTION_THRESHOLD_MINUTES", value);
    expect(staleExecutionThresholdMinutes()).toBe(minutes);
    expect(logWarn).toHaveBeenCalledTimes(warns ? 1 : 0);
  });

  it("warns once for the same bad value", () => {
    vi.stubEnv("STALE_EXECUTION_THRESHOLD_MINUTES", "9999");
    expect(staleExecutionThresholdMinutes()).toBe(1440);
    expect(staleExecutionThresholdMinutes()).toBe(1440);
    expect(logWarn).toHaveBeenCalledTimes(1);
  });
});
