import { stripTrailingSlashes } from "@/lib/utils/url";

const DEFAULT_PREDGE_SIGNAL_URL = "https://api.predge.io";

export async function testPredge(
  credentials: Record<string, string>
): Promise<{ success: boolean; error?: string }> {
  try {
    const rawUrl =
      credentials.PREDGE_SIGNAL_URL?.trim() || DEFAULT_PREDGE_SIGNAL_URL;
    const baseUrl = stripTrailingSlashes(rawUrl);

    // Read-only: the published keyset confirms the signal service is reachable
    // and is serving Predge signing keys.
    const response = await fetch(`${baseUrl}/.well-known/predge-keys.json`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      return {
        success: false,
        error: `Predge signal service returned HTTP ${response.status}. Check the signal URL.`,
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
