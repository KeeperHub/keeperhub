/**
 * Curate Postgres errors surfaced through Drizzle into safe, user-facing
 * messages. Raw driver errors (which embed SQL fragments and column names)
 * must never reach the client -- always run a caught DB error through
 * `curateDbError` and return the curated message instead of `error.message`.
 *
 * Drizzle wraps the driver error, so the SQLSTATE code can live either on the
 * thrown error or on its `cause`. Check both.
 */

export type CuratedDbError = { message: string; status: number };

/**
 * How far down the `cause` chain to look for the SQLSTATE. Drizzle wraps the
 * driver error, and a caller that adds its own context wraps that again, so a
 * single `err.cause.code` check misses real constraint violations. Bounded so
 * a self-referential chain cannot spin.
 */
const MAX_CAUSE_DEPTH = 5;

function pgErrorCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (
    let depth = 0;
    depth < MAX_CAUSE_DEPTH && current && typeof current === "object";
    depth++
  ) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") {
      return code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
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
