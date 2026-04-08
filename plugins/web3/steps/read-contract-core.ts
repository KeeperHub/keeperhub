/**
 * Core read-contract logic shared between web3 read-contract and protocol-read steps.
 *
 * IMPORTANT: This file must NOT contain "use step" or be a step file.
 * It exists so that multiple step files can reuse read logic without
 * exporting functions from "use step" files (which breaks the workflow bundler).
 */
import "server-only";

import { eq } from "drizzle-orm";
import { ethers } from "ethers";
import { reshapeArgsForAbi } from "@/lib/abi-struct-args";
import { validateArgsForAbi } from "@/lib/abi-validate-args";
import { db } from "@/lib/db";
import { workflowExecutions } from "@/lib/db/schema";
import { ErrorCategory, logUserError } from "@/lib/logging";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { getRpcProvider } from "@/lib/rpc/provider-factory";
import { getErrorMessage } from "@/lib/utils";
import { getAbiFunctionKey } from "@/lib/web3/abi-function-key";
import { getChainAdapter } from "@/lib/web3/chain-adapter";
import { formatContractError } from "@/lib/web3/decode-revert-error";

export type ReadContractCoreInput = {
  contractAddress: string;
  network: string;
  abi: string;
  abiFunction: string;
  functionArgs?: string;
  _context?: { executionId?: string; organizationId?: string };
};

export type ReadContractResult =
  | { success: true; result: unknown; addressLink: string }
  | { success: false; error: string };

async function getUserIdFromExecution(
  executionId: string | undefined
): Promise<string | undefined> {
  if (!executionId) {
    return;
  }

  const execution = await db
    .select({ userId: workflowExecutions.userId })
    .from(workflowExecutions)
    .where(eq(workflowExecutions.id, executionId))
    .limit(1);

  return execution[0]?.userId;
}

