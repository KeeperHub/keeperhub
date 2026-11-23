/**
 * Shared value-shaping helpers for the Data plugin steps.
 *
 * No "use step" directive: this module is imported by several step files, so
 * it must stay outside the workflow-function bundle.
 */

const PATH_SEPARATOR = ".";
const ARRAY_INDEX_PATTERN = /^\d+$/;

/**
 * Read a dotted path out of an arbitrary value. Returns undefined the moment a
 * segment is missing instead of throwing, so a partial upstream fetch degrades
 * gracefully rather than aborting the run.
 */
export function resolvePath(source: unknown, path: string): unknown {
  return resolveSegments(source, splitPath(path));
}

/** A dotted path as segments; an empty path reads the source itself. */
export function splitPath(path: string): string[] {
  const trimmed = path.trim();
  return trimmed === "" ? [] : trimmed.split(PATH_SEPARATOR);
}

/** resolvePath for a path already split, so a loop splits it once. */
export function resolveSegments(source: unknown, segments: string[]): unknown {
  let current: unknown = source;
  for (const segment of segments) {
    if (current === null || current === undefined) {
      return;
    }
    if (Array.isArray(current)) {
      if (!ARRAY_INDEX_PATTERN.test(segment)) {
        return;
      }
      current = current[Number(segment)];
      continue;
    }
    // Own keys only, so a path like constructor or __proto__ reads nothing.
    if (typeof current !== "object" || !Object.hasOwn(current, segment)) {
      return;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Parse a config value that carries JSON. Template rendering hands us a string;
 * MCP callers can hand us the already-parsed value.
 */
export function parseJsonValue(raw: unknown, fieldName: string): unknown {
  if (typeof raw !== "string") {
    return raw;
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new Error(`${fieldName} is required.`);
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error(
      `${fieldName} is not valid JSON. Reference an upstream node output, e.g. {{@node1:Label.result}}.`
    );
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value)
  );
}
