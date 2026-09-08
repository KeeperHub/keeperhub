import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import { type InfoResult, postInfo } from "./info-request-core";

export type FundingHistoryCoreInput = {
  coin: string;
  startTime: string | number;
  endTime?: string | number;
};

export type FundingHistoryInput = StepInput & FundingHistoryCoreInput;

function parseTimestamp(value: string | number): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    return null;
  }
  return n;
}

async function stepHandler(
  input: FundingHistoryCoreInput
): Promise<InfoResult> {
  if (!input.coin) {
    return { success: false, error: "Coin is required", errorClass: ExecutionErrorType.USER };
  }

  const startTime = parseTimestamp(input.startTime);
  if (startTime === null) {
    return {
      success: false,
      error: "startTime must be a positive integer Unix timestamp in milliseconds",
      errorClass: ExecutionErrorType.USER,
    };
  }

  const body: Record<string, unknown> = {
    type: "fundingHistory",
    coin: input.coin,
    startTime,
  };

  if (input.endTime !== undefined && input.endTime !== "") {
    const endTime = parseTimestamp(input.endTime);
    if (endTime === null) {
      return {
        success: false,
        error: "endTime must be a positive integer Unix timestamp in milliseconds",
        errorClass: ExecutionErrorType.USER,
      };
    }
    if (endTime < startTime) {
      return {
        success: false,
        error: "endTime must be greater than or equal to startTime",
        errorClass: ExecutionErrorType.USER,
      };
    }
    body.endTime = endTime;
  }

  return postInfo(body, "funding-history");
}

// biome-ignore lint/suspicious/useAwait: "use step" directive requires async
export async function fundingHistoryStep(
  input: FundingHistoryInput
): Promise<InfoResult> {
  "use step";

  return runPluginStep(
    { pluginName: "hyperliquid", actionName: "funding-history" },
    input,
    stepHandler
  );
}

export const _integrationType = "hyperliquid";
