import { stripTrailingSlashes } from "@/lib/utils/url";

const DEFAULT_BLOCKSCOUT_API_URL = "https://eth.blockscout.com";
export async function testBlockscout(
  credentials: Record<string, string>
): Promise<{ success: boolean; error?: string }> {
  try {
    const rawUrl =
      credentials.BLOCKSCOUT_API_URL?.trim() || DEFAULT_BLOCKSCOUT_API_URL;
    const baseUrl = stripTrailingSlashes(rawUrl);
    const apiKey = credentials.BLOCKSCOUT_API_KEY?.trim();

    const url = new URL(`${baseUrl}/api/v2/stats`);
    if (apiKey) {
      url.searchParams.set("apikey", apiKey);
    }

    // Lightweight read-only endpoint to confirm the instance is reachable.
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      return {
        success: false,
        error: `Blockscout instance returned HTTP ${response.status}. Check the API URL.`,
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
