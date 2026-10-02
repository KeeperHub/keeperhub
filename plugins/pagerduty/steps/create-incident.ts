import "server-only";

import { fetchCredentials } from "@/lib/credential-fetcher";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { ErrorCategory, logUserError } from "@/lib/logging";
import { resolveFailOnError } from "@/lib/utils";
import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import type { PagerDutyCredentials } from "../credentials";
import {
  createIncident,
  describeTrims,
  failureIsExternal,
  getEscalationPolicy,
  type PagerDutyFailure,
} from "./pagerduty-core";

/**
 * Sentinel for "leave it to PagerDuty". The picker now stores a blank instead,
 * but a node saved while it stored the literal must not start asking PagerDuty
 * for a priority called "none", which is a 400.
 */
const NO_PRIORITY = "none";

/** The configured priority, or nothing when the author left it to PagerDuty. */
function chosenPriorityId(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed && trimmed !== NO_PRIORITY ? trimmed : undefined;
}

const LOG_LABELS = {
  plugin_name: "pagerduty",
  action_name: "create-incident",
  service: "pagerduty",
};

export type CreateIncidentCoreInput = {
  pagerdutyServiceId: string;
  title: string;
  details?: string;
  urgency?: string;
  /** Account priority (P1, P2, ...). REST only - an event cannot carry one. */
  pagerdutyPriorityId?: string;
  incidentKey?: string;
  pagerdutyEscalationPolicyId?: string;
  /** Default true: a deleted policy pages the service's own rota instead of failing. */
  fallbackToServicePolicy?: boolean | string;
  fromEmail?: string;
  failOnError?: boolean | string;
};

export type CreateIncidentInput = StepInput &
  CreateIncidentCoreInput & {
    integrationId: string;
  };

type CreateIncidentStepResult =
  | {
      success: true;
      delivered: boolean;
      incidentId?: string;
      incidentNumber?: number;
      incidentUrl?: string;
      status?: string;
      priorityId?: string;
      /** Fields PagerDuty's ceilings forced shorter, named and measured. */
      fieldsTrimmed?: string;
      /** True when a configured escalation policy was gone and the service's own was used. */
      escalationPolicyFellBack?: boolean;
      error?: string;
    }
  | { success: false; error: string; errorClass?: ExecutionErrorType };

/**
 * Resolve the escalation policy override.
 *
 * A policy that no longer exists is the interesting case: by default the
 * incident is still created, on the service's own policy, because paging the
 * default rota beats paging nobody. Turning the fallback off makes it an
 * error instead.
 */
async function resolveEscalationPolicy(
  credentials: PagerDutyCredentials,
  policyId: string | undefined,
  fallback: boolean
): Promise<
  | { ok: true; policyId?: string; fellBack: boolean }
  // `failure` carries a read that did not complete - a rate limit, a 5xx -
  // which is a different thing from a policy that is genuinely gone and has
  // to be handled like any other failed call. `error` is the gone case.
  | { ok: false; error: string; failure?: PagerDutyFailure }
> {
  const wanted = policyId?.trim();
  if (!wanted) {
    return { ok: true, fellBack: false };
  }

  const policy = await getEscalationPolicy(credentials, wanted);
  if (!policy.ok) {
    // The read failed rather than answering "no such policy". Hand the failure
    // up so it goes through the same failOnError and fault-domain handling as
    // the create call; returning it as a bare error meant a 429 from PagerDuty
    // failed the run whatever the switch said, and was recorded as the
    // author's mistake.
    return {
      ok: false,
      error: policy.failure.message,
      failure: policy.failure,
    };
  }
  if (policy.value) {
    return { ok: true, policyId: wanted, fellBack: false };
  }
  if (fallback) {
    logUserError(
      ErrorCategory.CONFIGURATION,
      "[PagerDuty] Escalation policy no longer exists, using the service policy",
      wanted,
      LOG_LABELS
    );
    return { ok: true, fellBack: true };
  }
  return {
    ok: false,
    error: `Escalation policy ${wanted} no longer exists in this PagerDuty account. Pick another one on this node, or allow the fallback to the service's own policy.`,
  };
}

