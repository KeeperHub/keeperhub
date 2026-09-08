import "server-only";

import { resolveExplorerLink } from "@/lib/web3/explorer-link";
import { runPluginStep, type StepInput } from "@/lib/workflow/executor/step-handler";
import {
  type ReadContractCoreInput,
  type ReadContractResult,
  readContractCore,
} from "./read-contract-core";

export type ReadContractInput = StepInput & ReadContractCoreInput;

/**
 * Read Contract Step
 * Reads data from a smart contract using view/pure functions
 */
export async function readContractStep(
  input: ReadContractInput
): Promise<ReadContractResult> {
  "use step";

  // Enrich input with contract address explorer link for the execution log
  const contractAddressLink = await resolveExplorerLink(
    input.network,
    input.contractAddress
  );
  const enrichedInput: ReadContractInput & { contractAddressLink?: string } =
    contractAddressLink ? { ...input, contractAddressLink } : input;

  return runPluginStep(
    { pluginName: "web3", actionName: "read-contract" },
    enrichedInput,
    () => readContractCore(input)
  );
}

readContractStep.maxRetries = 0;

export const _integrationType = "web3";
