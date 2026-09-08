import { describe, expect, it } from "vitest";
import { getDatabaseErrorMessage } from "@/lib/db/connection-utils";

const REFUSED =
  "Connection refused. Please check your database URL and ensure the database is running.";
const TIMED_OUT =
  "Connection timed out. Please check your database host and network settings.";
const GENERIC =
  "Database connection failed. Please verify your connection settings.";

/** Mimic drizzle: a "Failed query" wrapper whose `cause` is the driver error. */
function drizzleWrapped(
  causeMessage: string,
  props: Record<string, unknown> = {}
): Error {
  const top = new Error("Failed query: SELECT 1") as Error & {
    cause?: unknown;
  };
  top.cause = Object.assign(new Error(causeMessage), props);
  return top;
}

describe("getDatabaseErrorMessage", () => {
  it("maps a top-level ECONNREFUSED (direct postgres.js path)", () => {
    const error = Object.assign(
      new Error("connect ECONNREFUSED 1.2.3.4:5432"),
      {
        code: "ECONNREFUSED",
      }
    );
    expect(getDatabaseErrorMessage(error)).toBe(REFUSED);
  });

  it("maps a top-level CONNECT_TIMEOUT (the incident error) to a timeout message", () => {
    const error = Object.assign(
      new Error("write CONNECT_TIMEOUT 1.2.3.4:5432"),
      { code: "CONNECT_TIMEOUT" }
    );
    expect(getDatabaseErrorMessage(error)).toBe(TIMED_OUT);
  });

  it("maps a drizzle-wrapped ECONNREFUSED (code on cause)", () => {
    const error = drizzleWrapped("connect ECONNREFUSED 1.2.3.4:5432", {
      code: "ECONNREFUSED",
    });
    expect(getDatabaseErrorMessage(error)).toBe(REFUSED);
  });

  it("maps a drizzle-wrapped CONNECT_TIMEOUT (code on cause)", () => {
    const error = drizzleWrapped("write CONNECT_TIMEOUT 1.2.3.4:5432", {
      code: "CONNECT_TIMEOUT",
    });
    expect(getDatabaseErrorMessage(error)).toBe(TIMED_OUT);
  });

  it("returns the formatted Postgres query error (severity) and does not misclassify it", () => {
    const error = Object.assign(new Error('relation "x" does not exist'), {
      severity: "ERROR",
      code: "42P01",
    });
    const message = getDatabaseErrorMessage(error);
    expect(message).toContain("does not exist");
    expect(message).toContain("42P01");
  });

  it("falls back to the generic message and does not leak raw text", () => {
    const error = drizzleWrapped(
      "opaque failure for postgres://user:secret@host/db"
    );
    const message = getDatabaseErrorMessage(error);
    expect(message).toBe(GENERIC);
    expect(message).not.toContain("secret");
  });
});
