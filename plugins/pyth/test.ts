export async function testPyth(_credentials: Record<string, string>): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    const res = await fetch("https://hermes.pyth.network/v2/price_feeds?query=ETH");
    if (!res.ok) {
      return {
        success: false,
        error: `Pyth Hermes API check failed with status ${res.status}`,
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
