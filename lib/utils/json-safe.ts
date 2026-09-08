/**
 * Recursively convert non-JSON-serializable values to safe representations
 * before they are written to a JSONB column.
 *
 * Blockchain data from viem/ethers can contain types that JSON.stringify
 * cannot handle, which makes drizzle-orm's PgJsonb.mapToDriverValue throw
 * (e.g. "Do not know how to serialize a BigInt"). This normalizes them:
 *
 * - BigInt -> string (token amounts, block numbers, gas values)
 * - Uint8Array/Buffer -> hex string prefixed with 0x
 * - Map -> plain object
 * - Set -> array
 * - Date -> ISO string
 * - undefined -> null (explicit, avoids silent drops in arrays)
 * - Functions -> omitted
 * - Circular references -> "[Circular]"
 *
 * Only ancestor cycles are treated as circular; the same object reachable via
 * two sibling paths (a shared, non-circular reference) is serialized in full.
 */
export function toJsonSafe(obj: unknown, seen = new WeakSet()): unknown {
  if (obj === null || obj === undefined) {
    return null;
  }

  if (typeof obj === "bigint") {
    return obj.toString();
  }

  if (typeof obj === "function") {
    return;
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

  if (seen.has(obj)) {
    return "[Circular]";
  }
  seen.add(obj);

  if (obj instanceof Map) {
    const mapResult: Record<string, unknown> = {};
    for (const [key, value] of obj) {
      mapResult[String(key)] = toJsonSafe(value, seen);
    }
    seen.delete(obj);
    return mapResult;
  }

  if (obj instanceof Set) {
    const setResult = [...obj].map((item) => toJsonSafe(item, seen));
    seen.delete(obj);
    return setResult;
  }

  if (Array.isArray(obj)) {
    const arrayResult = obj.map((item) => toJsonSafe(item, seen));
    seen.delete(obj);
    return arrayResult;
  }

  // Plain object (includes ethers.Result, which has numeric + named keys)
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const safe = toJsonSafe(value, seen);
    if (safe !== undefined) {
      result[key] = safe;
    }
  }
  seen.delete(obj);
  return result;
}
