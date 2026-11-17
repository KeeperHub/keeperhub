const BLOCKED_FIELDS: ReadonlySet<string> = new Set([
  "constructor",
  "__proto__",
  "prototype",
]);

/**
 * True when `key` is an own field of `value`. Template paths only ever address
 * a step's own output data, never inherited members such as `constructor`.
 */
export function hasOwnField(value: unknown, key: string): boolean {
  if (value === null || value === undefined || BLOCKED_FIELDS.has(key)) {
    return false;
  }
  return Object.hasOwn(new Object(value), key);
}

/** Read an own field of `value`, or undefined when it is missing or blocked. */
export function readOwnField(value: unknown, key: string): unknown {
  if (!hasOwnField(value, key)) {
    return;
  }
  return (new Object(value) as Record<string, unknown>)[key];
}
