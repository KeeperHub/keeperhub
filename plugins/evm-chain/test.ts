/**
 * Connection test: a single read-only eth_chainId JSON-RPC call.
 * Succeeds when the endpoint answers with a hex chain id.
 *
 * Connection-test files are reachable from the client-bundled plugin
 * registry, so they cannot import the server-only safe-fetch.ts guard.
 * Egress is covered instead by the always-on assertUrlIsPublic pre-flight in
 * handlePluginTest (lib/db/test-connection.ts), which validates this url
 * field before the test runs. Step files route through safeFetch.
 */
const FETCH_TIMEOUT_MS = 10_000;
const CHAIN_ID_RE = /^0x[0-9a-f]+$/i;

export async function testEvmChain(
  credentials: Record<string, string>
): Promise<{ success: boolean; error?: string }> {
  const rpcUrl = credentials.EVM_CHAIN_RPC_URL;
  if (!rpcUrl) {
    return { success: false, error: "EVM_CHAIN_RPC_URL is required" };
  }
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_chainId",
        params: [],
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      return {
        success: false,
        error: `RPC endpoint returned HTTP ${response.status}`,
      };
    }
    const payload = (await response.json()) as {
      result?: unknown;
      error?: { code?: unknown; message?: unknown };
    };
    if (payload?.error !== undefined && payload?.error !== null) {
      const message =
        typeof payload.error.message === "string" &&
        payload.error.message.trim() !== ""
          ? payload.error.message
          : JSON.stringify(payload.error);
      const code =
        typeof payload.error.code === "number" ? ` ${payload.error.code}` : "";
      return { success: false, error: `RPC error${code}: ${message}` };
    }
    const chainId = payload?.result;
    if (typeof chainId !== "string" || !CHAIN_ID_RE.test(chainId)) {
      return {
        success: false,
        error: "Unexpected RPC response (no chain id result)",
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
