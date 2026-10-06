/**
 * One parse for Solidity array inputs, shared by every consumer of a stored
 * protocol config: the editor renderer, the save-time validator, the
 * protocol read/write steps, the direct-execute route and the calldata
 * fixtures.
 *
 * It is a read-time normaliser on purpose. Array inputs were rendered as
 * plain text fields before they had a structured editor, so a saved config
 * can still hold a bare scalar or a comma-separated list where an array is
 * now expected. Repairing those on read keeps a workflow that nobody opens
 * valid and executable without a stored-data migration, and a value that
 * cannot be interpreted is kept as a single item rather than dropped.
 */

const ARRAY_TYPE_SUFFIX_RE = /\[\d*]$/;
const WHOLE_FIELD_TEMPLATE_RE = /^\{\{[^{}]+}}$/;
// Types whose values can never contain a comma, so splitting one is safe.
const COMMA_SAFE_ITEM_TYPE_RE = /^(?:address|bool|(?:u?int|bytes)\d*)$/;

export function isSolidityArrayType(
  solidityType: string | undefined
): solidityType is string {
  return solidityType?.endsWith("]") === true;
}

/** `uint256[]` -> `uint256`, `tuple[2]` -> `tuple`. */
export function solidityArrayItemType(solidityType: string): string {
  return solidityType.replace(ARRAY_TYPE_SUFFIX_RE, "");
}

/** True when the whole value is a single reference and nothing else. */
export function isWholeFieldTemplate(value: unknown): value is string {
  return (
    typeof value === "string" && WHOLE_FIELD_TEMPLATE_RE.test(value.trim())
  );
}

function splitCommaSeparated(
  trimmed: string,
  itemType: string
): string[] | undefined {
  if (!(trimmed.includes(",") && COMMA_SAFE_ITEM_TYPE_RE.test(itemType))) {
    return;
  }
  const items = trimmed
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function normalizeStoredString(trimmed: string, solidityType: string): unknown {
  // A reference covering the whole field resolves to the array itself, so it
  // stays a bare string; wrapping it would splice the rendered array inside
  // the quotes of a one-element array.
  if (isWholeFieldTemplate(trimmed)) {
    return trimmed;
  }

  const itemType = solidityArrayItemType(solidityType);

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    if (itemType === "tuple" && typeof parsed === "object" && parsed !== null) {
      return [parsed];
    }
  } catch {
    const split = splitCommaSeparated(trimmed, itemType);
    if (split) {
      return split;
    }
  }

  return [trimmed];
}

/**
 * Coerce a stored config value for a Solidity array input into an array.
 * Values for non-array inputs, and values that are already arrays, are
 * returned untouched.
 */
export function normalizeProtocolArrayValue(
  raw: unknown,
  solidityType: string | undefined
): unknown {
  if (!isSolidityArrayType(solidityType)) {
    return raw;
  }
  if (Array.isArray(raw) || raw === undefined || raw === null) {
    return raw;
  }
  if (typeof raw !== "string") {
    return [raw];
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    return raw;
  }
  return normalizeStoredString(trimmed, solidityType);
}

/**
 * Serialise editor rows back into a config value. A lone whole-field
 * reference is stored bare so it still resolves to an array at run time.
 */
export function serializeProtocolArrayValue(items: unknown[]): string {
  const [only] = items;
  if (items.length === 1 && isWholeFieldTemplate(only)) {
    return only.trim();
  }
  return JSON.stringify(items);
}