async function stepHandler(
  input: CreateIncidentInput,
  credentials: PagerDutyCredentials
): Promise<CreateIncidentStepResult> {
  const failOnError = resolveFailOnError(input.failOnError);
  const fromEmail = (
    input.fromEmail?.trim() ||
    credentials.PAGERDUTY_FROM_EMAIL?.trim() ||
    ""
  ).trim();

  const serviceId = input.pagerdutyServiceId?.trim();
  const title = input.title?.trim();

  if (!serviceId) {
    return {
      success: false,
      error: "No PagerDuty service selected.",
      errorClass: ExecutionErrorType.USER,
    };
  }
  if (!title) {
    return {
      success: false,
      error: "Title is empty, and PagerDuty requires one.",
      errorClass: ExecutionErrorType.USER,
    };
  }
  if (!fromEmail) {
    const hadTemplate = (input.fromEmail ?? "").trim().length > 0;
    return {
      success: false,
      error: hadTemplate
        ? "Creating an incident over the REST API needs the login email of a PagerDuty user. This node's From email is set, but it resolved to nothing on this run - check the step it reads from, or put a fixed address on the connection."
        : "Creating an incident over the REST API needs the login email of a PagerDuty user. Set From email on the connection, or on this node.",
      errorClass: ExecutionErrorType.USER,
    };
  }

  const policy = await resolveEscalationPolicy(
    credentials,
    input.pagerdutyEscalationPolicyId,
    resolveFailOnError(input.fallbackToServicePolicy)
  );
  if (!policy.ok) {
    if (policy.failure) {
      // A read that did not complete: same treatment as any other failed call.
      logUserError(
        ErrorCategory.EXTERNAL_SERVICE,
        "[PagerDuty] Could not read the escalation policy",
        policy.error,
        LOG_LABELS
      );
      if (!failOnError) {
        return { success: true, delivered: false, error: policy.error };
      }
      return {
        success: false,
        error: policy.error,
        errorClass: failureIsExternal(policy.failure)
          ? ExecutionErrorType.EXTERNAL
          : ExecutionErrorType.USER,
      };
    }
    // The policy is gone and the fallback is off: the author's to fix, and a
    // hard failure by their own choice.
    return {
      success: false,
      error: policy.error,
      errorClass: ExecutionErrorType.USER,
    };
  }

  // "service-default" is the sentinel for "send no urgency at all": Radix
  // rejects an empty option value, and an unrecognised value must not silently
  // become the service default when the author picked High.
  const urgency =
    input.urgency === "low" || input.urgency === "high"
      ? input.urgency
      : undefined;

  const result = await createIncident(credentials, {
    serviceId,
    title,
    fromEmail,
    details: input.details,
    urgency,
    incidentKey: input.incidentKey,
    escalationPolicyId: policy.policyId,
    priorityId: chosenPriorityId(input.pagerdutyPriorityId),
  });

  if (result.ok) {
    return {
      success: true,
      delivered: true,
      incidentId: result.value.id,
      incidentNumber: result.value.number,
      incidentUrl: result.value.htmlUrl,
      status: result.value.status,
      priorityId: chosenPriorityId(input.pagerdutyPriorityId),
      fieldsTrimmed: describeTrims(result.value.trims ?? []),
      escalationPolicyFellBack: policy.fellBack,
    };
  }

  logUserError(
    ErrorCategory.EXTERNAL_SERVICE,
    "[PagerDuty] Could not create incident",
    result.failure.message,
    result.failure.status
      ? { ...LOG_LABELS, status: String(result.failure.status) }
      : LOG_LABELS
  );

  if (failOnError) {
    return {
      success: false,
      error: result.failure.message,
      errorClass: failureIsExternal(result.failure)
        ? ExecutionErrorType.EXTERNAL
        : ExecutionErrorType.USER,
    };
  }
  return { success: true, delivered: false, error: result.failure.message };
}

export async function createIncidentStep(
  input: CreateIncidentInput
): Promise<CreateIncidentStepResult> {
  "use step";

  const credentials = await fetchCredentials(input.integrationId, {
    organizationId: input._context?.organizationId ?? null,
  });

  return runPluginStep(
    { pluginName: "pagerduty", actionName: "create-incident" },
    input,
    () => stepHandler(input, credentials as PagerDutyCredentials)
  );
}
// An incident key that repeats is rejected rather than merged, so a retry
// after a lost response could create a second incident. The engine must not
// re-run this step.
createIncidentStep.maxRetries = 0;

export const _integrationType = "pagerduty";
