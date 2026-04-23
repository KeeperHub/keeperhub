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
import {
  getOrganizationWalletAddress,
  initializeWalletSigner,
} from "@/lib/para/wallet-helpers";
import { getGasStrategy } from "@/lib/web3/gas-strategy";
import { getNonceManager } from "@/lib/web3/nonce-manager";
import {
  type TransactionContext,
  withNonceSession,
} from "@/lib/web3/transaction-manager";

const ERC20_TRANSFER_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
];

function handleTransferError(error: unknown) {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();

    if (message.includes("insufficient funds")) {
      return NextResponse.json(
        { error: "Insufficient funds for transfer and gas" },
        { status: 400 }
      );
    }

    if (message.includes("nonce")) {
      return NextResponse.json(
        { error: "Transaction nonce error. Please try again." },
        { status: 400 }
      );
    }
  }
  return null;
}

type TransferOptions = {
  nonce: number;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
};

async function executeERC20Transfer(
  signer: ethers.Signer,
  tokenAddress: string,
  amountWei: bigint,
  recipient: string,
  options: TransferOptions
): Promise<string> {
  const contract = new ethers.Contract(
    tokenAddress,
    ERC20_TRANSFER_ABI,
    signer
  );
  const tx = await contract.transfer(recipient, amountWei, {
    nonce: options.nonce,
    gasLimit: options.gasLimit,
    maxFeePerGas: options.maxFeePerGas,
    maxPriorityFeePerGas: options.maxPriorityFeePerGas,
  });
  console.log(`[Withdraw] Transaction sent: ${tx.hash}`);
  const receipt = await tx.wait();
  return receipt.hash;
}

async function executeNativeTransfer(
  signer: ethers.Signer,
  amountWei: bigint,
  recipient: string,
  options: TransferOptions
): Promise<string> {
  const tx = await signer.sendTransaction({
    to: recipient,
    value: amountWei,
    nonce: options.nonce,
    gasLimit: options.gasLimit,
    maxFeePerGas: options.maxFeePerGas,
    maxPriorityFeePerGas: options.maxPriorityFeePerGas,
  });
  console.log(`[Withdraw] Transaction sent: ${tx.hash}`);
  const receipt = await tx.wait();
  return receipt?.hash || tx.hash;
}

// Validate user authentication and admin permissions
async function validateUserAndOrganization(request: Request) {
  const session = await auth.api.getSession({
    headers: request.headers,
  });

  if (!session?.user) {
    return { error: "Unauthorized", status: 401 };
  }

  const activeOrgId = getActiveOrgId(session);

  if (!activeOrgId) {
    return {
      error: "No active organization. Please select or create an organization.",
      status: 400,
    };
  }

  const activeMember = await auth.api.getActiveMember({
    headers: await headers(),
  });

  if (!activeMember) {
    return {
      error: "You are not a member of the active organization",
      status: 403,
    };
  }

  const role = activeMember.role;
  if (role !== "admin" && role !== "owner") {
    return {
      error: "Only organization admins and owners can withdraw funds",
      status: 403,
    };
  }

  return { user: session.user, organizationId: activeOrgId };
}

