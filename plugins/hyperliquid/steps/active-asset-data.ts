import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import { type InfoResult, isEvmAddress, postInfo } from "./info-request-core";

export type ActiveAssetDataCoreInput = {
  user: string;
  coin: string;
};

export type ActiveAssetDataInput = StepInput & ActiveAssetDataCoreInput;

// Hyperliquid's `activeAssetCtx` is a WebSocket subscription type, not an
// Info POST endpoint. The Info equivalent that returns the same user+coin
// context (leverage, max trade sizes, available balance, mark price) is
// `activeAssetData`.
async function stepHandler(
  input: ActiveAssetDataCoreInput
): Promise<InfoResult> {
  if (!isEvmAddress(input.user)) {
    return {
      success: false,
      error: "User must be a 0x-prefixed EVM address",
      errorClass: ExecutionErrorType.USER,
    };
  }
  if (!input.coin) {
    return { success: false, error: "Coin is required", errorClass: ExecutionErrorType.USER };
  }

  return postInfo(
    { type: "activeAssetData", user: input.user, coin: input.coin },
    "active-asset-data"
  );
}

// biome-ignore lint/suspicious/useAwait: "use step" directive requires async
export async function activeAssetDataStep(
  input: ActiveAssetDataInput
): Promise<InfoResult> {
  "use step";

  return runPluginStep(
    { pluginName: "hyperliquid", actionName: "active-asset-data" },
    input,
    stepHandler
  );
}

export const _integrationType = "hyperliquid";
