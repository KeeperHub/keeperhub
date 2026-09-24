import "server-only";

import { fetchCredentials } from "@/lib/credential-fetcher";
import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import type { PagerDutyCredentials } from "../credentials";
import {
  runUpdateIncident,
  type UpdateIncidentCoreInput,
  type UpdateIncidentResult,
} from "./update-incident-core";

export type AcknowledgeIncidentInput = StepInput &
  UpdateIncidentCoreInput & {
    integrationId: string;
  };

export async function acknowledgeIncidentStep(
  input: AcknowledgeIncidentInput
): Promise<UpdateIncidentResult> {
  "use step";

  const credentials = await fetchCredentials(input.integrationId, {
    organizationId: input._context?.organizationId ?? null,
  });

  return runPluginStep(
    { pluginName: "pagerduty", actionName: "acknowledge-incident" },
    input,
    () =>
      runUpdateIncident({
        input,
        credentials: credentials as PagerDutyCredentials,
        workflowId: input._context?.workflowId,
        action: "acknowledge",
      })
  );
}
acknowledgeIncidentStep.maxRetries = 0;

export const _integrationType = "pagerduty";
