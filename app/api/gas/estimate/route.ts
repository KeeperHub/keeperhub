import { ethers } from "ethers";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import ERC20_ABI from "@/lib/contracts/abis/erc20.json";
import { MULTICALL3_ABI, MULTICALL3_ADDRESS } from "@/lib/contracts/multicall3";
import { SCOPE_MCP_READ } from "@/lib/mcp/oauth-scopes";
import { resolveOrganizationId } from "@/lib/middleware/auth-helpers";
import { requireScope } from "@/lib/middleware/require-scope";
import { getRpcProvider } from "@/lib/rpc/provider-factory";
import { resolveSignerForNode, SIGNER_MODE } from "@/lib/safe/signer-resolver";
import { getChainGasDefaults } from "@/lib/web3/gas-defaults";
import { getOrganizationWalletAddress } from "@/lib/web3/wallet-helpers";
import { buildCallsWithMeta } from "@/plugins/web3/steps/batch-write-contract-core";

type EstimateConfig = {
  contractAddress?: string;
  abi?: string;
  abiFunction?: string;
  functionArgs?: string;
  recipientAddress?: string;
  amount?: string;
  tokenConfig?: unknown;
  calls?: string | unknown[];
  isolateCallFailures?: string | boolean;
  web3Connection?: string;
};

type ActionSlug =
  | "write-contract"
  | "transfer-funds"
  | "transfer-token"
  | "batch-write-contract";

const TEMPLATE_REF_PATTERN = /\{\{.*?\}\}/;
const VALID_SLUGS: ActionSlug[] = [
  "write-contract",
  "transfer-funds",
  "transfer-token",
  "batch-write-contract",
];

function hasTemplateRefs(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return TEMPLATE_REF_PATTERN.test(value);
}

function badRequest(error: string): NextResponse {
  return NextResponse.json({ error }, { status: 400 });
}

/**
 * Estimate gas for a native token transfer
 */
function estimateTransferFunds(
  config: EstimateConfig,
  provider: ethers.JsonRpcProvider,
  walletAddress: string
): Promise<NextResponse | bigint> | NextResponse {
  if (!config.recipientAddress) {
    return badRequest(
      "recipientAddress is required for transfer-funds estimation"
    );
  }
  if (!ethers.isAddress(config.recipientAddress)) {
    return badRequest(`Invalid recipient address: ${config.recipientAddress}`);
  }

  return provider.estimateGas({
    from: walletAddress,
    to: config.recipientAddress,
    value: config.amount ? ethers.parseEther(config.amount) : BigInt(0),
  });
}

/**
 * Parse token address from tokenConfig object
 */
function parseTokenAddress(tokenConfig: unknown): string | undefined {
  if (!tokenConfig) {
    return;
  }
  try {
    const parsed =
      typeof tokenConfig === "string"
        ? (JSON.parse(tokenConfig) as Record<string, unknown>)
        : (tokenConfig as Record<string, unknown>);
    if (parsed.customToken && typeof parsed.customToken === "object") {
      return (parsed.customToken as Record<string, string>).address;
    }
  } catch {
    // Not parseable
  }
  return;
}

/**
 * Estimate gas for an ERC20 token transfer
 */
async function estimateTransferToken(
  config: EstimateConfig,
  provider: ethers.JsonRpcProvider,
  walletAddress: string
): Promise<NextResponse | bigint> {
  if (!config.recipientAddress) {
    return badRequest(
      "recipientAddress is required for transfer-token estimation"
    );
  }

  const tokenAddress = parseTokenAddress(config.tokenConfig);
  if (!(tokenAddress && ethers.isAddress(tokenAddress))) {
    return badRequest(
      "Valid token address is required for transfer-token estimation"
    );
  }

  const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  const decimals = Number(await tokenContract.decimals());
  const amountRaw = config.amount
    ? ethers.parseUnits(config.amount, decimals)
    : BigInt(0);

  return tokenContract.transfer.estimateGas(
    config.recipientAddress,
    amountRaw,
    { from: walletAddress }
  );
}

/**
 * Estimate gas for a contract write call
 */
function estimateWriteContract(
  config: EstimateConfig,
  provider: ethers.JsonRpcProvider,
  walletAddress: string
): Promise<bigint> | NextResponse {
  if (!(config.contractAddress && config.abi && config.abiFunction)) {
    return badRequest(
      "contractAddress, abi, and abiFunction are required for write-contract estimation"
    );
  }
  if (!ethers.isAddress(config.contractAddress)) {
    return badRequest(`Invalid contract address: ${config.contractAddress}`);
  }

  let parsedAbi: ethers.InterfaceAbi;
  try {
    parsedAbi = JSON.parse(config.abi) as ethers.InterfaceAbi;
  } catch {
    return badRequest("Invalid ABI JSON");
  }

  let args: unknown[] = [];
  if (config.functionArgs && config.functionArgs.trim() !== "") {
    try {
      args = JSON.parse(config.functionArgs) as unknown[];
    } catch {
      return badRequest("Invalid function arguments JSON");
    }
  }

  const contract = new ethers.Contract(
    config.contractAddress,
    parsedAbi,
    provider
  );

  // Use getFunction() so ABI names that collide with BaseContract built-ins
  // (e.g. getAddress, attach, connect, queryFilter) resolve to the ABI fragment
  // instead of the inherited method (which lacks `.estimateGas`).
  let fn: ethers.BaseContractMethod;
  try {
    fn = contract.getFunction(config.abiFunction);
  } catch {
    return badRequest(`Function '${config.abiFunction}' not found in ABI`);
  }

  return fn.estimateGas(...args, { from: walletAddress });
}

