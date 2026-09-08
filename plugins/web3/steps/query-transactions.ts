import "server-only";

import { runPluginStep, type StepInput } from "@/lib/workflow/executor/step-handler";
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

  return runPluginStep(
    { pluginName: "web3", actionName: "query-transactions" },
    input,
    queryTransactionsCore
  );
}

queryTransactionsStep.maxRetries = 0;

export const _integrationType = "web3";
