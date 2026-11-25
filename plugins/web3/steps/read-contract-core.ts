/**
 * Core read-contract logic shared between web3 read-contract and protocol-read steps.
 *
 * IMPORTANT: This file must NOT contain "use step" or be a step file.
 * It exists so that multiple step files can reuse read logic without
 * exporting functions from "use step" files (which breaks the workflow bundler).
 */
import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import { ethers } from "ethers";
import {
  asRawFunctionArgs,
  coerceArgsForAbi,
  reshapeArgsForAbi,
} from "@/lib/abi/struct-args";
import { validateArgsForAbi } from "@/lib/abi/validate-args";
import { ErrorCategory, logUserError } from "@/lib/logging";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import {
  RPC_SELECTION_CONFIG_KEY,
  RpcPurpose,
  RpcRouteError,
  rpc,
  rpcScopeFromStep,
} from "@/lib/rpc/engine";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import {
  describeAmbiguousKey,
  resolveAbiFunction,
} from "@/lib/abi/utils";
import { getErrorMessage } from "@/lib/utils";
import { getAbiFunctionKey } from "@/lib/abi/function-key";
import { getChainAdapter } from "@/lib/web3/chain-adapter";
import { formatContractError } from "@/lib/web3/decode-revert-error";
import { buildErrorDecodeInterface } from "@/lib/web3/extra-error-abis";
import {
  type NextBlockSimulation,
  getNextBlockSimulation,
  isNextBlockSimulationUnsupported,
  nextBlockFailure,
  readSimulationSettings,
  type SimulateAt,
  simulateCallAtNextBlock,
  unsupportedFailure,
} from "@/lib/web3/next-block-simulation";
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
  // A JSON string from the abi-function-args UI field, or a native array from
  // a direct/MCP caller and, since #2359, from the executor rendering a
  // template inside one. query-transactions has taken both shapes for the
  // same widget all along; this step declared the string only.
  functionArgs?: string | unknown[];
  // The address the call is made from. Some contracts answer differently
  // depending on who asks, and a read with no caller is a read as address(0),
  // which is itself a specific address. Absent means the field carries
  // nothing - undefined, null or the empty string - so a template that renders
  // to nothing leaves the call unchanged rather than failing it.
  callerAddress?: string;
  // See applyReadFailOnError in read-fail-on-error-core.ts. When false, no
  // failure of this step fails the run.
  failOnError?: boolean;
  // #2430: extra ABI documents whose error entries join the decode path, after
  // `abi`. Decoding only - `abi` still encodes the call and reads its result.
  errorAbis?: string[];
  // "next-block" reads as of the next block (number + 1, its predicted time).
  // Unset or "latest" = today's behaviour.
  simulateAt?: SimulateAt;
  // Block time (slot length) in seconds; unset = the chain's measured one.
  simulateTimestampOffsetSec?: string | number;
  _context?: { executionId?: string; organizationId?: string };
  [RPC_SELECTION_CONFIG_KEY]?: unknown;
};

