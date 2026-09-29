import { scrubRpcUrls } from "@/lib/rpc/scrub-rpc-urls";

/**
 * How far to follow an error's `cause` chain before giving up.
 *
 * Five modules walk that chain to find a driver-level code that a wrapper has
 * buried (lib/db/errors.ts, lib/security/backstop-capture.ts,
 * lib/security/session-backstop.ts, lib/workflow/nodes/database-query/step.ts,
 * lib/workflow/retry-policy.ts), and each had picked the same bound
 * independently. One of them even documents that it mirrors another.
 *
 * Note: database-query/step.ts compares with `<=` where the other four use
 * `<`, so it inspects one more level than they do. That difference predates
 * this constant being shared and is left as-is rather than quietly changed on
 * a retry path.
 */

export const MAX_CAUSE_DEPTH = 5;

const MAX_MESSAGE_CHARS = 300;
const MAX_AGGREGATE_ENTRIES = 5;

type ErrorLike = {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  address?: unknown;
  port?: unknown;
  errors?: unknown;
  cause?: unknown;
};

function asErrorLike(value: unknown): ErrorLike | undefined {
  return typeof value === "object" && value !== null
    ? (value as ErrorLike)
    : undefined;
}

function firstLine(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const line = value.split("\n", 1)[0].trim();
  return line.length > MAX_MESSAGE_CHARS
    ? `${line.slice(0, MAX_MESSAGE_CHARS)}...`
    : line;
}

function codeOf(error: ErrorLike): string {
  return typeof error.code === "string" || typeof error.code === "number"
    ? String(error.code)
    : "";
}

// One entry of an AggregateError, e.g. "ETIMEDOUT 192.0.2.10:5432".
function describeAggregateEntry(value: unknown): string {
  const entry = asErrorLike(value);
  if (!entry) {
    return String(value);
  }
  let target = typeof entry.address === "string" ? entry.address : "";
  if (
    target &&
    (typeof entry.port === "number" || typeof entry.port === "string")
  ) {
    target = `${target}:${entry.port}`;
  }
  const summary = [codeOf(entry), target].filter(Boolean).join(" ");
  return summary || firstLine(entry.message);
}

function describeLevel(value: unknown): string {
  const error = asErrorLike(value);
  if (!error) {
    return firstLine(String(value));
  }
  const name = typeof error.name === "string" ? error.name : "Error";
  const code = codeOf(error);
  const message = firstLine(error.message);
  let text = code ? `${name} ${code}` : name;
  if (message) {
    text = `${text}: ${message}`;
  }
  if (Array.isArray(error.errors) && error.errors.length > 0) {
    const entries = error.errors
      .slice(0, MAX_AGGREGATE_ENTRIES)
      .map(describeAggregateEntry);
    text = `${text} [${entries.join(" | ")}]`;
  }
  return text;
}

/**
 * One-line summary of an error's `cause` chain, for logs.
 *
 * Wrappers such as drizzle's DrizzleQueryError keep the driver error on
 * `cause`, so the top-level message ("Failed query: ...") hides the actual
 * failure. This walks up to MAX_CAUSE_DEPTH causes, joins them with " <- ",
 * and lists the entries of any AggregateError (the per-address connect
 * failures). Returns "" when there is no cause. RPC URLs are scrubbed.
 */
export function describeErrorCauses(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>([error]);
  let current = asErrorLike(error)?.cause;
  while (
    current !== undefined &&
    current !== null &&
    parts.length < MAX_CAUSE_DEPTH &&
    !seen.has(current)
  ) {
    seen.add(current);
    parts.push(describeLevel(current));
    current = asErrorLike(current)?.cause;
  }
  return scrubRpcUrls(parts.join(" <- "));
}
