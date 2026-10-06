/** Single source of the `API call failed:` text every MCP server throws; the shape is documented in docs/getting-started/agent.md. */

const TOO_MANY_REQUESTS = 429;

/** Null when the header is absent or carries no usable non-negative delay. */
export function parseRetryAfterSeconds(header: string | null): number | null {
  if (!header) {
    return null;
  }
  const asNumber = Number(header);
  if (Number.isFinite(asNumber)) {
    return asNumber >= 0 ? Math.ceil(asNumber) : null;
  }
  const asDate = Date.parse(header);
  if (!Number.isNaN(asDate)) {
    return Math.max(1, Math.ceil((asDate - Date.now()) / 1000));
  }
  return null;
}

/** Response fields the error text is built from, so callers can pass a Response. */
type ApiErrorResponse = {
  status: number;
  statusText: string;
  headers: { get: (name: string) => string | null };
};

export function buildApiCallFailedError(
  response: ApiErrorResponse,
  bodyText: string
): Error {
  let statusLabel = response.statusText
    ? `${response.status} ${response.statusText}`
    : String(response.status);
  if (response.status === TOO_MANY_REQUESTS) {
    const seconds = parseRetryAfterSeconds(response.headers.get("Retry-After"));
    if (seconds !== null) {
      statusLabel += ` (Retry-After: ${seconds}s)`;
    }
  }
  return new Error(`API call failed: ${statusLabel} - ${bodyText}`);
}
