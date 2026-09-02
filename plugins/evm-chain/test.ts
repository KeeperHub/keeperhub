/**
 * Connection test: a single read-only eth_chainId JSON-RPC call.
 * Succeeds when the endpoint answers with a hex chain id.
 */
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
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    if (!response.ok) {
      return { success: false, error: `RPC endpoint returned HTTP ${response.status}` };
    }
    const data = await response.json();
    const chainId = data?.result;
    if (typeof chainId !== "string" || !/^0x[0-9a-f]+$/i.test(chainId)) {
      return { success: false, error: "Unexpected RPC response (no chain id result)" };
    }
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
