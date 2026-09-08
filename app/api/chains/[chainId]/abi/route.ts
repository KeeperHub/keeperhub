import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { chains, explorerConfigs } from "@/lib/db/schema";
import { fetchContractAbi, getContractUrl } from "@/lib/explorer";

type RouteParams = {
  params: Promise<{ chainId: string }>;
};

/**
 * GET /api/chains/[chainId]/abi
 * Fetch contract ABI from the chain's block explorer
 *
 * Query params:
 * - address: Contract address (required)
 *
 * Response:
 * - success: boolean
 * - abi?: unknown[] (if success)
 * - error?: string (if failure)
 * - explorerUrl: string (link to view contract on explorer)
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { chainId: chainIdParam } = await params;
  const address = request.nextUrl.searchParams.get("address");

  if (!address) {
    return NextResponse.json(
      { success: false, error: "Address query parameter is required" },
      { status: 400 }
    );
  }

  const chainId = Number.parseInt(chainIdParam, 10);
  if (Number.isNaN(chainId)) {
    return NextResponse.json(
      { success: false, error: "Invalid chain ID" },
      { status: 400 }
    );
  }

  // Get chain info
  const chainResult = await db
    .select()
    .from(chains)
    .where(eq(chains.chainId, chainId))
    .limit(1);

  if (!chainResult[0]) {
    return NextResponse.json(
      { success: false, error: "Chain not found" },
      { status: 404 }
    );
  }

  // Get explorer config for this chain
  const explorerResult = await db
    .select()
    .from(explorerConfigs)
    .where(eq(explorerConfigs.chainId, chainId))
    .limit(1);

  if (!explorerResult[0]) {
    return NextResponse.json(
      { success: false, error: "Explorer not configured for this chain" },
      { status: 404 }
    );
  }

  const explorerConfig = explorerResult[0];
  const apiKey = process.env.ETHERSCAN_API_KEY;

  // Fetch ABI from explorer
  const result = await fetchContractAbi(
    explorerConfig,
    address,
    chainId,
    apiKey
  );

  return NextResponse.json({
    ...result,
    explorerUrl: getContractUrl(explorerConfig, address),
  });
}
