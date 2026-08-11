import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import { ErrorCategory, logUserError } from "@/lib/logging";
import { withPluginMetrics } from "@/lib/metrics/instrumentation/plugin";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { safeFetch } from "@/lib/safe-fetch";
import { type StepInput, withStepLogging } from "@/lib/workflow/executor/step-handler";
import { getErrorMessage } from "@/lib/utils";

const PLUGIN_NAME = "cowswap";
const ACTION_NAME = "get-quote";
const FETCH_TIMEOUT_MS = 15_000;

const COW_API_CHAIN_PATHS: Record<number, string> = {
  1: "mainnet",
  8453: "base",
  42161: "arbitrum_one",
  10: "optimism",
};

export type GetQuoteInput = StepInput & {
  network: string;
  sellToken: string;
  buyToken: string;
  from: string;
  kind: string;
  amount: string;
};

type GetQuoteResult =
  | {
      success: true;
      buyAmount: string;
      sellAmount: string;
      feeAmount: string;
      quote: unknown;
    }
  | {
      success: false;
      error: string;
      errorClass?: ExecutionErrorType;
    };

type CowQuoteResponse = {
  quote: {
    buyAmount: string;
    sellAmount: string;
    feeAmount: string;
  };
};

async function stepHandler(input: GetQuoteInput): Promise<GetQuoteResult> {
  if (!input.sellToken || !input.buyToken || !input.from) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[CoW Swap] Missing required fields for get-quote",
      undefined,
      { plugin_name: PLUGIN_NAME, action_name: ACTION_NAME }
    );
    return {
      success: false,
      error: "sellToken, buyToken, and from are required",
      errorClass: ExecutionErrorType.USER,
    };
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

  const kind = input.kind === "buy" ? "buy" : "sell";
  const body: Record<string, string> = {
    sellToken: input.sellToken,
    buyToken: input.buyToken,
    from: input.from,
    kind,
  };

  if (kind === "sell") {
    body.sellAmountBeforeFee = input.amount;
  } else {
    body.buyAmountAfterFee = input.amount;
  }

  const url = `https://api.cow.fi/${chainPath}/api/v1/quote`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const response = await safeFetch(url, {
      plugin: "cowswap",
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      logUserError(
        ErrorCategory.EXTERNAL_SERVICE,
        "[CoW Swap] API error on get-quote",
        { status: response.status, body: errorBody },
        { plugin_name: PLUGIN_NAME, action_name: ACTION_NAME, service: "cow-api" }
      );
      return {
        success: false,
        error: `CoW Swap API returned HTTP ${response.status}: ${errorBody}`,
        errorClass: response.status >= 500 ? ExecutionErrorType.EXTERNAL : ExecutionErrorType.USER,
      };
    }

    const data = (await response.json()) as CowQuoteResponse;
    return {
      success: true,
      buyAmount: data.quote.buyAmount,
      sellAmount: data.quote.sellAmount,
      feeAmount: data.quote.feeAmount,
      quote: data.quote,
    };
  } catch (error) {
    logUserError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[CoW Swap] Error fetching quote",
      error,
      { plugin_name: PLUGIN_NAME, action_name: ACTION_NAME, service: "cow-api" }
    );
    return {
      success: false,
      error: `Failed to fetch quote: ${getErrorMessage(error)}`,
      errorClass: ExecutionErrorType.EXTERNAL,
    };
  }
}

export async function getQuoteStep(input: GetQuoteInput): Promise<GetQuoteResult> {
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
