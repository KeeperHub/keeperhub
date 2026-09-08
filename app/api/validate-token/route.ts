import { PublicKey } from "@solana/web3.js";
import { ethers } from "ethers";
import { NextResponse } from "next/server";
import { normalizeAddressForStorage } from "@/lib/address-utils";
import ERC20_ABI from "@/lib/contracts/abis/erc20.json";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { getRpcProvider, isSolanaChain } from "@/lib/rpc/provider-factory";
import { getChainAdapter } from "@/lib/web3/chain-adapter";
import type { SolanaChainAdapter } from "@/lib/web3/chain-adapter/solana";
import { parseSolanaMintAccount } from "@/lib/web3/solana-mint";
import { validateChainAddress } from "@/lib/web3/validate-chain-address";

/**
 * Validate Token API
 *
 * Validates that an address is a valid ERC20 or SPL token and fetches its
 * metadata.
 *
 * Query params:
 * - address: The token contract/mint address
 * - network: Network name (e.g., "eth-mainnet", "base", "solana-mainnet")
 */
export function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const address = searchParams.get("address");
  const network = searchParams.get("network");

  if (!address) {
    return NextResponse.json(
      { error: "Missing address parameter" },
      { status: 400 }
    );
  }

  if (!network) {
    return NextResponse.json(
      { error: "Missing network parameter" },
      { status: 400 }
    );
  }

  let chainId: number;
  try {
    chainId = getChainIdFromNetwork(network);
  } catch {
    return NextResponse.json(
      { valid: false, error: "Network not supported" },
      { status: 200 }
    );
  }

  // Validate address format for the chain family.
  if (!validateChainAddress(address, chainId)) {
    return NextResponse.json(
      { valid: false, error: "Invalid address format" },
      { status: 200 }
    );
  }

  return isSolanaChain(chainId)
    ? validateSolanaToken(address, chainId)
    : validateEvmToken(address, chainId);
}

async function validateEvmToken(
  address: string,
  chainId: number
): Promise<NextResponse> {
  let rpcManager: Awaited<ReturnType<typeof getRpcProvider>>;
  try {
    rpcManager = await getRpcProvider({ chainId });
  } catch {
    return NextResponse.json(
      { valid: false, error: "Network not supported" },
      { status: 200 }
    );
  }

  try {
    // Fetch ERC20 metadata with retry/failover
    const [symbol, name, decimals] = await rpcManager.executeWithFailover(
      (provider) => {
        const contract = new ethers.Contract(address, ERC20_ABI, provider);
        return Promise.all([
          contract.symbol() as Promise<string>,
          contract.name() as Promise<string>,
          contract.decimals() as Promise<bigint>,
        ]);
      }
    );

    return NextResponse.json({
      valid: true,
      token: {
        address: normalizeAddressForStorage(address),
        symbol,
        name,
        decimals: Number(decimals),
      },
    });
  } catch (error) {
    logSystemError(ErrorCategory.NETWORK_RPC, "Validate token error", error, {
      endpoint: "/api/validate-token",
      operation: "get",
    });
    return NextResponse.json(
      { valid: false, error: "Not a valid ERC20 token" },
      { status: 200 }
    );
  }
}

/**
 * Solana has no on-chain equivalent of ERC20's symbol()/name() (that lives in
 * a separate Metaplex metadata account this endpoint does not integrate with
 * - same limitation noted in check-token-balance.ts), so a valid mint
 * validates with placeholder symbol/name rather than failing outright.
 */
async function validateSolanaToken(
  address: string,
  chainId: number
): Promise<NextResponse> {
  const mintPubkey = new PublicKey(address);
  const adapter = getChainAdapter(chainId) as SolanaChainAdapter;

  try {
    const mintInfo = await adapter.executeWithSolanaFailover((connection) =>
      connection.getAccountInfo(mintPubkey, "confirmed")
    );
    if (!mintInfo) {
      return NextResponse.json(
        { valid: false, error: "Mint account not found" },
        { status: 200 }
      );
    }

    const resolved = parseSolanaMintAccount(mintPubkey, mintInfo);
    if ("error" in resolved) {
      return NextResponse.json(
        { valid: false, error: resolved.error },
        { status: 200 }
      );
    }

    return NextResponse.json({
      valid: true,
      token: {
        address,
        symbol: "???",
        name: "Unknown",
        decimals: resolved.mint.decimals,
      },
    });
  } catch (error) {
    logSystemError(ErrorCategory.NETWORK_RPC, "Validate token error", error, {
      endpoint: "/api/validate-token",
      operation: "get",
    });
    return NextResponse.json(
      { valid: false, error: "Not a valid SPL token" },
      { status: 200 }
    );
  }
}
