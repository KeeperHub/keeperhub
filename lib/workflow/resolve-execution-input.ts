// Top-level fields on POST /api/workflow/{id}/execute used to be
// silently discarded unless nested under "input" -- {"amount": "1"} bound
// nothing, only {"input": {"amount": "1"}} did, and the resulting
// "Unresolved template reference" error pointed at the workflow definition,
// giving no hint the request body shape was wrong.
//
// The rule this file enforces: input fields belong nested under "input".
// A body with no "input" key and only unrecognized top-level fields is
// accepted for now -- *every* top-level field is bound as input, matching
// the shape the shipped kh CLI's `workflow_execute` tool already sends (see
// KeeperHub/cli cmd/serve/tools.go) -- but the response carries a
// deprecation warning, since silently accepting two shapes for the same
// thing is the wrong long-term state; a caller that never reads the
// warning is no worse off than before this fix, since their fields now
// actually bind instead of being silently dropped. A body that mixes a
// nested "input" object with stray top-level fields is genuine ambiguity
// about which the caller meant -- no shipped caller does this today, so
// it's rejected outright rather than given the same grace period. A
// present "input" that is neither null nor a plain object (e.g. a string
// or array) is rejected the same way; null is treated as equivalent to
// "input" being absent, matching the route's original `?? {}` behavior for
// that value.
//
// `executionId` is an envelope field only in the nested shape. In the bare
// shape there is no envelope -- the caller sent a flat bag of workflow input
// -- so a field that happens to be named `executionId` is the caller's data
// and is bound like any other. Treating it as an envelope field there would
// both silently drop it from the input the workflow sees and feed a
// caller-controlled string to the execution lookup in the route, which is
// how a data field turns into a way to address someone else's execution row.

const RECOGNIZED_TOP_LEVEL_KEYS = new Set(["input", "executionId"]);

/**
 * Deprecation of the bare top-level shape, expressed with the headers this
 * API already publishes in `app/api/openapi/route.ts` (`x-api-versioning`):
 * RFC 9745 `Deprecation`, RFC 8594 `Sunset`, and a `Link` at the migration
 * note. A bespoke header would not be read by a client written against that
 * published contract.
 *
 * Both dates are fixed constants rather than computed from the current time,
 * so every response carries the same pair for the life of the deprecation.
 * `tests/unit/resolve-execution-input.test.ts` asserts the gap between them
 * stays at or above the documented 180-day minimum notice.
 */
export const TOP_LEVEL_INPUT_DEPRECATION = {
  /** The date the deprecation took effect. */
  effective: "2026-09-03",
  /** Earliest date the bare shape may start returning 400. */
  sunset: "2027-03-02",
  link: "https://docs.keeperhub.com/api/workflows",
} as const;

function toHttpDate(isoDay: string): string {
  return new Date(`${isoDay}T00:00:00Z`).toUTCString();
}

/**
 * Header pairs announcing the bare-shape deprecation. Applied to every
 * response the route returns after resolution, not just the one that starts a
 * run: a caller retrying with an Idempotency-Key otherwise sees the notice
 * once and never again, which is the opposite of what a migration window is
 * for.
 */
export function topLevelInputDeprecationHeaders(): [string, string][] {
  return [
    ["Deprecation", toHttpDate(TOP_LEVEL_INPUT_DEPRECATION.effective)],
    ["Sunset", toHttpDate(TOP_LEVEL_INPUT_DEPRECATION.sunset)],
    ["Link", `<${TOP_LEVEL_INPUT_DEPRECATION.link}>; rel="deprecation"`],
  ];
}

export type ExecuteBody = {
  input?: unknown;
  executionId?: string;
  [key: string]: unknown;
};

export type ResolvedExecutionInput =
  | {
      ok: true;
      input: Record<string, unknown>;
      rawParsed: ExecuteBody;
      /**
       * The envelope `executionId`, when the body carried one *as an envelope
       * field*. Undefined for the bare shape, where a key of that name is the
       * caller's own input data. The route must use this rather than reading
       * `rawParsed.executionId`, which cannot tell the two apart.
       */
      executionId?: string;
      deprecated?: boolean;
    }
  | { ok: false; error: string; field: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses the raw request body and resolves the workflow input, per the rules
 * above. Never throws: an invalid or non-object JSON body
 * resolves to an empty input, matching the route's original "missing or
 * invalid body becomes empty input" contract.
 */
export function resolveExecutionInput(rawBody: string): ResolvedExecutionInput {
  let rawParsed: ExecuteBody = {};
  if (rawBody) {
    try {
      const parsed: unknown = JSON.parse(rawBody);
      rawParsed = isRecord(parsed) ? (parsed as ExecuteBody) : {};
    } catch {
      rawParsed = {};
    }
  }

  const hasInputKey = "input" in rawParsed && rawParsed.input !== null;
  const unrecognizedKeys = Object.keys(rawParsed).filter(
    (key) => !RECOGNIZED_TOP_LEVEL_KEYS.has(key)
  );
  const hasStrayTopLevel = unrecognizedKeys.length > 0;

  if (hasInputKey && hasStrayTopLevel) {
    const plural = unrecognizedKeys.length > 1 ? "s" : "";
    return {
      ok: false,
      error:
        `Ambiguous execution body: both a nested "input" object and ` +
        `top-level field${plural} (${unrecognizedKeys.join(", ")}) were sent. ` +
        'Send input fields nested under "input", not both ways at once.',
      field: "input",
    };
  }

  if (hasInputKey && !isRecord(rawParsed.input)) {
    return {
      ok: false,
      error: '"input" must be an object when present.',
      field: "input",
    };
  }

  if (hasStrayTopLevel) {
    // Spread rather than key-by-key assignment, for two reasons.
    //
    // Every top-level key binds, including one named `executionId`: there is
    // no envelope in this shape, so that key is the caller's data. Copying
    // only the unrecognized keys would drop it from the input the workflow
    // receives while leaving the route to read it as an envelope field.
    //
    // And rest-destructuring creates own properties. `strayInput[key] = ...`
    // is an assignment, so a `__proto__` key -- which `JSON.parse` does
    // produce as an own property -- would reach `Object.prototype`'s setter
    // instead of landing on the object, leaving an input whose
    // `Object.keys()` is empty while a read by name still resolved through
    // the prototype.
    //
    // `input` is the one key held back. Reaching here with an `input` key at
    // all means it was null, and a null `input` is the caller writing
    // envelope syntax -- "I am sending no nested input" -- rather than a data
    // field that happens to be called input. `executionId` is the opposite:
    // it only means anything as an envelope field when an envelope exists.
    const { input: _nullEnvelope, ...bareInput } = rawParsed;
    return {
      ok: true,
      input: bareInput,
      rawParsed,
      deprecated: true,
    };
  }

  const input: Record<string, unknown> = hasInputKey
    ? { ...(rawParsed.input as Record<string, unknown>) }
    : {};

  return {
    ok: true,
    input,
    rawParsed,
    executionId:
      typeof rawParsed.executionId === "string"
        ? rawParsed.executionId
        : undefined,
  };
}
