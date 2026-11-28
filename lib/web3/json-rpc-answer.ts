/**
 * What one endpoint did with our signed bytes: took them (or already had
 * them), answered and turned them down, or left it unknown.
 */
export type Delivery = "accepted" | "refused" | "unknown";

/** A JSON-RPC error as an endpoint sent it; nothing in it is trusted. */
export type JsonRpcError = { code?: unknown; message?: unknown };

type JsonRpcAnswer = { result?: unknown; error?: JsonRpcError };

const JSON_RPC_INTERNAL_ERROR = -32_603;
const UNKNOWN_OUTCOME_PATTERN =
  /internal error|timed out|timeout|deadline exceeded/i;
// "I already hold this": a duplicate transaction (geth, Erigon, Nethermind,
// Parity) or bundle. Whole words only, so "unknown transaction type" is not one.
const DUPLICATE_PATTERN =
  /\balready known\b|\balreadyknown\b|\balready imported\b|\bknown transaction\b|\bduplicate bundle\b/i;

/** The endpoint says it already holds this transaction or bundle. */
export function isDuplicateMessage(message: string): boolean {
  return DUPLICATE_PATTERN.test(message);
}

/**
 * A JSON-RPC answer object, or undefined for non-JSON or a non-object.
 * `error` is set only for an object or a non-empty string (its message); a
 * falsy, numeric or array `error` leaves the result to decide.
 */
export function parseJsonRpcAnswer(text: string): JsonRpcAnswer | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return;
  }
  if (!isPlainObject(value)) {
    return;
  }
  const error = rpcErrorOf(value.error);
  return error === undefined
    ? { result: value.result }
    : { result: value.result, error };
}

/**
 * What an error answer proves. A duplicate means the endpoint holds it; an
 * internal error or a timeout can follow a forward, so it proves nothing.
 */
export function classifyRpcError(error: JsonRpcError): Delivery {
  const message = typeof error.message === "string" ? error.message : "";
  if (isDuplicateMessage(message)) {
    return "accepted";
  }
  // Some endpoints send the code as a string.
  const code =
    typeof error.code === "string" && error.code.trim() !== ""
      ? Number(error.code)
      : error.code;
  return code === JSON_RPC_INTERNAL_ERROR ||
    UNKNOWN_OUTCOME_PATTERN.test(message)
    ? "unknown"
    : "refused";
}

function rpcErrorOf(raw: unknown): JsonRpcError | undefined {
  if (isPlainObject(raw)) {
    return raw;
  }
  return typeof raw === "string" && raw.trim() !== ""
    ? { message: raw }
    : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
