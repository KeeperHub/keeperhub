/**
 * Curate Postgres errors surfaced through Drizzle into safe, user-facing
 * messages. Raw driver errors (which embed SQL fragments and column names)
 * must never reach the client -- always run a caught DB error through
 * `curateDbError` and return the curated message instead of `error.message`.
 *
 * Drizzle wraps the driver error, so the SQLSTATE code can live either on the
 * thrown error or somewhere down its `cause` chain. Walk the chain, and take
 * only a value that actually is a SQLSTATE -- see `isSqlState`.
 */

export type CuratedDbError = { message: string; status: number };

/**
 * How far down the `cause` chain to look for the SQLSTATE. Drizzle wraps the
 * driver error, and a caller that adds its own context wraps that again, so a
 * single `err.cause.code` check misses real constraint violations. Bounded so
 * a self-referential chain cannot spin.
 */
const MAX_CAUSE_DEPTH = 5;

/**
 * A Postgres SQLSTATE: exactly five characters, digits and uppercase letters.
 * Checked rather than accepting the first string `code` found, because `code`
 * is a crowded name on errors -- Node sets `ECONNRESET` on a socket error and
 * `ERR_*` on its own, and app errors carry their own codes. An outer wrapper
 * bearing one of those would otherwise shadow the driver's real SQLSTATE
 * further down the chain, turning a `23505` into a generic 500 and making
 * `isUniqueViolation` answer false for a genuine duplicate.
 */
const SQLSTATE_SHAPE_RE = /^([0-9A-Z]{2})[0-9A-Z]{3}$/u;

/**
 * The condition classes Postgres actually defines (Appendix A, "PostgreSQL
 * Error Codes"). The five-character shape alone does not separate a SQLSTATE
 * from a Node errno: `EPIPE`, `EPERM`, `EBUSY` and `EROFS` are all five
 * uppercase characters and would pass it, which is exactly the shadowing this
 * check exists to stop -- a driver error whose cause chain carries `EPIPE`
 * would be kept as the innermost "SQLSTATE" and hide a real `23505` above it.
 *
 * No defined class begins with `E`, so matching the class rejects every one of
 * those, and rejects five-character app codes (`ABORT`) as a bonus. The list
 * is stable: a class has not been added to Postgres in many releases, and an
 * unlisted one would only ever fall through to the generic curated error the
 * unknown-code path already returns.
 */
const SQLSTATE_CLASSES = new Set(
  (
    "00 01 02 03 08 09 0A 0B 0F 0L 0P 0Z " +
    "20 21 22 23 24 25 26 27 28 2B 2D 2F " +
    "34 38 39 3B 3D 3F 40 42 44 " +
    "53 54 55 57 58 72 F0 HV P0 XX"
  ).split(" ")
);

function isSqlState(code: string): boolean {
  const sqlStateClass = SQLSTATE_SHAPE_RE.exec(code)?.[1];
  return sqlStateClass !== undefined && SQLSTATE_CLASSES.has(sqlStateClass);
}

/**
 * The innermost SQLSTATE in the chain wins, not the first one reached.
 *
 * The code this function replaced read `e.cause?.code ?? e.code` -- cause
 * before wrapper, one hop. Walking outward-in would silently invert that
 * wherever a wrapper and its cause both carry SQLSTATE-shaped codes: the
 * wrapper's would start winning. The driver error that actually raised the
 * SQLSTATE is the deepest link, and anything above it is a re-thrower, so
 * keeping the innermost preserves the old precedence at any depth.
 */
function pgErrorCode(err: unknown): string | undefined {
  let current: unknown = err;
  let innermost: string | undefined;
  for (
    let depth = 0;
    depth < MAX_CAUSE_DEPTH && current && typeof current === "object";
    depth++
  ) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && isSqlState(code)) {
      innermost = code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return innermost;
}

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = "23505";

/**
 * True when a caught DB error is a Postgres unique/primary-key violation.
 *
 * Callers that can answer a duplicate meaningfully -- a 409 naming the field
 * that collided -- need to tell it apart from a generic failure before
 * reaching for `curateDbError`, whose message is deliberately generic.
 */
export function isUniqueViolation(err: unknown): boolean {
  return pgErrorCode(err) === UNIQUE_VIOLATION;
}

/** Default curated response per Postgres SQLSTATE code. */
const PG_CODE_DEFAULTS: Record<string, CuratedDbError> = {
  [UNIQUE_VIOLATION]: { message: "This record already exists.", status: 409 },
  "23503": {
    message: "A related record is missing or still in use.",
    status: 409,
  },
  "23502": { message: "A required field is missing.", status: 400 },
  "23514": { message: "One or more values are invalid.", status: 400 },
};

const GENERIC_DB_ERROR: CuratedDbError = {
  message: "Something went wrong. Please try again.",
  status: 500,
};

/**
 * Map a caught DB error to a curated `{ message, status }`. Known SQLSTATE
 * codes get a friendly default; anything else falls back to a generic message.
 * Pass `messages` to override the copy for a specific code (e.g. a
 * domain-specific duplicate message) and `fallback` for the generic case.
 * The raw error message is never returned.
 */
export function curateDbError(
  err: unknown,
  options?: {
    messages?: Record<string, string>;
    fallback?: string;
  }
): CuratedDbError {
  const code = pgErrorCode(err);
  const known = code ? PG_CODE_DEFAULTS[code] : undefined;
  if (known) {
    return {
      message: (code ? options?.messages?.[code] : undefined) ?? known.message,
      status: known.status,
    };
  }
  return {
    message: options?.fallback ?? GENERIC_DB_ERROR.message,
    status: GENERIC_DB_ERROR.status,
  };
}
