import { timingSafeEqual } from "node:crypto";

/**
 * Header carrying the load-test bypass token.
 *
 * Introduced for the mandatory-MFA enrollment bypass (proxy.ts); it now also
 * clears the signup Turnstile challenge (lib/auth.ts) for the same trusted
 * load-test / e2e traffic. The name is retained because the k6 and Playwright
 * clients already send this header on every request.
 */
export const LOAD_TEST_BYPASS_HEADER = "x-load-test-mfa-bypass";

/**
 * True iff the request carries a valid load-test bypass token.
 *
 * One token clears the anti-abuse gates that a headless client cannot satisfy:
 * the mandatory-MFA enrollment gate (proxy.ts) and the signup Turnstile
 * challenge (lib/auth.ts). A real Turnstile challenge cannot be solved by a
 * headless k6 / API client, so this is the only way automated signup can run
 * against an enforcing environment such as staging.
 *
 * Active only when LOAD_TEST_BYPASS_TOKEN is set, compared in constant time.
 * Production never provisions the token, so this always returns false there.
 */
export function hasValidLoadTestBypass(request: Request): boolean {
  const token = process.env.LOAD_TEST_BYPASS_TOKEN;
  if (!token) {
    return false;
  }
  const provided = request.headers.get(LOAD_TEST_BYPASS_HEADER);
  if (!provided) {
    return false;
  }
  const providedBuf = Buffer.from(provided, "utf8");
  const expectedBuf = Buffer.from(token, "utf8");
  if (providedBuf.length !== expectedBuf.length) {
    return false;
  }
  return timingSafeEqual(providedBuf, expectedBuf);
}
