import type { PythCredentials } from "./credentials";
import { getPythBaseUrl, getPythHeaders } from "./steps/pyth-core";

export async function testPyth(credentials: PythCredentials): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    const baseUrl = getPythBaseUrl(credentials.PYTH_ENDPOINT_URL);
    const headers = getPythHeaders(credentials.PYTH_API_KEY);
    const res = await fetch(`${baseUrl}/v2/price_feeds?query=ETH`, {
      headers,
    });

    if (!res.ok) {
      return {
        success: false,
        error: `Pyth Hermes API connection failed with status ${res.status}: ${res.statusText}`,
      };
    }

    return {
      success: true,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: `Failed to connect to Pyth Hermes API: ${errorMsg}`,
    };
  }
}
