/**
 * Parse the dry-run flag from a POST /api/execute/* request body.
 *
 * Strict-boolean only:
 *   - body.simulate === true  -> simulate
 *   - body.simulate === false -> broadcast
 *   - body.simulate omitted   -> broadcast
 *   - anything else           -> 400 with a structured error
 *
 * Coercing strings or numbers to a boolean is intentionally not
 * supported: an execute endpoint must have exactly one shape per
 * input, and silently falling through to "spend real funds" because
 * a caller mistyped `"true"` instead of `true` is unsafe.
 */

type ParsedSimulateFlag =
  | { ok: true; simulate: boolean }
  | { ok: false; error: string };

export function parseSimulateFlag(
  body: Record<string, unknown>
): ParsedSimulateFlag {
  const value = body.simulate;
  if (value === undefined) {
    return { ok: true, simulate: false };
  }
  if (typeof value !== "boolean") {
    return {
      ok: false,
      error:
        "`simulate` must be a boolean (true or false). Strings, numbers, and other types are rejected.",
    };
  }
  return { ok: true, simulate: value };
}
