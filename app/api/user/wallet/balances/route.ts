import { and, eq, isNull } from "drizzle-orm";
import { ethers } from "ethers";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import ERC20_ABI from "@/lib/contracts/abis/erc20.json";
import { db } from "@/lib/db";
import {
  chains,
  explorerConfigs,
  organizationTokens,
  supportedTokens,
} from "@/lib/db/schema";
import { safeWallets } from "@/lib/db/schema-extensions";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { resolveOrganizationId } from "@/lib/middleware/auth-helpers";
import { getRpcProvider } from "@/lib/rpc/provider-factory";
import { formatWeiToBalance } from "@/lib/wallet/fetch-balances";
import { getOrganizationWallet } from "@/lib/web3/wallet-helpers";

const NATIVE_DECIMALS = 18;

type TokenBalance = {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  balance: string;
  balanceRaw: string;
  logoUrl?: string;
};

type SupportedTokenBalance = {
  tokenAddress: string;
  symbol: string;
  name: string;
  decimals: number;
  balance: string;
  balanceRaw: string;
  logoUrl: string | null;
  explorerUrl: string | null;
};

type ChainBalance = {
  chainId: number;
  chainName: string;
  symbol: string;
  isTestnet: boolean;
  nativeBalance: string;
  nativeBalanceRaw: string;
  tokens: TokenBalance[];
  supportedTokens: SupportedTokenBalance[];
  loading?: boolean;
  error?: string;
};

function buildTokenExplorerUrl(
  explorerUrl: string | null,
  explorerAddressPath: string | null,
  tokenAddress: string
): string | null {
  if (!explorerUrl) {
    return null;
  }
  const path = explorerAddressPath || "/address/{address}";
  return `${explorerUrl}${path.replace("{address}", tokenAddress)}`;
}

/**
 * GET /api/user/wallet/balances
 *
 * Fetches native token and ERC20 token balances across all enabled chains
 * for the organization's wallet.
 */