export async function POST(request: Request) {
  try {
    // 1. Validate user and permissions
    const validation = await validateUserAndOrganization(request);
    if ("error" in validation) {
      return NextResponse.json(
        { error: validation.error },
        { status: validation.status }
      );
    }
    const { organizationId } = validation;

    // 2. Parse request body
    const body = await request.json();
    const {
      chainId: rawChainId,
      tokenAddress,
      amount,
      recipient,
      fromMax,
    } = body;

    if (!(rawChainId && recipient)) {
      return NextResponse.json(
        { error: "Missing required fields: chainId, recipient" },
        { status: 400 }
      );
    }

    // fromMax is only valid for native transfers: for ERC20, token gas is
    // paid in the native asset, so sending the full token balance has no
    // reservation conflict and the client already sets amount = balance.
    if (fromMax && tokenAddress) {
      return NextResponse.json(
        { error: "fromMax is only valid for native transfers" },
        { status: 400 }
      );
    }

    if (!(fromMax || amount)) {
      return NextResponse.json(
        { error: "Missing required field: amount" },
        { status: 400 }
      );
    }

    const chainId = Number.parseInt(String(rawChainId), 10);
    if (Number.isNaN(chainId)) {
      return NextResponse.json(
        { error: "Invalid chainId" },
        { status: 400 }
      );
    }

    // Validate recipient address
    if (!ethers.isAddress(recipient)) {
      return NextResponse.json(
        { error: "Invalid recipient address" },
        { status: 400 }
      );
    }

    // Validate amount (skipped when fromMax: server computes the value)
    if (!fromMax) {
      const parsedAmount = Number.parseFloat(amount);
      if (Number.isNaN(parsedAmount) || parsedAmount <= 0) {
        return NextResponse.json({ error: "Invalid amount" }, { status: 400 });
      }
    }

    // 3. Get chain info from database
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
    const rpcUrl = chain.defaultPrimaryRpc;

    // 4. Get wallet address for nonce management
    const walletAddress = await getOrganizationWalletAddress(organizationId);

    // Generate a unique execution ID for this API call
    const executionId = `withdraw-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

    // Build transaction context
    const txContext: TransactionContext = {
      organizationId,
      executionId,
      chainId,
      rpcUrl,
      triggerType: "manual",
    };

    // Execute transaction with nonce management
    const result = await withNonceSession(
      txContext,
      walletAddress,
      async (session) => {
        const nonceManager = getNonceManager();
        const gasStrategy = getGasStrategy();

        // Initialize Para signer
        console.log(
          `[Withdraw] Initializing signer for org ${organizationId} on chain ${chain.name}`
        );
        const signer = await initializeWalletSigner(organizationId, rpcUrl, chainId);
        const provider = signer.provider;

        if (!provider) {
          throw new Error("Signer has no provider");
        }

        // Get nonce from session
        const nonce = nonceManager.getNextNonce(session);

        // Resolve amount in wei and estimate gas. For native fromMax the
        // final value is computed after gasConfig is known (1 wei here is a
        // placeholder; native-transfer gas does not depend on value).
        let amountWei: bigint;
        let estimatedGas: bigint;
        if (tokenAddress) {
          const contract = new ethers.Contract(
            tokenAddress,
            ERC20_TRANSFER_ABI,
            signer
          );
          const decimalsResult: bigint = await contract.decimals();
          const decimals = Number(decimalsResult);
          amountWei = ethers.parseUnits(amount, decimals);
          estimatedGas = await contract.transfer.estimateGas(
            recipient,
            amountWei
          );
        } else {
          amountWei = fromMax ? BigInt(1) : ethers.parseEther(amount);
          estimatedGas = await provider.estimateGas({
            from: walletAddress,
            to: recipient,
            value: amountWei,
          });
        }

        // Get gas configuration from strategy
        const baseGasConfig = await gasStrategy.getGasConfig(
          provider,
          "manual",
          estimatedGas,
          chainId
        );

        // For native fromMax, resolve the actual value now that gasConfig is
        // known. This pins reservation and value to the same snapshot, so
        // EIP-1559's `balance >= value + gasLimit*maxFeePerGas` check cannot
        // fail due to fee drift between the client's fee preview and tx
        // submission.
        //
        // We also tighten the reservation to drain closer to zero:
        //  - gasLimit: estimatedGas * 1.1. EOA→EOA native transfer gasUsed
        //    is deterministic at 21000, the 10% slack is only there for
        //    contract recipients where estimateGas can vary slightly. The
        //    default 2.0x multiplier would leave ~100 microETH of dust.
        //  - maxFeePerGas: baseFee * 1.125 + priorityFee. EIP-1559 caps
        //    baseFee growth at 12.5% per block, so this keeps the tx valid
        //    for one block of delay while avoiding the full 2x baseFee
        //    headroom that the default strategy applies.
        let gasLimit = baseGasConfig.gasLimit;
        let maxFeePerGas = baseGasConfig.maxFeePerGas;
        const maxPriorityFeePerGas = baseGasConfig.maxPriorityFeePerGas;

        if (fromMax && !tokenAddress) {
          const latestBlock = await provider.getBlock("latest");
          const baseFeePerGas = latestBlock?.baseFeePerGas ?? null;

          gasLimit = (estimatedGas * BigInt(11)) / BigInt(10);
          if (baseFeePerGas !== null) {
            maxFeePerGas =
              (baseFeePerGas * BigInt(9)) / BigInt(8) + maxPriorityFeePerGas;
          }
          // On legacy (non-EIP-1559) chains baseFeePerGas is null; keep the
          // strategy's maxFeePerGas (gasPrice * 1.2) since we have no
          // baseFee to bound against.

          const liveBalance = await provider.getBalance(walletAddress);
          const reservation = gasLimit * maxFeePerGas;
          if (liveBalance <= reservation) {
            throw new Error("Balance is too low to cover network fee");
          }
          amountWei = liveBalance - reservation;
        }

        console.log("[Withdraw] Gas config:", {
          estimatedGas: estimatedGas.toString(),
          gasLimit: gasLimit.toString(),
          maxFeePerGas: `${ethers.formatUnits(maxFeePerGas, "gwei")} gwei`,
          maxPriorityFeePerGas: `${ethers.formatUnits(maxPriorityFeePerGas, "gwei")} gwei`,
          fromMax: Boolean(fromMax),
        });

        const transferOptions: TransferOptions = {
          nonce,
          gasLimit,
          maxFeePerGas,
          maxPriorityFeePerGas,
        };

        // Execute transfer
        const txHash = tokenAddress
          ? await executeERC20Transfer(
              signer,
              tokenAddress,
              amountWei,
              recipient,
              transferOptions
            )
          : await executeNativeTransfer(
              signer,
              amountWei,
              recipient,
              transferOptions
            );

        // Record and confirm transaction
        await nonceManager.recordTransaction(
          session,
          nonce,
          txHash,
          undefined,
          maxFeePerGas.toString()
        );
        await nonceManager.confirmTransaction(txHash);

        console.log(`[Withdraw] Transaction confirmed: ${txHash}`);

        return { txHash };
      }
    );

    return NextResponse.json({
      success: true,
      txHash: result.txHash,
      chainId,
      tokenAddress: tokenAddress || null,
      amount,
      recipient,
    });
  } catch (error) {
    logSystemError(ErrorCategory.EXTERNAL_SERVICE, "[Withdraw] Failed", error, {
      endpoint: "/api/user/wallet/withdraw",
      operation: "post",
    });
    const errorResponse = handleTransferError(error);
    return errorResponse ?? apiError(error, "Failed to execute withdrawal");
  }
}
