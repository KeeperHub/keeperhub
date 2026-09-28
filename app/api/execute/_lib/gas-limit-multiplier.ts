/**
 * Direct-execution cores take `gasLimitMultiplier` as a string: a legacy
 * multiplier ("1.5") or the JSON `mode`/`value` shape `parseGasLimitConfig`
 * already understands. JSON bodies can send a number or the maxGasLimit
 * object; stringify those here so the execute routes do not drop a shape
 * the cores already parse.
 */
export function readGasLimitMultiplier(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return JSON.stringify(value);
  }
  return undefined;
}
