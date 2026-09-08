import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import { ErrorCategory, logUserError } from "@/lib/logging";
import { runPluginStep, type StepInput } from "@/lib/workflow/executor/step-handler";
import { getErrorMessage } from "@/lib/utils";
import { cowFetch, type CowSwapFailure, resolveCowChainPath } from "./cowswap-core";

const PLUGIN_NAME = "cowswap";
const ACTION_NAME = "get-account-orders";

export type GetAccountOrdersInput = StepInput & {
  network: string;
  ownerAddress: string;
  limit?: string;
};

type GetAccountOrdersResult =
  | { success: true; orders: unknown[]; count: number }
  | CowSwapFailure;

async function stepHandler(
  input: GetAccountOrdersInput
): Promise<GetAccountOrdersResult> {
  if (!input.ownerAddress) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[CoW Swap] Missing ownerAddress for get-account-orders",
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

  const limit = input.limit ?? "50";
  const url = `https://api.cow.fi/${resolved.chainPath}/api/v1/account/${encodeURIComponent(input.ownerAddress)}/orders?limit=${encodeURIComponent(limit)}`;

  try {
    const result = await cowFetch(url, { actionName: ACTION_NAME });

    if ("error" in result) {
      return result;
    }

    const orders = (await result.response.json()) as unknown[];
    return { success: true, orders, count: orders.length };
  } catch (error) {
    logUserError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[CoW Swap] Error fetching account orders",
      error,
      { plugin_name: PLUGIN_NAME, action_name: ACTION_NAME, service: "cow-api" }
    );
    return {
      success: false,
      error: `Failed to fetch account orders: ${getErrorMessage(error)}`,
      errorClass: ExecutionErrorType.EXTERNAL,
    };
  }
}

export async function getAccountOrdersStep(
  input: GetAccountOrdersInput
): Promise<GetAccountOrdersResult> {
  "use step";

  return runPluginStep(
    { pluginName: PLUGIN_NAME, actionName: ACTION_NAME },
    input,
    stepHandler
  );
}

export const _integrationType = "cowswap";
