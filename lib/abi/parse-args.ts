// Pure helpers for parsing serialized ABI function arg arrays out of stored
// workflow config. Kept dependency-free (no React, no DOM) so they can be
// shared by the args-list and abi-function-args field renderers and tested
// in isolation.

// Coerce a single arg value into the shape the renderers expect:
//   - arrays stay arrays            (ArrayInputField)
//   - non-array objects stay objects (TupleInputField)
//   - null/undefined become ""       (so the input renders empty)
//   - everything else becomes String(item)
//
// Without this, a stored JSON like "[1]" surfaces a number that flows into
// TemplateBadgeInput and throws on internalValue.match() (KEEP-367).
export function coerceAbiArgValue(item: unknown): unknown {
  if (Array.isArray(item)) {
    return item;
  }
  if (typeof item === "object" && item !== null) {
    return item;
  }
  if (item === undefined || item === null) {
    return "";
  }
  return String(item);
}

// Parse a JSON-serialized arg array (`"[1, \"0xabc\"]"`) into the shape
// AbiFunctionArgsField expects. Returns [] for empty / invalid / non-array
// input so callers don't need to guard.
export function parseAbiFunctionArgs(value: string): unknown[] {
  if (!value || value.trim() === "") {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(coerceAbiArgValue) : [];
  } catch {
    return [];
  }
}
