import { eq } from "drizzle-orm";
import { ethers } from "ethers";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { chains } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getActiveOrgId } from "@/lib/middleware/org-context";
import { getOrganizationWalletAddress } from "@/lib/para/wallet-helpers";
import { getRpcProvider } from "@/lib/rpc/provider-factory";
import { getGasStrategy } from "@/lib/web3/gas-strategy";

const ERC20_TRANSFER_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
];

async function validateUserAndOrganization(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });

  if (!session?.user) {
    return { error: "Unauthorized", status: 401 } as const;
  }

  const activeOrgId = getActiveOrgId(session);
  if (!activeOrgId) {
    return {
      error: "No active organization. Please select or create an organization.",
      status: 400,
    } as const;
  }

  const activeMember = await auth.api.getActiveMember({
    headers: await headers(),
  });
  if (!activeMember) {
    return {
      error: "You are not a member of the active organization",
      status: 403,
    } as const;
  }

  const role = activeMember.role;
  if (role !== "admin" && role !== "owner") {
    return {
      error: "Only organization admins and owners can estimate withdrawals",
      status: 403,
    } as const;
  }

  return { organizationId: activeOrgId };
}

export async function POST(request: Request) {
  try {
    const validation = await validateUserAndOrganization(request);
    if ("error" in validation) {
      return NextResponse.json(
        { error: validation.error },
        { status: validation.status }
      );
    }
    const { organizationId } = validation;

    const body = await request.json();
    const { chainId: rawChainId, tokenAddress, amount, recipient } = body;

    if (!(rawChainId && amount && recipient)) {
      return NextResponse.json(
        { error: "Missing required fields: chainId, amount, recipient" },
        { status: 400 }
      );
    }

    const chainId = Number.parseInt(String(rawChainId), 10);
    if (Number.isNaN(chainId)) {
      return NextResponse.json({ error: "Invalid chainId" }, { status: 400 });
    }

    if (!ethers.isAddress(recipient)) {
      return NextResponse.json(
        { error: "Invalid recipient address" },
        { status: 400 }
      );
    }

    const parsedAmount = Number.parseFloat(amount);
    if (Number.isNaN(parsedAmount) || parsedAmount <= 0) {
      return NextResponse.json({ error: "Invalid amount" }, { status: 400 });
    }

    const chainResult = await db
      .select()
      .from(chains)
      .where(eq(chains.chainId, chainId))
      .limit(1);

    if (chainResult.length === 0) {
      return NextResponse.json(
        { error: `Chain ${chainId} not found` },
        { status: 404 }
      );
    }

    const chain = chainResult[0];
    const walletAddress = await getOrganizationWalletAddress(organizationId);
    const rpcManager = await getRpcProvider({ chainId });

    const estimatedGas = await rpcManager.executeWithFailover(
      async (provider): Promise<bigint> => {
        if (tokenAddress) {
          const contract = new ethers.Contract(
            tokenAddress,
            ERC20_TRANSFER_ABI,
            provider
          );
          const decimalsBig: bigint = await contract.decimals();
          const decimals = Number(decimalsBig);
          const amountWei = ethers.parseUnits(amount, decimals);
          return await contract.transfer.estimateGas(recipient, amountWei, {
            from: walletAddress,
          });
        }
        const amountWei = ethers.parseEther(amount);
        return await provider.estimateGas({
          from: walletAddress,
          to: recipient,
          value: amountWei,
        });
      }
    );

    const gasConfig = await getGasStrategy().getGasConfig(
      rpcManager.getProvider(),
      "manual",
      estimatedGas,
      chainId
    );

    // Match what the withdraw route will actually prepay on-chain. EIP-1559
    // rejects a tx when balance < value + gasLimit * maxFeePerGas, so the
    // Max button must reserve that full amount, not just estimatedGas *
    // maxFeePerGas. Any unused gas is refunded after the tx mines, but the
    // node won't accept it otherwise.
    const gasCostWei = gasConfig.gasLimit * gasConfig.maxFeePerGas;

    return NextResponse.json({
      gasCostWei: gasCostWei.toString(),
      gasCostEth: ethers.formatEther(gasCostWei),
      nativeSymbol: chain.symbol,
      estimatedGas: estimatedGas.toString(),
      gasLimit: gasConfig.gasLimit.toString(),
      maxFeePerGasGwei: ethers.formatUnits(gasConfig.maxFeePerGas, "gwei"),
    });
  } catch (error) {
    logSystemError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[EstimateGas] Failed",
      error,
      {
        endpoint: "/api/user/wallet/estimate-gas",
        operation: "post",
      }
    );
    return apiError(error, "Failed to estimate gas");
  }
}
