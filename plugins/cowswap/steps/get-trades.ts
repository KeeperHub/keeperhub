import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import { ErrorCategory, logUserError } from "@/lib/logging";
import { runPluginStep, type StepInput } from "@/lib/workflow/executor/step-handler";
import { getErrorMessage } from "@/lib/utils";
import { cowFetch, type CowSwapFailure, resolveCowChainPath } from "./cowswap-core";

const PLUGIN_NAME = "cowswap";
const ACTION_NAME = "get-trades";

export type GetTradesInput = StepInput & {
  network: string;
  ownerAddress: string;
};

type GetTradesResult =
  | { success: true; trades: unknown[]; count: number }
  | CowSwapFailure;

async function stepHandler(input: GetTradesInput): Promise<GetTradesResult> {
  if (!input.ownerAddress) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[CoW Swap] Missing ownerAddress for get-trades",
      undefined,
      { plugin_name: PLUGIN_NAME, action_name: ACTION_NAME }
    );
    return {
      success: false,
      error: "ownerAddress is required",
      errorClass: ExecutionErrorType.USER,
    };
  }

  const resolved = resolveCowChainPath(input.network, ACTION_NAME);
  if ("error" in resolved) {
    return resolved;
  }

  const url = `https://api.cow.fi/${resolved.chainPath}/api/v2/trades?owner=${encodeURIComponent(input.ownerAddress)}`;

  try {
    const result = await cowFetch(url, { actionName: ACTION_NAME });

    if ("error" in result) {
      return result;
    }

    const trades = (await result.response.json()) as unknown[];
    return { success: true, trades, count: trades.length };
  } catch (error) {
    logUserError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[CoW Swap] Error fetching trades",
      error,
      { plugin_name: PLUGIN_NAME, action_name: ACTION_NAME, service: "cow-api" }
    );
    return {
      success: false,
      error: `Failed to fetch trades: ${getErrorMessage(error)}`,
      errorClass: ExecutionErrorType.EXTERNAL,
    };
  }
}

export async function getTradesStep(
  input: GetTradesInput
): Promise<GetTradesResult> {
  "use step";

  return runPluginStep(
    { pluginName: PLUGIN_NAME, actionName: ACTION_NAME },
    input,
    stepHandler
  );
}

export const _integrationType = "cowswap";
