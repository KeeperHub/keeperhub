// KEEP-1931: top-level fields on POST /api/workflow/{id}/execute used to be
// silently discarded unless nested under "input" -- {"amount": "1"} bound
// nothing, only {"input": {"amount": "1"}} did, and the resulting
// "Unresolved template reference" error pointed at the workflow definition,
// giving no hint the request body shape was wrong.
//
// The issue proposed two options: auto-nest top-level fields as input, or
// reject unrecognized top-level keys with a 400 hint. suisuss's accept
// comment states a preference for the latter: accepting both shapes means
// two ways to say the same thing, and the missing error -- not the missing
// leniency -- was the actual gap. So this rejects, it does not guess: any
// top-level key other than this route's own recognized keys (input,
// executionId) is a 400 naming the field and pointing at the "input"
// nesting, and a present-but-non-object "input" is rejected the same way
// rather than silently coerced.

const RECOGNIZED_TOP_LEVEL_KEYS = new Set(["input", "executionId"]);

export type ExecuteBody = {
  input?: unknown;
  executionId?: string;
  [key: string]: unknown;
};

export type ResolvedExecutionInput =
  | {
      ok: true;
      input: Record<string, unknown>;
      executionId?: string;
      rawParsed: ExecuteBody;
    }
  | { ok: false; error: string; field: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses the raw request body and resolves the workflow input, per the
 * KEEP-1931 rules above. Never throws: an invalid or non-object JSON body
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

  const unrecognizedKeys = Object.keys(rawParsed).filter(
    (key) => !RECOGNIZED_TOP_LEVEL_KEYS.has(key)
  );
  if (unrecognizedKeys.length > 0) {
    const plural = unrecognizedKeys.length > 1 ? "s" : "";
    return {
      ok: false,
      error:
        `Unknown top-level field${plural} (${unrecognizedKeys.join(", ")}) -- ` +
        'did you mean to nest them under "input"?',
      field: unrecognizedKeys[0],
    };
  }

  if ("input" in rawParsed && !isRecord(rawParsed.input)) {
    return {
      ok: false,
      error: '"input" must be an object when present.',
      field: "input",
    };
  }

  const input: Record<string, unknown> = isRecord(rawParsed.input)
    ? rawParsed.input
    : {};

  return { ok: true, input, executionId: rawParsed.executionId, rawParsed };
}