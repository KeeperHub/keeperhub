import "server-only";

/**
 * Serialize a single ABI-decoded argument value to a plain string suitable
 * for template references and output fields.
 *
 * Used by decode-calldata, query-transactions, and trace-decode to produce a
 * consistent string representation of any value ethers can return from
 * parseTransaction / parseLog.
 */
export function serializeArg(value: unknown): string {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null || value === undefined) {
    return "";
  }
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === "bigint" ? v.toString() : v
  );
}
