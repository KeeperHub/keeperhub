import { assertUrlIsPublic, SsrfBlockedError } from "@/lib/safe-fetch";

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

    // Validate that the server URL is not an SSRF target
    await assertUrlIsPublic(healthUrl);

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
    });

    if (!response.ok) {
      return {
        success: false,
        error: `ElizaOS instance returned HTTP ${response.status}. Check the server URL and API key.`,
      };
    }

    return { success: true };
  } catch (error) {
    if (error instanceof SsrfBlockedError) {
      return {
        success: false,
        error: `ElizaOS server URL is not allowed: ${error.message}`,
      };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
