/**
 * Get headers for E2E test requests.
 * Includes X-Test-API-Key for auth rate limit bypass and
 * Cloudflare Access headers for deployed environments.
 */
export function getTestHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (process.env.TEST_API_KEY) {
    headers["X-Test-API-Key"] = process.env.TEST_API_KEY;
  }
  if (process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
    headers["CF-Access-Client-Id"] = process.env.CF_ACCESS_CLIENT_ID;
    headers["CF-Access-Client-Secret"] = process.env.CF_ACCESS_CLIENT_SECRET;
  }
  return headers;
}

/**
 * Fetch wrapper that automatically includes test headers.
 * Use this for all E2E vitest requests to ensure rate limit bypass
 * and Cloudflare Access work in deployed environments.
 */
export function testFetch(
  url: string,
  options?: RequestInit
): Promise<Response> {
  const testHeaders = getTestHeaders();
  return fetch(url, {
    ...options,
    headers: {
      ...testHeaders,
      ...options?.headers,
    },
  });
}
