import { describe, expect, it } from "vitest";

import { curateDbError, isUniqueViolation } from "@/lib/db/errors";

/**
 * Build a chain of `n` plain wrappers ending in an object carrying `code`,
 * so `leafDepth` counts how many `cause` hops separate the outermost error
 * from the SQLSTATE.
 */
function wrapToDepth(leafDepth: number, code: string): unknown {
  let current: unknown = { code };
  for (let i = 0; i < leafDepth; i++) {
    current = { cause: current };
  }
  return current;
}

describe("pgErrorCode chain walk", () => {
  it("finds the SQLSTATE on the thrown error itself", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
  });

  it("finds a SQLSTATE the driver error carries under nested causes", () => {
    // Drizzle wraps the driver error, and a caller that adds its own context
    // wraps that again -- the single `err.cause.code` check this replaced
    // missed the second hop.
    expect(isUniqueViolation(wrapToDepth(1, "23505"))).toBe(true);
    expect(isUniqueViolation(wrapToDepth(4, "23505"))).toBe(true);
  });

  it("stops at the depth bound rather than walking an unbounded chain", () => {
    // MAX_CAUSE_DEPTH inspects five links, so a SQLSTATE on the sixth is
    // deliberately out of reach.
    expect(isUniqueViolation(wrapToDepth(5, "23505"))).toBe(false);
  });

  it("terminates on a self-referential cause chain", () => {
    const looped: { code: string; cause?: unknown } = { code: "not-a-state" };
    looped.cause = looped;
    // The assertion that matters is that this returns at all.
    expect(isUniqueViolation(looped)).toBe(false);
  });

  it("keeps descending past a non-SQLSTATE `code` on an outer wrapper", () => {
    // The regression this guards: `code` is a crowded name. A Node socket
    // error (ECONNRESET), a Node internal (ERR_*) or an app-specific string
    // on the outer error must not shadow the driver's real SQLSTATE, or a
    // genuine duplicate degrades to a generic 500.
    for (const shadow of ["ECONNRESET", "ERR_STREAM_DESTROYED", "db_write"]) {
      const wrapped = { code: shadow, cause: { code: "23505" } };
      expect(isUniqueViolation(wrapped)).toBe(true);
      expect(curateDbError(wrapped)).toEqual({
        message: "This record already exists.",
        status: 409,
      });
    }
  });

  it("prefers the innermost SQLSTATE when a wrapper carries one too", () => {
    // The check this replaced read `cause` before the outer error, so where
    // both links are SQLSTATE-shaped the inner one won. Walking outward-in
    // would invert that silently; the driver error that raised the SQLSTATE is
    // the deepest link and anything above it is a re-thrower.
    const wrapped = { code: "40001", cause: { code: "23505" } };

    expect(isUniqueViolation(wrapped)).toBe(true);
    expect(curateDbError(wrapped)).toEqual({
      message: "This record already exists.",
      status: 409,
    });
  });

  it("ignores a non-SQLSTATE code with no SQLSTATE anywhere in the chain", () => {
    const err = { code: "ECONNRESET", cause: { code: "ETIMEDOUT" } };
    expect(isUniqueViolation(err)).toBe(false);
    expect(curateDbError(err)).toEqual({
      message: "Something went wrong. Please try again.",
      status: 500,
    });
  });

  it("rejects codes that are the wrong shape for a SQLSTATE", () => {
    // Five characters, digits and uppercase letters only.
    for (const code of ["2350", "235055", "23a05", "23-05", ""]) {
      expect(isUniqueViolation({ code })).toBe(false);
    }
    // Right shape, but no Postgres condition class: not a SQLSTATE, and it
    // curates to the generic fallback rather than being kept as one.
    expect(curateDbError({ code: "ABORT" })).toEqual({
      message: "Something went wrong. Please try again.",
      status: 500,
    });
  });

  it("does not mistake a five-character Node errno for a SQLSTATE", () => {
    // EPIPE, EPERM, EBUSY and EROFS are five uppercase characters, so a
    // shape-only check accepts them. None is a Postgres condition class.
    for (const code of ["EPIPE", "EPERM", "EBUSY", "EROFS"]) {
      expect(isUniqueViolation({ code })).toBe(false);
    }
  });

  it("keeps a real SQLSTATE that an EPIPE deeper in the chain would shadow", () => {
    // The regression: `pgErrorCode` keeps the *innermost* match, so a socket
    // errno accepted as a SQLSTATE anywhere below the driver error wins over
    // the driver's own 23505 -- isUniqueViolation answers false for a genuine
    // duplicate and curateDbError falls through to a generic 500.
    const wrapped = {
      code: "23505",
      cause: { code: "EPIPE", cause: { message: "socket hang up" } },
    };

    expect(isUniqueViolation(wrapped)).toBe(true);
    expect(curateDbError(wrapped)).toEqual({
      message: "This record already exists.",
      status: 409,
    });
  });

  it("ignores a non-string code and a missing error", () => {
    expect(isUniqueViolation({ code: 23_505 })).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation("23505")).toBe(false);
  });
});

describe("curateDbError", () => {
  it("maps known SQLSTATEs to their curated defaults", () => {
    expect(curateDbError({ code: "23503" })).toEqual({
      message: "A related record is missing or still in use.",
      status: 409,
    });
    expect(curateDbError({ code: "23502" })).toEqual({
      message: "A required field is missing.",
      status: 400,
    });
    expect(curateDbError({ code: "23514" })).toEqual({
      message: "One or more values are invalid.",
      status: 400,
    });
  });

  it("lets a caller override the copy for a specific code", () => {
    expect(
      curateDbError(
        { code: "23505" },
        { messages: { "23505": "That workflow name is taken." } }
      )
    ).toEqual({ message: "That workflow name is taken.", status: 409 });
  });

  it("uses the fallback copy for an unknown code and keeps status 500", () => {
    expect(
      curateDbError({ code: "40001" }, { fallback: "Could not save. Retry." })
    ).toEqual({ message: "Could not save. Retry.", status: 500 });
  });

  it("never returns the raw driver message", () => {
    const driverError = new Error(
      'duplicate key value violates unique constraint "workflow_executions_pkey"'
    );
    Object.assign(driverError, { code: "23505" });
    const curated = curateDbError(driverError);
    expect(curated.message).not.toContain("workflow_executions_pkey");
    expect(curated.message).toBe("This record already exists.");
  });
});
