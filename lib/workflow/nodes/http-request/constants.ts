/**
 * Shared HTTP Request node constants.
 *
 * Deliberately free of `server-only` and any Node imports so both the client
 * config editor and the server-only step worker can import the SAME default.
 * The editor only persists `httpMethod` when the user changes the dropdown, so
 * the runtime needs the identical fallback to avoid silently defaulting to GET
 * (which then rejects a configured body). Keep all three consumers -- the
 * editor, the worker, and the SDK codegen -- pointed at these constants so the
 * default and the option list never drift apart again.
 */

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

export const DEFAULT_HTTP_METHOD: HttpMethod = "POST";
