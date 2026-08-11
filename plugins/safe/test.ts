import type { SafeCredentials } from "./credentials";

export async function testSafe(
  credentials: SafeCredentials
): Promise<{ success: boolean; error?: string }> {
  const apiKey = credentials.apiKey;

  if (!apiKey) {
    return { success: false, error: "Safe API key is required" };
  }

  try {
    const response = await fetch(
      "https://api.safe.global/tx-service/eth/api/v1/about/",
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      }
    );

    if (!response.ok) {
      return {
        success: false,
        error: `Safe API returned HTTP ${response.status}`,
      };
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: `Failed to connect to Safe API: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