export async function GET(request: Request) {
  try {
    const authCtx = await resolveOrganizationId(request);
    if ("error" in authCtx) {
      return NextResponse.json(
        { error: authCtx.error },
        { status: authCtx.status }
      );
    }
    const { organizationId: activeOrgId } = authCtx;

    // Optional ?safeId=X scopes the balance read to a Safe's address +
    // chain instead of the Turnkey EOA. The Safe must belong to the active
    // org; we validate before reading anything off-chain.
    const url = new URL(request.url);
    const safeIdParam = url.searchParams.get("safeId");

    let walletAddress: string;
    let safeChainId: number | null = null;
    if (safeIdParam) {
      const safeRows = await db
        .select()
        .from(safeWallets)
        .where(
          and(
            eq(safeWallets.id, safeIdParam),
            eq(safeWallets.organizationId, activeOrgId)
          )
        )
        .limit(1);
      const safe = safeRows[0];
      if (!safe) {
        return NextResponse.json(
          { error: "Safe not found for this organization" },
          { status: 404 }
        );
      }
      if (safe.status !== "deployed") {
        return NextResponse.json(
          { error: "Safe is not deployed" },
          { status: 400 }
        );
      }
      walletAddress = safe.safeAddress;
      safeChainId = safe.chainId;
    } else {
      const wallet = await getOrganizationWallet(activeOrgId).catch(() => null);
      if (!wallet) {
        return NextResponse.json(
          { error: "No wallet found for this organization" },
          { status: 404 }
        );
      }
      walletAddress = wallet.walletAddress;
    }

    // Get all enabled EVM chains. Non-EVM chains (Solana) need a different
    // provider/RPC stack and are out of scope for this endpoint. A Safe
    // lives on exactly one chain, so we restrict the chain list when
    // safeId is set.
    const enabledChains = (
      await db.select().from(chains).where(eq(chains.isEnabled, true))
    ).filter(
      (chain) =>
        chain.chainType === "evm" &&
        (safeChainId === null || chain.chainId === safeChainId)
    );

    // Get tracked tokens scoped to the requested wallet view: when
    // safeId is set, only rows tagged to that Safe; otherwise org-level
    // rows tracked under the Turnkey EOA (safe_wallet_id IS NULL).
    const tokenScopeCondition = safeIdParam
      ? eq(organizationTokens.safeWalletId, safeIdParam)
      : isNull(organizationTokens.safeWalletId);
    const trackedTokens = await db
      .select()
      .from(organizationTokens)
      .where(
        and(
          eq(organizationTokens.organizationId, activeOrgId),
          tokenScopeCondition
        )
      );

    // Group tokens by chainId
    const tokensByChain = new Map<number, typeof trackedTokens>();
    for (const token of trackedTokens) {
      const existing = tokensByChain.get(token.chainId) || [];
      existing.push(token);
      tokensByChain.set(token.chainId, existing);
    }

    // Get system-supported tokens (stablecoins) and explorer configs for all
    // chains. Only one row per supported token actually present on a chain;
    // chains where a token isn't deployed simply have no row.
    const [allSupportedTokens, allExplorerConfigs] = await Promise.all([
      db
        .select()
        .from(supportedTokens)
        .orderBy(supportedTokens.chainId, supportedTokens.sortOrder),
      db.select().from(explorerConfigs),
    ]);

    const supportedTokensByChain = new Map<number, typeof allSupportedTokens>();
    for (const token of allSupportedTokens) {
      const existing = supportedTokensByChain.get(token.chainId) ?? [];
      existing.push(token);
      supportedTokensByChain.set(token.chainId, existing);
    }

    const explorerByChain = new Map<number, (typeof allExplorerConfigs)[0]>();
    for (const explorer of allExplorerConfigs) {
      explorerByChain.set(explorer.chainId, explorer);
    }

    // Fetch balances for each chain in parallel
    const balancePromises = enabledChains.map(
      async (chain): Promise<ChainBalance> => {
        const isTestnet = chain.isTestnet === true;

        try {
          const rpcManager = await getRpcProvider({
            chainId: chain.chainId,
          });

          // Fetch native balance with retry/failover
          const nativeBalanceRaw = await rpcManager.executeWithFailover(
            (provider) => provider.getBalance(walletAddress)
          );
          const nativeBalance = formatWeiToBalance(
            nativeBalanceRaw,
            NATIVE_DECIMALS
          );

          // Fetch ERC20 token balances for this chain
          const chainTokens = tokensByChain.get(chain.chainId) ?? [];
          const tokenBalances: TokenBalance[] = [];

          for (const token of chainTokens) {
            try {
              const balanceRaw = await rpcManager.executeWithFailover(
                async (provider) => {
                  const contract = new ethers.Contract(
                    token.tokenAddress,
                    ERC20_ABI,
                    provider
                  );
                  return (await contract.balanceOf(walletAddress)) as bigint;
                }
              );
              const balance = formatWeiToBalance(balanceRaw, token.decimals);

              tokenBalances.push({
                address: token.tokenAddress,
                symbol: token.symbol,
                name: token.name,
                decimals: token.decimals,
                balance,
                balanceRaw: balanceRaw.toString(),
                logoUrl: token.logoUrl ?? undefined,
              });
            } catch (tokenError) {
              logSystemError(
                ErrorCategory.EXTERNAL_SERVICE,
                `[Balances] Failed to fetch balance for token ${token.symbol}`,
                tokenError,
                {
                  endpoint: "/api/user/wallet/balances",
                  operation: "fetchTokenBalance",
                }
              );
              tokenBalances.push({
                address: token.tokenAddress,
                symbol: token.symbol,
                name: token.name,
                decimals: token.decimals,
                balance: "0",
                balanceRaw: "0",
                logoUrl: token.logoUrl ?? undefined,
              });
            }
          }

          // Fetch system-supported token (stablecoin) balances for this chain
          const chainSupported =
            supportedTokensByChain.get(chain.chainId) ?? [];
          const explorer = explorerByChain.get(chain.chainId);
          const supportedTokenBalances: SupportedTokenBalance[] = [];

          for (const token of chainSupported) {
            const explorerUrl = buildTokenExplorerUrl(
              explorer?.explorerUrl ?? null,
              explorer?.explorerAddressPath ?? null,
              token.tokenAddress
            );
            try {
              const balanceRaw = await rpcManager.executeWithFailover(
                async (provider) => {
                  const contract = new ethers.Contract(
                    token.tokenAddress,
                    ERC20_ABI,
                    provider
                  );
                  return (await contract.balanceOf(walletAddress)) as bigint;
                }
              );
              const balance = formatWeiToBalance(balanceRaw, token.decimals);
              supportedTokenBalances.push({
                tokenAddress: token.tokenAddress,
                symbol: token.symbol,
                name: token.name,
                decimals: token.decimals,
                balance,
                balanceRaw: balanceRaw.toString(),
                logoUrl: token.logoUrl,
                explorerUrl,
              });
            } catch (tokenError) {
              logSystemError(
                ErrorCategory.EXTERNAL_SERVICE,
                `[Balances] Failed to fetch supported-token balance for ${token.symbol}`,
                tokenError,
                {
                  endpoint: "/api/user/wallet/balances",
                  operation: "fetchSupportedTokenBalance",
                }
              );
              supportedTokenBalances.push({
                tokenAddress: token.tokenAddress,
                symbol: token.symbol,
                name: token.name,
                decimals: token.decimals,
                balance: "0",
                balanceRaw: "0",
                logoUrl: token.logoUrl,
                explorerUrl,
              });
            }
          }

          return {
            chainId: chain.chainId,
            chainName: chain.name,
            symbol: chain.symbol,
            isTestnet,
            nativeBalance,
            nativeBalanceRaw: nativeBalanceRaw.toString(),
            tokens: tokenBalances,
            supportedTokens: supportedTokenBalances,
          };
        } catch (error) {
          logSystemError(
            ErrorCategory.EXTERNAL_SERVICE,
            `[Balances] Failed to fetch balance for chain ${chain.name}`,
            error,
            {
              endpoint: "/api/user/wallet/balances",
              operation: "fetchChainBalance",
            }
          );
          return {
            chainId: chain.chainId,
            chainName: chain.name,
            symbol: chain.symbol,
            isTestnet,
            nativeBalance: "0",
            nativeBalanceRaw: "0",
            tokens: [],
            supportedTokens: [],
            error:
              error instanceof Error
                ? error.message
                : "Failed to fetch balance",
          };
        }
      }
    );

    const balances = await Promise.all(balancePromises);

    // Sort: mainnets first, then testnets
    balances.sort((a, b) => {
      if (a.isTestnet !== b.isTestnet) {
        return a.isTestnet ? 1 : -1;
      }
      return a.chainName.localeCompare(b.chainName);
    });

    return NextResponse.json({
      walletAddress,
      balances,
    });
  } catch (error) {
    return apiError(error, "Failed to fetch wallet balances");
  }
}
