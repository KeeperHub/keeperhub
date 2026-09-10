/**
 * Connection test: a read-only GET against the instance's /health endpoint.
 * Succeeds when the server answers 2xx.
 *
 * Connection-test files are reachable from the client-bundled plugin
 * registry, so they cannot import the server-only safe-fetch.ts guard.
 * Egress is covered instead by the always-on assertUrlIsPublic pre-flight in
 * handlePluginTest (lib/db/test-connection.ts), which validates the
 * endpointUrl field before the test runs. Step files route through safeFetch.
 */

// Matches the step: the connection test hits the same user-supplied host.
const FETCH_TIMEOUT_MS = 10_000;

const TRAILING_SLASH_RE = /\/+$/;

export async function testElizaOS(
  credentials: Record<string, string>
): Promise<{ success: boolean; error?: string }> {
  try {
    const rawUrl = credentials.ELIZAOS_ENDPOINT_URL?.trim();
    if (!rawUrl) {
      return {
        success: false,
        error: "ELIZAOS_ENDPOINT_URL is required to test the connection.",
      };
    }

    const baseUrl = rawUrl.replace(TRAILING_SLASH_RE, "");
    const healthUrl = `${baseUrl}/health`;

    const apiKey = credentials.ELIZAOS_API_KEY?.trim();
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    // Lightweight read-only health endpoint to confirm the instance is reachable.
    const response = await fetch(healthUrl, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      return {
        success: false,
        error: `ElizaOS instance returned HTTP ${response.status}. Check the server URL and API key.`,
      };
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
