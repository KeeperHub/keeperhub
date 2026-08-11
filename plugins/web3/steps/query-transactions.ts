import "server-only";

import { withPluginMetrics } from "@/lib/metrics/instrumentation/plugin";
import { type StepInput, withStepLogging } from "@/lib/workflow/executor/step-handler";
import {
  type QueryTransactionsCoreInput,
  type QueryTransactionsResult,
  queryTransactionsCore,
} from "./query-transactions-core";

export type QueryTransactionsInput = StepInput & QueryTransactionsCoreInput;

export async function queryTransactionsStep(
  input: QueryTransactionsInput
): Promise<QueryTransactionsResult> {
  "use step";

  return await withPluginMetrics(
    {
      pluginName: "web3",
      actionName: "query-transactions",
      executionId: input._context?.executionId,
    },
    () => withStepLogging(input, () => queryTransactionsCore(input))
  );
}

queryTransactionsStep.maxRetries = 0;

export const _integrationType = "web3";
