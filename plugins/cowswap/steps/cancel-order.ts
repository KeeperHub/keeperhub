import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import { ErrorCategory, logUserError } from "@/lib/logging";
import { runPluginStep, type StepInput } from "@/lib/workflow/executor/step-handler";
import { getErrorMessage } from "@/lib/utils";
import { cowFetch, type CowSwapFailure, resolveCowChainPath } from "./cowswap-core";

const PLUGIN_NAME = "cowswap";
const ACTION_NAME = "cancel-order";

export type CancelOrderInput = StepInput & {
  network: string;
  orderUid: string;
};

type CancelOrderResult = { success: true } | CowSwapFailure;

async function stepHandler(input: CancelOrderInput): Promise<CancelOrderResult> {
  if (!input.orderUid) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[CoW Swap] Missing orderUid for cancel-order",
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
    const result = await cowFetch(url, {
      actionName: ACTION_NAME,
      method: "DELETE",
    });

    if ("error" in result) {
      return result;
    }

    return { success: true };
  } catch (error) {
    logUserError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[CoW Swap] Error cancelling order",
      error,
      { plugin_name: PLUGIN_NAME, action_name: ACTION_NAME, service: "cow-api" }
    );
    return {
      success: false,
      error: `Failed to cancel order: ${getErrorMessage(error)}`,
      errorClass: ExecutionErrorType.EXTERNAL,
    };
  }
}

export async function cancelOrderStep(
  input: CancelOrderInput
): Promise<CancelOrderResult> {
  "use step";

  return runPluginStep(
    { pluginName: PLUGIN_NAME, actionName: ACTION_NAME },
    input,
    stepHandler
  );
}
cancelOrderStep.maxRetries = 0;

export const _integrationType = "cowswap";
