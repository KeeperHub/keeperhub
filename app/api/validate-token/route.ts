import { ethers } from "ethers";
import { NextResponse } from "next/server";
import { normalizeAddressForStorage } from "@/lib/address-utils";
import ERC20_ABI from "@/lib/contracts/abis/erc20.json";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { getRpcProvider } from "@/lib/rpc/provider-factory";

/**
 * Validate Token API
 *
 * Validates that an address is a valid ERC20 token and fetches its metadata.
 *
 * Query params:
 * - address: The token contract address
 * - network: Network name (e.g., "eth-mainnet", "base")
 */
export async function GET(request: Request) {
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

  // Validate address format
  if (!ethers.isAddress(address)) {
    return NextResponse.json(
      { valid: false, error: "Invalid address format" },
      { status: 200 }
    );
  }

  try {
    // Get chain ID and RPC provider
    const chainId = getChainIdFromNetwork(network);

    let rpcManager: Awaited<ReturnType<typeof getRpcProvider>>;
    try {
      rpcManager = await getRpcProvider({ chainId });
    } catch {
      return NextResponse.json(
        { valid: false, error: "Network not supported" },
        { status: 200 }
      );
    }

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