/**
 * Estimate gas for a batch write via Multicall3's aggregate3. Builds the
 * exact same CallWithMeta[] the step would broadcast (reusing
 * buildCallsWithMeta from batch-write-contract-core.ts) and estimates gas
 * for the aggregate3 call itself, since a batch has no single
 * contractAddress/abiFunction to estimate against the way write-contract
 * does.
 *
 * Checks the EOA-only gate first, matching batchWriteContractCore's own
 * hard gate. Unlike write-contract (which supports Safe/Safe-Role at
 * broadcast), a batch is EOA-only, so a Safe/Safe-Role org would otherwise
 * get a plausible gas number here for a config guaranteed to fail at
 * execution with a USER error.
 */
async function estimateBatchWriteContract(
  config: EstimateConfig,
  provider: ethers.JsonRpcProvider,
  walletAddress: string,
  organizationId: string,
  chainId: number
): Promise<bigint | NextResponse> {
  if (!config.calls) {
    return badRequest("calls is required for batch-write-contract estimation");
  }

  const signerMode = await resolveSignerForNode({
    organizationId,
    chainId,
    web3Connection: config.web3Connection,
  });
  if (signerMode.kind !== SIGNER_MODE.EOA) {
    return badRequest(
      "Batch Write Contract only supports the default EOA Web3 Connection. Safe/Role routing would change msg.sender for every batched call, which is not supported here. Use individual Write Contract nodes for Safe execution instead."
    );
  }

  const { calls: callsWithMeta, error } = buildCallsWithMeta({
    calls: config.calls,
    isolateCallFailures: config.isolateCallFailures,
  });
  if (error) {
    return badRequest(error);
  }

  const call3Array = callsWithMeta.map(
    ({ target, allowFailure, callData }) => ({
      target,
      allowFailure,
      callData,
    })
  );

  const multicall = new ethers.Contract(
    MULTICALL3_ADDRESS,
    MULTICALL3_ABI,
    provider
  );

  return multicall.aggregate3.estimateGas(call3Array, { from: walletAddress });
}

/**
 * Validate common request fields and return parsed values
 */
async function validateRequest(request: Request): Promise<
  | NextResponse
  | {
      chainId: number;
      actionSlug: ActionSlug;
      config: EstimateConfig;
      activeOrgId: string;
    }
> {
  const authCtx = await resolveOrganizationId(request);
  if ("error" in authCtx) {
    return NextResponse.json(
      { error: authCtx.error },
      { status: authCtx.status }
    );
  }

  const scopeError = requireScope(authCtx.scope, SCOPE_MCP_READ, {
    credentialType: authCtx.authMethod,
  });
  if (scopeError) {
    return scopeError;
  }

  const activeOrgId = authCtx.organizationId;

  const body = (await request.json().catch(() => ({}))) as Partial<{
    chainId: number;
    actionSlug: ActionSlug;
    config: EstimateConfig;
  }>;

  const { chainId: rawChainId, actionSlug, config } = body;

  if (!(rawChainId && actionSlug && config)) {
    return badRequest("chainId, actionSlug, and config are required");
  }

  if (!VALID_SLUGS.includes(actionSlug)) {
    return badRequest(
      `Invalid actionSlug. Must be one of: ${VALID_SLUGS.join(", ")}`
    );
  }

  const configValues = [
    config.contractAddress,
    config.abi,
    config.abiFunction,
    config.functionArgs,
    config.recipientAddress,
    config.amount,
    // isolateCallFailures is string | boolean | undefined; only the string
    // form (what the workflow UI sends) can carry a template reference.
    typeof config.isolateCallFailures === "string"
      ? config.isolateCallFailures
      : undefined,
  ];
  if (
    configValues.some(hasTemplateRefs) ||
    hasTemplateRefs(JSON.stringify(config.calls))
  ) {
    return badRequest(
      "Cannot estimate gas with template references ({{...}}). Provide literal values."
    );
  }

  const chainId = Number(rawChainId);
  if (Number.isNaN(chainId)) {
    return badRequest("Invalid chainId");
  }

  return { chainId, actionSlug, config, activeOrgId };
}

/**
 * POST /api/gas/estimate
 *
 * Returns a gas estimate for a given action configuration.
 * Requires authenticated session (uses org wallet address as `from`).
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const validated = await validateRequest(request);
    if (validated instanceof NextResponse) {
      return validated;
    }

    const { chainId, actionSlug, config, activeOrgId } = validated;

    let walletAddress: string;
    try {
      walletAddress = await getOrganizationWalletAddress(activeOrgId);
    } catch {
      return badRequest("No wallet configured. Create a wallet first.");
    }

    const rpcManager = await getRpcProvider({ chainId });

    const result = await rpcManager.executeWithFailover(async (provider) => {
      switch (actionSlug) {
        case "transfer-funds":
          return await estimateTransferFunds(config, provider, walletAddress);
        case "transfer-token":
          return await estimateTransferToken(config, provider, walletAddress);
        case "write-contract":
          return await estimateWriteContract(config, provider, walletAddress);
        case "batch-write-contract":
          return await estimateBatchWriteContract(
            config,
            provider,
            walletAddress,
            activeOrgId,
            chainId
          );
        default:
          return badRequest(`Unsupported action: ${actionSlug as string}`);
      }
    });

    // If the estimator returned a NextResponse, it's an error
    if (result instanceof NextResponse) {
      return result;
    }

    const chainDefaults = getChainGasDefaults(chainId);

    return NextResponse.json({
      estimatedGas: result.toString(),
      chainDefaults: {
        multiplier: chainDefaults.multiplier,
      },
    });
  } catch (error) {
    return apiError(error, "Failed to estimate gas");
  }
}
