export type AuthErrorBody = {
  error?: string;
  detail?: string;
  code?: string;
};

/** Machine-readable auth error code (KEEP-489 envelope or legacy `code`). */
export function authErrorCode(body: AuthErrorBody): string | undefined {
  // Prefer legacy `code` when present: staging bodies carry both fields with
  // `error` as prose and `code` as the slug. New envelopes have no `code`, so
  // this falls through to `error` (the slug).
  return body.code ?? body.error;
}

/** Human-facing message from an auth error response body. */
export function authErrorMessage(
  body: AuthErrorBody,
  fallback: string
): string {
  return body.detail ?? body.error ?? fallback;
}
