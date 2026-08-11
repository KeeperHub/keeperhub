/**
 * JSON-safe value serialization primitives shared by the Solana payload
 * builders. Extracted from the EVM event-tracker's event-serializer so the
 * Solana service has no EVM/ethers dependency: every leaf value becomes a
 * string so nothing is lost across the SQS boundary (the executor spreads
 * `triggerData` verbatim).
 */

export type SerializedValue =
  | string
  | SerializedValue[]
  | { [key: string]: SerializedArg };

export interface SerializedArg {
  value: SerializedValue;
  type: string;
}

export function serializePrimitive(value: unknown): string {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "number") {
    return value.toString();
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "boolean") {
    return value.toString();
  }
  if (value && typeof value === "object") {
    const maybeStringifiable = value as { toString?: () => string };
    if (typeof maybeStringifiable.toString === "function") {
      return maybeStringifiable.toString();
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}
