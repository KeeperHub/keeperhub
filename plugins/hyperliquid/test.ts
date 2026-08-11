const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export async function testHyperliquid(
  _credentials: Record<string, string>
): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch(HYPERLIQUID_INFO_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "clearinghouseState", user: ZERO_ADDRESS }),
    });

    if (!response.ok) {
      return {
        success: false,
        error: `Hyperliquid Info API returned ${response.status}`,
      };
    }

    return { success: true };
  } catch (error: unknown) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
