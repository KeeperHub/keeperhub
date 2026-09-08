import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import { ErrorCategory, logUserError } from "@/lib/logging";
import { runPluginStep, type StepInput } from "@/lib/workflow/executor/step-handler";
import { getErrorMessage } from "@/lib/utils";
import { cowFetch, type CowSwapFailure, resolveCowChainPath } from "./cowswap-core";

const PLUGIN_NAME = "cowswap";
const ACTION_NAME = "get-order-status";

export type GetOrderStatusInput = StepInput & {
  network: string;
  orderUid: string;
};

type GetOrderStatusResult =
  | {
      success: true;
      status: string;
      filledAmount: string;
      executedBuyAmount: string;
      executedSellAmount: string;
      order: unknown;
    }
  | CowSwapFailure;

type CowOrderResponse = {
  status: string;
  executedBuyAmount: string;
  executedSellAmount: string;
  executedFeeAmount: string;
};

async function stepHandler(
  input: GetOrderStatusInput
): Promise<GetOrderStatusResult> {
  if (!input.orderUid) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[CoW Swap] Missing orderUid for get-order-status",
      undefined,
      { plugin_name: PLUGIN_NAME, action_name: ACTION_NAME }
    );
    return { success: false, error: "orderUid is required", errorClass: ExecutionErrorType.USER };
  }

  const resolved = resolveCowChainPath(input.network, ACTION_NAME);
  if ("error" in resolved) {
    return resolved;
  }

  const url = `https://api.cow.fi/${resolved.chainPath}/api/v1/orders/${encodeURIComponent(input.orderUid)}`;

  try {
    const result = await cowFetch(url, { actionName: ACTION_NAME });

    if ("error" in result) {
      return result;
    }

    const data = (await result.response.json()) as CowOrderResponse;
    return {
      success: true,
      status: data.status,
      filledAmount: data.executedSellAmount,
      executedBuyAmount: data.executedBuyAmount,
      executedSellAmount: data.executedSellAmount,
      order: data,
    };
  } catch (error) {
    logUserError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[CoW Swap] Error fetching order status",
      error,
      { plugin_name: PLUGIN_NAME, action_name: ACTION_NAME, service: "cow-api" }
    );
    return {
      success: false,
      error: `Failed to fetch order status: ${getErrorMessage(error)}`,
      errorClass: ExecutionErrorType.EXTERNAL,
    };
  }
}

export async function getOrderStatusStep(
  input: GetOrderStatusInput
): Promise<GetOrderStatusResult> {
  "use step";

  return runPluginStep(
    { pluginName: PLUGIN_NAME, actionName: ACTION_NAME },
    input,
    stepHandler
  );
}

export const _integrationType = "cowswap";
