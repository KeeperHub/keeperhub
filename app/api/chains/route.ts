import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { chains, explorerConfigs } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";

export type ChainResponse = {
  id: string;
  chainId: number;
  name: string;
  symbol: string;
  chainType: string;
  explorerUrl: string | null;
  explorerAddressPath: string | null;
  explorerApiUrl: string | null;
  explorerApiType: string | null;
  isTestnet: boolean;
  isEnabled: boolean;
  // KEEP-137: whether the chain supports private mempool routing (Flashbots Protect)
  usePrivateMempoolRpc: boolean;
};

export type GetChainsResponse = ChainResponse[];

/**
 * GET /api/chains
 * List all available chains with explorer configuration
 *
 * Query params:
 * - includeDisabled: "true" to include disabled chains (default: false)
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const includeDisabled = searchParams.get("includeDisabled") === "true";

    // Query chains with optional explorer config join
    const query = db
      .select({
        chain: chains,
        explorer: explorerConfigs,
      })
      .from(chains)
      .leftJoin(explorerConfigs, eq(chains.chainId, explorerConfigs.chainId));

    const results = includeDisabled
      ? await query
      : await query.where(eq(chains.isEnabled, true));

    // SECURITY: defaultPrimaryRpc / defaultFallbackRpc are intentionally NOT
    // returned. Some entries embed provider API keys (Infura, Alchemy) and the
    // response is publicly cacheable. Server-side callers read these fields
    // directly from the `chains` table.
    const response: GetChainsResponse = results.map(({ chain, explorer }) => ({
      id: chain.id,
      chainId: chain.chainId,
      name: chain.name,
      symbol: chain.symbol,
      chainType: chain.chainType,
      explorerUrl: explorer?.explorerUrl ?? null,
      explorerAddressPath: explorer?.explorerAddressPath ?? null,
      explorerApiUrl: explorer?.explorerApiUrl ?? null,
      explorerApiType: explorer?.explorerApiType ?? null,
      isTestnet: chain.isTestnet ?? false,
      isEnabled: chain.isEnabled ?? true,
      usePrivateMempoolRpc: chain.usePrivateMempoolRpc ?? false,
    }));

    return NextResponse.json(response);
  } catch (error) {
    logSystemError(ErrorCategory.DATABASE, "Failed to get chains", error, {
      endpoint: "/api/chains",
      operation: "get",
    });
    return NextResponse.json(
      {
        error: "Failed to get chains",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
