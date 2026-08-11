/**
 * Recursively convert non-JSON-serializable values to safe representations.
 *
 * Blockchain data from ethers.js can contain types that JSON.stringify
 * cannot handle, causing JSONB column writes to throw. This function
 * converts them to JSON-safe equivalents:
 *
 * - BigInt -> string (token amounts, block numbers, gas values)
 * - Uint8Array/Buffer -> hex string prefixed with 0x
 * - Map -> plain object
 * - Set -> array
 * - Date -> ISO string
 * - undefined -> null (explicit, avoids silent drops in arrays)
 * - Functions -> omitted
 * - Circular references -> "[Circular]"
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: type-dispatch over 10+ JS types is inherently branchy
export function toJsonSafe(obj: unknown, seen = new WeakSet()): unknown {
  if (obj === null || obj === undefined) {
    return null;
  }

  if (typeof obj === "bigint") {
    return obj.toString();
  }

  if (typeof obj === "function") {
    return undefined;
  }

  if (
    typeof obj === "string" ||
    typeof obj === "number" ||
    typeof obj === "boolean"
  ) {
    return obj;
  }

  if (obj instanceof Date) {
    return obj.toISOString();
  }

  if (obj instanceof Uint8Array || Buffer.isBuffer(obj)) {
    return `0x${Buffer.from(obj).toString("hex")}`;
  }

  if (typeof obj !== "object") {
    return String(obj);
  }

  // Circular reference guard
  if (seen.has(obj)) {
    return "[Circular]";
  }
  seen.add(obj);

  if (obj instanceof Map) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of obj) {
      result[String(key)] = toJsonSafe(value, seen);
    }
    return result;
  }

  if (obj instanceof Set) {
    return [...obj].map((item) => toJsonSafe(item, seen));
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => toJsonSafe(item, seen));
  }

  // Plain object (includes ethers.Result which has numeric + named keys)
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const safe = toJsonSafe(value, seen);
    if (safe !== undefined) {
      result[key] = safe;
    }
  }
  return result;
}
