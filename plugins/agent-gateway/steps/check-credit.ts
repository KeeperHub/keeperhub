import "server-only";

import { fetchCredentials } from "@/lib/credential-fetcher";
import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import type { CheckCreditResult } from "./check-credit-core";
import { checkCreditCore } from "./check-credit-core";

export type { CheckCreditResult };

// The action has no config fields; the only input is the reference the step
// resolves credentials from. The executor builds step input without
// credentials, so they have to be fetched here.
export type CheckCreditInput = StepInput & {
  integrationId?: string;
};

/**
 * Check Credit Balance Step
 * Reads the agent's off-chain KeeperHub credit balance via the
 * HMAC-authenticated /api/agentic-wallet/credit endpoint.
 */
export async function checkCreditStep(
  input: CheckCreditInput
): Promise<CheckCreditResult> {
  "use step";

  const credentials = input.integrationId
    ? await fetchCredentials(input.integrationId, {
        organizationId: input._context?.organizationId ?? null,
      })
    : {};

  return runPluginStep(
    { pluginName: "agent-gateway", actionName: "check-credit" },
    input,
    () => checkCreditCore(credentials)
  );
}

export const _integrationType = "agent-gateway";
