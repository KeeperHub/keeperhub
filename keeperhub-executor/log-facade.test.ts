import { DrizzleQueryError } from "drizzle-orm/errors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const savedConsole = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error,
  debug: console.debug,
};

let written: string[] = [];

function lastPayload(): { msg: string; err?: Record<string, unknown> } {
  return JSON.parse(written.at(-1) ?? "{}");
}

describe("log-facade", () => {
  beforeEach(async () => {
    written = [];
    // The facade binds the console methods it finds at import time as its
    // writers, so install a capturing writer first and then load it fresh.
    console.error = (line: string): void => {
      written.push(line);
    };
    vi.resetModules();
    await import("./log-facade");
  });

  afterEach(() => {
    Object.assign(console, savedConsole);
  });

  it("adds the cause chain of a wrapped driver error to err", () => {
    const driverError = Object.assign(
      new AggregateError(
        [
          Object.assign(new Error("connect ETIMEDOUT 192.0.2.10:5432"), {
            code: "ETIMEDOUT",
            address: "192.0.2.10",
            port: 5432,
          }),
        ],
        ""
      ),
      { code: "ETIMEDOUT" }
    );
    const error = new DrizzleQueryError(
      'select "id" from "workflows"',
      [],
      driverError
    );

    console.error("[Executor] Failed to process workflow wf-1:", error);

    const payload = lastPayload();
    expect(payload.err?.message).toMatch(/^Failed query: select "id"/);
    expect(payload.err?.cause).toBe(
      "AggregateError ETIMEDOUT [ETIMEDOUT 192.0.2.10:5432]"
    );
  });

  it("leaves cause out of err when the error has none", () => {
    console.error("[Executor] Failed:", new Error("plain failure"));

    const payload = lastPayload();
    expect(payload.err?.message).toBe("plain failure");
    expect(payload.err).not.toHaveProperty("cause");
  });
});
