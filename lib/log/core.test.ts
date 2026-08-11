import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitLogLine, getLogLevel, rawConsole, shouldLog } from "./core";

// rawConsole is exported `as const` (readonly keys); alias to a mutable record
// so vi.spyOn type-checks. It is the same underlying object emitLogLine reads.
const raw = rawConsole as unknown as Record<
  "debug" | "info" | "warn" | "error",
  (line: string) => void
>;

function capture(level: "debug" | "info" | "warn" | "error") {
  return vi.spyOn(raw, level).mockImplementation(() => {
    // swallow output during tests
  });
}

describe("log core: emitLogLine", () => {
  const originalLevel = process.env.LOG_LEVEL;

  beforeEach(() => {
    process.env.LOG_LEVEL = "debug";
  });

  afterEach(() => {
    process.env.LOG_LEVEL = originalLevel;
    vi.restoreAllMocks();
  });

  it("emits one single-line JSON object with level, ts and payload merged in", () => {
    const spy = capture("info");

    emitLogLine("info", { msg: "hello", a: 1 });

    expect(spy).toHaveBeenCalledTimes(1);
    const line = spy.mock.calls[0][0];
    // The whole line must be valid JSON (no prefix) so Loki `| json` works.
    expect(line.startsWith("{")).toBe(true);
    expect(line).not.toContain("\n");
    const parsed = JSON.parse(line);
    expect(parsed).toMatchObject({ level: "info", msg: "hello", a: 1 });
    expect(typeof parsed.ts).toBe("string");
    expect(Number.isNaN(Date.parse(parsed.ts))).toBe(false);
  });

  it("routes each level to the matching console method and stamps level", () => {
    for (const level of ["debug", "info", "warn", "error"] as const) {
      const spy = capture(level);
      emitLogLine(level, { msg: level });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(JSON.parse(spy.mock.calls[0][0]).level).toBe(level);
    }
  });

  it("drops lines below the configured LOG_LEVEL", () => {
    process.env.LOG_LEVEL = "warn";
    const info = capture("info");
    const error = capture("error");

    emitLogLine("info", { msg: "dropped" });
    emitLogLine("error", { msg: "kept" });

    expect(info).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("silent disables all output", () => {
    process.env.LOG_LEVEL = "silent";
    const error = capture("error");

    emitLogLine("error", { msg: "x" });

    expect(error).not.toHaveBeenCalled();
  });
});

describe("log core: level resolution", () => {
  const originalLevel = process.env.LOG_LEVEL;

  afterEach(() => {
    process.env.LOG_LEVEL = originalLevel;
  });

  it("defaults to info when LOG_LEVEL is unset or unknown", () => {
    process.env.LOG_LEVEL = "bogus";
    expect(getLogLevel()).toBe("info");
    expect(shouldLog("info")).toBe(true);
    expect(shouldLog("debug")).toBe(false);
    expect(shouldLog("error")).toBe(true);
  });
});
