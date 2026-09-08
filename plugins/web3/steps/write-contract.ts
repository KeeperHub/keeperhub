import "server-only";

import { withPluginMetrics } from "@/lib/metrics/instrumentation/plugin";
import { withStepValueCap } from "@/lib/execute/value-ledger";
import { resolveExplorerLink } from "@/lib/web3/explorer-link";
import { type StepInput, withStepLogging } from "@/lib/workflow/executor/step-handler";
import {
  applyFailOnError,
  type WriteContractCoreInput,
  type WriteContractResult,
  writeContractCore,
} from "./write-contract-core";

export type WriteContractInput = StepInput &
  WriteContractCoreInput & {
    // Mirrors HTTP Request's failOnError. Defaults to true. When false, a
    // failure encountered while attempting the on-chain send (signer init,
    // broadcast, revert) is softened into a success carrying `error` instead
    // of failing the step, so the workflow continues. See
    // applyFailOnError in write-contract-core.ts for exactly which failures
    // qualify.
    failOnError?: boolean;
  };

/**
 * Write Contract Step
 * Writes data to a smart contract using state-changing functions
 */
export async function writeContractStep(
  input: WriteContractInput
): Promise<WriteContractResult> {
  "use step";

  // Enrich input with contract address explorer link for the execution log
  const contractAddressLink = await resolveExplorerLink(
    input.network,
    input.contractAddress
  );
  const enrichedInput: WriteContractInput & { contractAddressLink?: string } =
    contractAddressLink ? { ...input, contractAddressLink } : input;

  return withPluginMetrics(
    {
      pluginName: "web3",
      actionName: "write-contract",
      executionId: input._context?.executionId,
    },
    () =>
      withStepLogging(enrichedInput, async () => {
        // applyFailOnError must run here, after withStepValueCap resolves.
        // The value-cap settle/release decision is keyed on the true
        // success/failure of writeContractCore, so softening the result
        // inside withStepValueCap's run() would settle a reservation for a
        // transaction that actually reverted.
        //
        // withStepValueCap can itself deny the call (e.g. daily cap
        // exceeded) before writeContractCore ever runs, and that denial
        // carries no errorClass. coreResult tracks whether writeContractCore
        // actually produced the returned value, so a cap denial is never
        // passed to applyFailOnError and always hard-fails.
        let coreResult: WriteContractResult | undefined;
        const result = await withStepValueCap(
          {
            organizationId: input._context?.organizationId,
            stepFunction: "writeContractStep",
            config: { ethValue: input.ethValue },
            executionId: input._context?.executionId,
            valueCapReserved: input._context?.valueCapReserved,
          },
          async () => {
            coreResult = await writeContractCore(input);
            return coreResult;
          }
        );
        return result === coreResult
          ? applyFailOnError(result, input.failOnError)
          : result;
      })
  );
}

writeContractStep.maxRetries = 0;

export const _integrationType = "web3";
