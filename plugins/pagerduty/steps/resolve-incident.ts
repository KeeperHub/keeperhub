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

export type ResolveIncidentInput = StepInput &
  UpdateIncidentCoreInput & {
    integrationId: string;
  };

export async function resolveIncidentStep(
  input: ResolveIncidentInput
): Promise<UpdateIncidentResult> {
  "use step";

  const credentials = await fetchCredentials(input.integrationId, {
    organizationId: input._context?.organizationId ?? null,
  });

  return runPluginStep(
    { pluginName: "pagerduty", actionName: "resolve-incident" },
    input,
    () =>
      runUpdateIncident({
        input,
        credentials: credentials as PagerDutyCredentials,
        workflowId: input._context?.workflowId,
        action: "resolve",
      })
  );
}
resolveIncidentStep.maxRetries = 0;

export const _integrationType = "pagerduty";