/**
 * Core read contract logic
 *
 * Shared between the web3 read-contract step and the future protocol-read step.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Contract interaction requires extensive validation
export async function readContractCore(
  input: ReadContractCoreInput
): Promise<ReadContractResult> {
  const { contractAddress, network, abi, abiFunction, functionArgs, _context } =
    input;

  const userId = _context?.organizationId
    ? undefined
    : await getUserIdFromExecution(_context?.executionId);

  // Validate contract address
  if (!ethers.isAddress(contractAddress)) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[Read Contract] Invalid contract address:",
      contractAddress,
      { plugin_name: "web3", action_name: "read-contract" }
    );
    return {
      success: false,
      error: `Invalid contract address: ${contractAddress}`,
    };
  }

  // Parse ABI
  let parsedAbi: unknown;
  try {
    parsedAbi = JSON.parse(abi);
  } catch (error) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[Read Contract] Failed to parse ABI:",
      error,
      { plugin_name: "web3", action_name: "read-contract" }
    );
    return {
      success: false,
      error: `Invalid ABI JSON: ${getErrorMessage(error)}`,
    };
  }

  if (!Array.isArray(parsedAbi)) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[Read Contract] ABI is not an array",
      parsedAbi,
      { plugin_name: "web3", action_name: "read-contract" }
    );
    return { success: false, error: "ABI must be a JSON array" };
  }

  // Find the selected function in the ABI to get output structure
  const functionAbi = parsedAbi.find(
    (item: { type: string; name: string; stateMutability?: string }) =>
      item.type === "function" && item.name === abiFunction
  );

  if (!functionAbi) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[Read Contract] Function not found in ABI:",
      abiFunction,
      { plugin_name: "web3", action_name: "read-contract" }
    );
    return {
      success: false,
      error: `Function '${abiFunction}' not found in ABI`,
    };
  }

  const abiFunctionKey = getAbiFunctionKey(parsedAbi, abiFunction, functionAbi);

  // Parse function arguments
  let args: unknown[] = [];
  if (functionArgs && functionArgs.trim() !== "") {
    try {
      const parsedArgs = JSON.parse(functionArgs);
      if (!Array.isArray(parsedArgs)) {
        logUserError(
          ErrorCategory.VALIDATION,
          "[Read Contract] Function args is not an array",
          parsedArgs,
          { plugin_name: "web3", action_name: "read-contract" }
        );
        return {
          success: false,
          error: "Function arguments must be a JSON array",
        };
      }
      args = parsedArgs.filter((arg, index) => {
        if (arg !== "") {
          return true;
        }
        return parsedArgs.slice(index + 1).some((a) => a !== "");
      });
      args = reshapeArgsForAbi(args, functionAbi);
      const validation = validateArgsForAbi(args, functionAbi);
      if (!validation.ok) {
        return {
          success: false,
          error: `Invalid function arguments: ${validation.error}`,
        };
      }
    } catch (error) {
      logUserError(
        ErrorCategory.VALIDATION,
        "[Read Contract] Failed to parse function arguments:",
        error,
        { plugin_name: "web3", action_name: "read-contract" }
      );
      return {
        success: false,
        error: `Invalid function arguments JSON: ${getErrorMessage(error)}`,
      };
    }
  }

  // Get chain ID from network name
  let chainId: number;
  try {
    chainId = getChainIdFromNetwork(network);
  } catch (error) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[Read Contract] Failed to resolve network:",
      error,
      { plugin_name: "web3", action_name: "read-contract" }
    );
    return { success: false, error: getErrorMessage(error) };
  }

  // Resolve RPC provider
  let rpcManager: Awaited<ReturnType<typeof getRpcProvider>>;
  try {
    rpcManager = await getRpcProvider({ chainId, userId });
  } catch (error) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[Read Contract] Failed to resolve RPC config:",
      error,
      {
        plugin_name: "web3",
        action_name: "read-contract",
        chain_id: String(chainId),
      }
    );
    return { success: false, error: getErrorMessage(error) };
  }

  const contractInterface = new ethers.Interface(
    parsedAbi as ethers.InterfaceAbi
  );

  const adapter = getChainAdapter(chainId);
  const isView =
    functionAbi.stateMutability === "view" ||
    functionAbi.stateMutability === "pure";

  try {
    const result = await adapter.readContract(rpcManager, {
      contractAddress,
      abi: parsedAbi as ethers.InterfaceAbi,
      functionKey: abiFunctionKey,
      args,
      isView,
    });

    // Convert BigInt values to strings for JSON serialization
    const serializedResult = JSON.parse(
      JSON.stringify(result, (_, value) =>
        typeof value === "bigint" ? value.toString() : value
      )
    );

    // Transform array results into named objects based on ABI outputs
    let structuredResult = serializedResult;

    const outputs = (
      functionAbi as { outputs?: Array<{ name?: string; type: string }> }
    ).outputs;

    if (outputs && outputs.length > 0) {
      if (outputs.length === 1) {
        const singleOutput = outputs[0];
        const outputName = singleOutput.name?.trim();
        const outputType = singleOutput.type ?? "";
        const isArrayType = outputType.endsWith("[]");
        const singleValue =
          Array.isArray(serializedResult) && !isArrayType
            ? serializedResult[0]
            : serializedResult;
        if (outputName) {
          structuredResult = { [outputName]: singleValue };
        } else {
          structuredResult = singleValue;
        }
      } else if (Array.isArray(serializedResult)) {
        structuredResult = {};
        for (const [index, output] of outputs.entries()) {
          const fieldName = output.name?.trim() || `unnamedOutput${index}`;
          structuredResult[fieldName] = serializedResult[index];
        }
      }
    }

    const addressLink = await adapter.getAddressUrl(contractAddress);

    return {
      success: true,
      result: structuredResult,
      addressLink,
    };
  } catch (error) {
    logUserError(
      ErrorCategory.NETWORK_RPC,
      "[Read Contract] Function call failed:",
      error,
      {
        plugin_name: "web3",
        action_name: "read-contract",
        chain_id: String(chainId),
      }
    );
    return {
      success: false,
      error: formatContractError(error, contractInterface),
    };
  }
}
