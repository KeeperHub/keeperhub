import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import { ErrorCategory, logUserError } from "@/lib/logging";
import { runPluginStep, type StepInput } from "@/lib/workflow/executor/step-handler";
import { getErrorMessage } from "@/lib/utils";
import { cowFetch, type CowSwapFailure, resolveCowChainPath } from "./cowswap-core";

const PLUGIN_NAME = "cowswap";
const ACTION_NAME = "create-order";

export type CreateOrderInput = StepInput & {
  network: string;
  orderPayload: string;
};

type CreateOrderResult = { success: true; orderUid: string } | CowSwapFailure;

async function stepHandler(input: CreateOrderInput): Promise<CreateOrderResult> {
  if (!input.orderPayload) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[CoW Swap] Missing orderPayload for create-order",
      undefined,
      { plugin_name: PLUGIN_NAME, action_name: ACTION_NAME }
    );
    return {
      success: false,
      error: "orderPayload is required",
      errorClass: ExecutionErrorType.USER,
    };
  }

  let parsedOrder: unknown;
  try {
    parsedOrder = JSON.parse(input.orderPayload);
  } catch {
    logUserError(
      ErrorCategory.VALIDATION,
      "[CoW Swap] Invalid JSON in orderPayload",
      undefined,
      { plugin_name: PLUGIN_NAME, action_name: ACTION_NAME }
    );
    return {
      success: false,
      error: "orderPayload must be valid JSON",
      errorClass: ExecutionErrorType.USER,
    };
  }

  const resolved = resolveCowChainPath(input.network, ACTION_NAME);
  if ("error" in resolved) {
    return resolved;
  }

  const url = `https://api.cow.fi/${resolved.chainPath}/api/v1/orders`;

  try {
    const result = await cowFetch(url, {
      actionName: ACTION_NAME,
      method: "POST",
      body: JSON.stringify(parsedOrder),
    });

    if ("error" in result) {
      return result;
    }

    const orderUid = (await result.response.json()) as string;
    return { success: true, orderUid };
  } catch (error) {
    logUserError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[CoW Swap] Error creating order",
      error,
      { plugin_name: PLUGIN_NAME, action_name: ACTION_NAME, service: "cow-api" }
    );
    return {
      success: false,
      error: `Failed to create order: ${getErrorMessage(error)}`,
      errorClass: ExecutionErrorType.EXTERNAL,
    };
  }
}

export async function createOrderStep(
  input: CreateOrderInput
): Promise<CreateOrderResult> {
  "use step";

  return runPluginStep(
    { pluginName: PLUGIN_NAME, actionName: ACTION_NAME },
    input,
    stepHandler
  );
}
createOrderStep.maxRetries = 0;

export const _integrationType = "cowswap";
