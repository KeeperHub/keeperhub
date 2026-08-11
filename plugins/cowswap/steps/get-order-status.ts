import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import { ErrorCategory, logUserError } from "@/lib/logging";
import { withPluginMetrics } from "@/lib/metrics/instrumentation/plugin";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { safeFetch } from "@/lib/safe-fetch";
import { type StepInput, withStepLogging } from "@/lib/workflow/executor/step-handler";
import { getErrorMessage } from "@/lib/utils";

const PLUGIN_NAME = "cowswap";
const ACTION_NAME = "get-order-status";
const FETCH_TIMEOUT_MS = 15_000;

const COW_API_CHAIN_PATHS: Record<number, string> = {
  1: "mainnet",
  8453: "base",
  42161: "arbitrum_one",
  10: "optimism",
};

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
  | {
      success: false;
      error: string;
      errorClass?: ExecutionErrorType;
    };

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

  let chainId: number;
  try {
    chainId = getChainIdFromNetwork(input.network);
  } catch (error) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[CoW Swap] Unsupported network",
      input.network,
      { plugin_name: PLUGIN_NAME, action_name: ACTION_NAME }
    );
    return {
      success: false,
      error: `Unsupported network: ${getErrorMessage(error)}`,
      errorClass: ExecutionErrorType.USER,
    };
  }

  const chainPath = COW_API_CHAIN_PATHS[chainId];
  if (!chainPath) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[CoW Swap] Network not supported by CoW Swap API",
      { chainId, network: input.network },
      { plugin_name: PLUGIN_NAME, action_name: ACTION_NAME }
    );
    return {
      success: false,
      error: `Chain ID ${chainId} is not supported by the CoW Swap API`,
      errorClass: ExecutionErrorType.USER,
    };
  }

  const url = `https://api.cow.fi/${chainPath}/api/v1/orders/${encodeURIComponent(input.orderUid)}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const response = await safeFetch(url, {
      plugin: "cowswap",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      logUserError(
        ErrorCategory.EXTERNAL_SERVICE,
        "[CoW Swap] API error on get-order-status",
        { status: response.status, body: errorBody },
        { plugin_name: PLUGIN_NAME, action_name: ACTION_NAME, service: "cow-api" }
      );
      return {
        success: false,
        error: `CoW Swap API returned HTTP ${response.status}: ${errorBody}`,
        errorClass: response.status >= 500 ? ExecutionErrorType.EXTERNAL : ExecutionErrorType.USER,
      };
    }

    const data = (await response.json()) as CowOrderResponse;
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

  return withPluginMetrics(
    {
      pluginName: PLUGIN_NAME,
      actionName: ACTION_NAME,
      executionId: input._context?.executionId,
    },
    () => withStepLogging(input, () => stepHandler(input))
  );
}

export const _integrationType = "cowswap";
