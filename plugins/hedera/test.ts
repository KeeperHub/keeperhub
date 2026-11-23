/**
 * Connection test for the Hedera plugin.
 *
 * The verify-message action is read-only and needs no credentials, so this
 * simply confirms the public testnet mirror is reachable — early feedback in
 * the connection dialog that the user's network can reach Hedera.
 */
export async function testHedera(
  _credentials: Record<string, string>
): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetch(
      "https://testnet.mirrornode.hedera.com/api/v1/network/nodes?limit=1",
      { signal: AbortSignal.timeout(10_000) }
    );
    if (!res.ok) {
      return {
        success: false,
        error: `Hedera testnet mirror returned HTTP ${res.status}.`,
      };
    }
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: `Could not reach the Hedera mirror: ${message}` };
  }
}
