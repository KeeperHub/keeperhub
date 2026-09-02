// Top-level fields on POST /api/workflow/{id}/execute used to be
// silently discarded unless nested under "input" -- {"amount": "1"} bound
// nothing, only {"input": {"amount": "1"}} did, and the resulting
// "Unresolved template reference" error pointed at the workflow definition,
// giving no hint the request body shape was wrong.
//
// The rule this file enforces: input fields belong nested under "input".
// A body with no "input" key and only unrecognized top-level fields is
// accepted for now -- those fields are bound as input, matching the shape
// the shipped kh CLI's `workflow_execute` tool already sends (see
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

const RECOGNIZED_TOP_LEVEL_KEYS = new Set(["input", "executionId"]);
const DEPRECATION_WARNING =
  'Top-level input fields are deprecated; nest them under "input". ' +
  "This request was accepted, but unrecognized top-level fields will be " +
  "rejected with a 400 in a future release.";

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
      deprecationWarning?: string;
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
    const strayInput: Record<string, unknown> = {};
    for (const key of unrecognizedKeys) {
      strayInput[key] = rawParsed[key];
    }
    return {
      ok: true,
      input: strayInput,
      rawParsed,
      deprecationWarning: DEPRECATION_WARNING,
    };
  }

  const input: Record<string, unknown> = hasInputKey
    ? (rawParsed.input as Record<string, unknown>)
    : {};

  return { ok: true, input, rawParsed };
}