export type ReadContractResult =
  | {
      success: true;
      result: unknown;
      addressLink: string;
      // The predicted block a next-block read ran against.
      simulation?: NextBlockSimulation;
      // Present only when failOnError=false softened a failed read into a
      // success value so the workflow continues. Absent on a genuine read;
      // `result` is null when it is set.
      error?: string;
    }
  | (ReadDestinationFailure & {
      success: false;
      error: string;
      errorClass?: ExecutionErrorType;
      simulation?: NextBlockSimulation;
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
  const result = await readContractInner(input);
  // A softened failure keeps the predicted block it was read at.
  const simulation = result.success ? undefined : result.simulation;
  return applyReadFailOnError(result, input.failOnError, {
    result: null,
    addressLink: "",
    ...(simulation ? { simulation } : {}),
  });
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Contract interaction requires extensive validation
async function readContractInner(
  input: ReadContractCoreInput
): Promise<ReadContractResult> {
  const {
    contractAddress,
    network,
    abi,
    abiFunction,
    functionArgs,
    callerAddress,
    errorAbis,
    simulateAt,
    simulateTimestampOffsetSec,
  } = input;

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

  // A blank caller is no caller. Absent is undefined, null or the empty
  // string, which is exactly the set validateFieldValue early-returns as valid
  // (lib/workflow/validation/action-config.ts), so save time and run time
  // agree on what "no caller" is. A whitespace-only value is deliberately not
  // in that set: the isAddressField branch rejects it at save time, and it
  // fails isAddress here, rather than one layer treating it as absent while
  // the other calls it invalid. The value is still trimmed before it is read,
  // so a template that renders with stray whitespace around an address works.
  //
  // Only a value that is present and not an address is an error, and it is a
  // payload error rather than a destination one: failOnError softens it the
  // way it softens an unparseable argument list, not the way it hard-fails an
  // invalid contract address.
  const givenCaller = callerAddress ?? "";
  const caller = givenCaller === "" ? undefined : givenCaller.trim();
  if (caller !== undefined && !ethers.isAddress(caller)) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[Read Contract] Invalid caller address:",
      callerAddress,
      { plugin_name: "web3", action_name: "read-contract" }
    );
    return {
      success: false,
      error: `Invalid caller address: ${callerAddress}`,
      errorClass: ExecutionErrorType.USER,
    };
  }

  const simulationSettings = readSimulationSettings(
    simulateAt,
    simulateTimestampOffsetSec
  );
  if (!simulationSettings.ok) {
    return simulationSettings.failure;
  }
  const simulation = simulationSettings.options;

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

  const resolution = resolveAbiFunction(parsedAbi, abiFunction);

  if (resolution.status === "ambiguous") {
    const error = describeAmbiguousKey(abiFunction, resolution.candidates);
    logUserError(
      ErrorCategory.VALIDATION,
      "[Read Contract] Ambiguous function key:",
      abiFunction,
      { plugin_name: "web3", action_name: "read-contract" }
    );
    return { success: false, error, errorClass: ExecutionErrorType.USER };
  }

  if (resolution.status !== "found") {
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

  const functionAbi = resolution.entry;
  const abiFunctionKey = getAbiFunctionKey(parsedAbi, abiFunction, functionAbi);

  // Fragment errors are deterministic user input errors, not provider failures.
  // Validate before entering the adapter's RPC failover loop.
  let contractInterface: ethers.Interface;
  try {
    contractInterface = new ethers.Interface(parsedAbi as ethers.InterfaceAbi);
    if (!contractInterface.getFunction(abiFunctionKey)) {
      throw new Error(`Function '${abiFunction}' has no valid ABI fragment`);
    }
  } catch (error) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[Read Contract] Invalid ABI function:",
      error,
      { plugin_name: "web3", action_name: "read-contract" }
    );
    return {
      success: false,
      error: `Invalid ABI function '${abiFunction}': ${getErrorMessage(error)}`,
      errorClass: ExecutionErrorType.USER,
    };
  }

  // Parse function arguments. A native array is taken as it is and a string
  // is parsed as JSON; an empty, absent or falsy value means no arguments.
  let args: unknown[] = [];
  const rawArgs = asRawFunctionArgs(functionArgs);
  if (rawArgs !== undefined) {
    try {
      const parsedArgs: unknown = Array.isArray(rawArgs)
        ? rawArgs
        : JSON.parse(rawArgs);
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
  const scope = rpcScopeFromStep(input);
  let rpcManager: RpcProviderManager;
  try {
    const client = await rpc.evm(scope, chainId, { purpose: RpcPurpose.READ });
    rpcManager = client.manager;
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
      errorClass:
        error instanceof RpcRouteError
          ? ExecutionErrorType.USER
          : ExecutionErrorType.SYSTEM,
    };
  }

  const adapter = getChainAdapter(chainId, scope);
  const isView =
    functionAbi.stateMutability === "view" ||
    functionAbi.stateMutability === "pure";

  try {
    let result: unknown;
    let nextBlock: NextBlockSimulation | undefined;
    if (simulation) {
      const simulated = await simulateCallAtNextBlock(rpcManager, {
        chainId,
        tx: {
          from: caller,
          to: contractAddress,
          data: contractInterface.encodeFunctionData(abiFunctionKey, args),
        },
        options: simulation,
        operationType: "read",
      });
      // Unwrap a single output the way ethers' Contract call does, so the
      // normalisation below sees the same shape on both paths.
      const decoded = contractInterface.decodeFunctionResult(
        abiFunctionKey,
        simulated.returnData
      );
      result = decoded.length === 1 ? decoded[0] : decoded;
      nextBlock = simulated.simulation;
    } else {
      result = await adapter.readContract(rpcManager, {
        contractAddress,
        abi: parsedAbi as ethers.InterfaceAbi,
        functionKey: abiFunctionKey,
        args,
        isView,
        ...(caller ? { callerAddress: caller } : {}),
      });
    }

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
      ...(nextBlock ? { simulation: nextBlock } : {}),
    };
  } catch (error) {
    if (isNextBlockSimulationUnsupported(error)) {
      return { ...unsupportedFailure(error, "read-contract"), destinationError: true };
    }
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
      ...nextBlockFailure(
        formatContractError(
          error,
          buildErrorDecodeInterface(contractInterface, errorAbis)
        ),
        getNextBlockSimulation(error)
      ),
      errorClass: ExecutionErrorType.USER,
    };
  }
}
