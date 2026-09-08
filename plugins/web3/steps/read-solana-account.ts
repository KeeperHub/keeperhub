import "server-only";

import { runPluginStep, type StepInput } from "@/lib/workflow/executor/step-handler";
import {
  type ReadSolanaAccountCoreInput,
  type ReadSolanaAccountResult,
  readSolanaAccountCore,
} from "./read-solana-account-core";

export type {
  ReadSolanaAccountCoreInput,
  ReadSolanaAccountResult,
} from "./read-solana-account-core";

export type ReadSolanaAccountInput = StepInput & ReadSolanaAccountCoreInput;

/**
 * Read Solana Account Step
 * Reads the raw account info (owner, lamports, data) for a Solana address.
 */
export async function readSolanaAccountStep(
  input: ReadSolanaAccountInput
): Promise<ReadSolanaAccountResult> {
  "use step";

  return runPluginStep(
    { pluginName: "web3", actionName: "read-solana-account" },
    input,
    readSolanaAccountCore
  );
}

readSolanaAccountStep.maxRetries = 0;

export const _integrationType = "web3";
