import { and, eq } from "drizzle-orm";
import { ethers } from "ethers";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { chains, organizationWallets } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  type DualAuthContext,
  getDualAuthContext,
} from "@/lib/middleware/auth-helpers";
import { getChainAdapter } from "@/lib/web3/chain-adapter/registry";

const SOLANA_DECIMALS = 9;

type SolanaChainBalance = {
  chainId: number;
  chainName: string;
  isTestnet: boolean;
  balanceLamports: string;
  balanceSol: string;
  error: boolean;
};

async function fetchSolanaBalance(
  chainId: number,
  chainName: string,
  isTestnet: boolean,
  address: string
): Promise<SolanaChainBalance> {
  try {
    const adapter = getChainAdapter(chainId);
    // SolanaChainAdapter owns its own provider manager and ignores rpcManager.
    const lamports = await adapter.getBalance(undefined, address);
    return {
      chainId,
      chainName,
      isTestnet,
      balanceLamports: lamports.toString(),
      balanceSol: ethers.formatUnits(lamports, SOLANA_DECIMALS),
      error: false,
    };
  } catch (error) {
    logSystemError(
      ErrorCategory.NETWORK_RPC,
      `[Solana Balance] Failed to fetch balance on chain ${chainId}`,
      error,
      { chainId: String(chainId) }
    );
    return {
      chainId,
      chainName,
      isTestnet,
      balanceLamports: "",
      balanceSol: "",
      error: true,
    };
  }
}

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const authContext: DualAuthContext = await getDualAuthContext(request);
    if ("error" in authContext) {
      return NextResponse.json(
        { error: authContext.error },
        { status: authContext.status }
      );
    }

    const { organizationId: activeOrgId } = authContext;
    if (!activeOrgId) {
      return NextResponse.json(
        { error: "No active organization" },
        { status: 400 }
      );
    }

    const active = await db
      .select()
      .from(organizationWallets)
      .where(
        and(
          eq(organizationWallets.organizationId, activeOrgId),
          eq(organizationWallets.isActive, true)
        )
      )
      .limit(1);

    const solanaAddress = active[0]?.solanaAddress ?? null;
    if (!solanaAddress) {
      return NextResponse.json({ hasSolanaWallet: false, balances: [] });
    }

    const solanaChains = await db
      .select()
      .from(chains)
      .where(and(eq(chains.chainType, "solana"), eq(chains.isEnabled, true)));

    const balances: SolanaChainBalance[] = await Promise.all(
      solanaChains.map((chain) =>
        fetchSolanaBalance(
          chain.chainId,
          chain.name,
          chain.isTestnet ?? false,
          solanaAddress
        )
      )
    );

    return NextResponse.json({
      hasSolanaWallet: true,
      address: solanaAddress,
      balances,
    });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[Solana Balance] Failed to resolve Solana balances",
      error,
      { endpoint: "/api/user/wallet/solana-balance" }
    );
    return NextResponse.json(
      { error: "Failed to fetch Solana balance" },
      { status: 500 }
    );
  }
}
