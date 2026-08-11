import "server-only";

import { withStepValueCap } from "@/lib/execute/value-ledger";
import { withPluginMetrics } from "@/lib/metrics/instrumentation/plugin";
import {
  type StepInput,
  withStepLogging,
} from "@/lib/workflow/executor/step-handler";
import type {
  SendRawSolanaInstructionCoreInput,
  SendRawSolanaInstructionResult,
} from "./send-raw-solana-instruction-core";
import { sendRawSolanaInstructionCore } from "./send-raw-solana-instruction-core";

export type {
  SendRawSolanaInstructionCoreInput,
  SendRawSolanaInstructionResult,
} from "./send-raw-solana-instruction-core";

export type SendRawSolanaInstructionInput = StepInput &
  SendRawSolanaInstructionCoreInput;

/**
 * Send Raw Solana Instruction Step
 * Builds and submits an arbitrary Solana transaction from user-supplied
 * instructions (programId, accounts, data) via the organization wallet.
 */
export async function sendRawSolanaInstructionStep(
  input: SendRawSolanaInstructionInput
): Promise<SendRawSolanaInstructionResult> {
  "use step";

  return withPluginMetrics(
    {
      pluginName: "web3",
      actionName: "send-raw-solana-instruction",
      executionId: input._context?.executionId,
    },
    () =>
      withStepLogging(input, () =>
        withStepValueCap(
          {
            organizationId: input._context?.organizationId,
            stepFunction: "sendRawSolanaInstructionStep",
            config: { network: input.network, maxSol: input.maxSol },
            executionId: input._context?.executionId,
            valueCapReserved: input._context?.valueCapReserved,
          },
          () => sendRawSolanaInstructionCore(input)
        )
      )
  );
}

sendRawSolanaInstructionStep.maxRetries = 0;

export const _integrationType = "web3";
