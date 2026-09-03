/**
 * Core read-contract logic shared between web3 read-contract and protocol-read steps.
 *
 * IMPORTANT: This file must NOT contain "use step" or be a step file.
 * It exists so that multiple step files can reuse read logic without
 * exporting functions from "use step" files (which breaks the workflow bundler).
 */
import "server-only";
import { getRpcPreferenceUserId } from "@/lib/workflow/executor/helpers";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import { ethers } from "ethers";
import { coerceArgsForAbi, reshapeArgsForAbi } from "@/lib/abi/struct-args";
import { validateArgsForAbi } from "@/lib/abi/validate-args";
import { ErrorCategory, logUserError } from "@/lib/logging";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { getRpcProvider } from "@/lib/rpc/provider-factory";
import { findAbiFunction } from "@/lib/abi/utils";
import { getErrorMessage } from "@/lib/utils";
import { getAbiFunctionKey } from "@/lib/abi/function-key";
import { getChainAdapter } from "@/lib/web3/chain-adapter";
import { formatContractError } from "@/lib/web3/decode-revert-error";
import {
  applyReadFailOnError,
  type ReadDestinationFailure,
} from "@/plugins/web3/steps/read-fail-on-error-core";
import {
  type AbiOutputParam,
  structureAbiOutputs,
} from "@/plugins/web3/steps/structure-abi-result";

export type ReadContractCoreInput = {
  contractAddress: string;
  network: string;
  abi: string;
  abiFunction: string;
  functionArgs?: string;
  // See applyReadFailOnError in read-fail-on-error-core.ts. When false, no
  // failure of this step fails the run.
  failOnError?: boolean;
  _context?: { executionId?: string; organizationId?: string };
};

export type ReadContractResult =
  | {
      success: true;
      result: unknown;
      addressLink: string;
      // Present only when failOnError=false softened a failed read into a
      // success value so the workflow continues. Absent on a genuine read;
      // `result` is null when it is set.
      error?: string;
    }
  | (ReadDestinationFailure & {
      success: false;
      error: string;
      errorClass?: ExecutionErrorType;
    });

/**
 * Core read contract logic
 *
 * Shared between the web3 read-contract step and the future protocol-read step.
 * Every failure exit runs through applyReadFailOnError, so the toggle covers
 * the validation exits above the chain call as well as the call itself.
 */
export async function readContractCore(
  input: ReadContractCoreInput
): Promise<ReadContractResult> {
  return applyReadFailOnError(
    await readContractInner(input),
    input.failOnError,
    { result: null, addressLink: "" }
  );
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Contract interaction requires extensive validation
async function readContractInner(
  input: ReadContractCoreInput
): Promise<ReadContractResult> {
  const { contractAddress, network, abi, abiFunction, functionArgs, _context } =
    input;

  if (!abiFunction || abiFunction.trim() === "") {
    logUserError(
      ErrorCategory.VALIDATION,
      "[Read Contract] Missing abiFunction",
      { abiFunction },
      { plugin_name: "web3", action_name: "read-contract" }
    );
    return {
      success: false,
      error: "Missing `abiFunction` in the step config",
      errorClass: ExecutionErrorType.USER,
    };
  }

  const userId = _context?.organizationId
    ? undefined
    : await getRpcPreferenceUserId(_context?.executionId);

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
      destinationError: true,
      error: `Invalid contract address: ${contractAddress}`,
      errorClass: ExecutionErrorType.USER,
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
      errorClass: ExecutionErrorType.USER,
    };
  }

  if (!Array.isArray(parsedAbi)) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[Read Contract] ABI is not an array",
      parsedAbi,
      { plugin_name: "web3", action_name: "read-contract" }
    );
    return { success: false, error: "ABI must be a JSON array", errorClass: ExecutionErrorType.USER };
  }

  const functionAbi = findAbiFunction(parsedAbi, abiFunction);

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
      errorClass: ExecutionErrorType.USER,
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
          errorClass: ExecutionErrorType.USER,
        };
      }
      args = parsedArgs.filter((arg, index) => {
        if (arg !== "") {
          return true;
        }
        return parsedArgs.slice(index + 1).some((a) => a !== "");
      });
      args = reshapeArgsForAbi(args, functionAbi);
      args = coerceArgsForAbi(args, functionAbi);
      const validation = validateArgsForAbi(args, functionAbi);
      if (!validation.ok) {
        return {
          success: false,
          error: `Invalid function arguments: ${validation.error}`,
          errorClass: ExecutionErrorType.USER,
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
        errorClass: ExecutionErrorType.USER,
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
    return {
      success: false,
      destinationError: true,
      error: getErrorMessage(error),
      errorClass: ExecutionErrorType.USER,
    };
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
    return {
      success: false,
      destinationError: true,
      error: getErrorMessage(error),
      errorClass: ExecutionErrorType.SYSTEM,
    };
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

    // Convert BigInt values to strings for JSON serialization. This also
    // flattens the ethers Result into positional arrays (its named getters are
    // non-enumerable and do not survive JSON), which is exactly the form
    // structureAbiOutputs consumes to re-attach ABI component names.
    const serializedResult = JSON.parse(
      JSON.stringify(result, (_, value) =>
        typeof value === "bigint" ? value.toString() : value
      )
    );

    const outputs =
      (functionAbi as { outputs?: AbiOutputParam[] }).outputs ?? [];

    let structuredResult: unknown = serializedResult;
    if (outputs.length > 0) {
      // The EVM adapter calls contract.getFunction(name)(...) / .staticCall(),
      // and ethers v6 auto-unwraps a single output: a scalar arrives as the
      // scalar (not a 1-element array) and a tuple arrives as its component
      // array. We therefore wrap the single output back into a one-element
      // positional array for structureAbiOutputs; multi-output calls already
      // arrive as a positional array. If the adapter ever stops auto-unwrapping
      // (e.g. switching to decodeFunctionResult), this normalization must move
      // to match batch-read-contract, which passes the N-element Result as-is.
      const outputValues =
        outputs.length === 1
          ? [serializedResult]
          : (serializedResult as unknown[]);
      structuredResult = structureAbiOutputs(outputValues, outputs);
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
    const message = formatContractError(error, contractInterface);
    return {
      success: false,
      error: message,
      errorClass: ExecutionErrorType.USER,
    };
  }
}
