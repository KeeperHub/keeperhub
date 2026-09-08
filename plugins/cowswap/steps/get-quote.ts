import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import { ErrorCategory, logUserError } from "@/lib/logging";
import { runPluginStep, type StepInput } from "@/lib/workflow/executor/step-handler";
import { getErrorMessage } from "@/lib/utils";
import { cowFetch, type CowSwapFailure, resolveCowChainPath } from "./cowswap-core";

const PLUGIN_NAME = "cowswap";
const ACTION_NAME = "get-quote";

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
  | CowSwapFailure;

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

  const resolved = resolveCowChainPath(input.network, ACTION_NAME);
  if ("error" in resolved) {
    return resolved;
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

  const url = `https://api.cow.fi/${resolved.chainPath}/api/v1/quote`;

  try {
    const result = await cowFetch(url, {
      actionName: ACTION_NAME,
      method: "POST",
      body: JSON.stringify(body),
    });

    if ("error" in result) {
      return result;
    }

    const data = (await result.response.json()) as CowQuoteResponse;
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

  return runPluginStep(
    { pluginName: PLUGIN_NAME, actionName: ACTION_NAME },
    input,
    stepHandler
  );
}

export const _integrationType = "cowswap";
