import "server-only";

import { fetchCredentials } from "@/lib/credential-fetcher";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { ErrorCategory, logSystemWarn, logUserError } from "@/lib/logging";
import { sleep } from "@/lib/sleep";
import { resolveFailOnError } from "@/lib/utils";
import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import {
  resolveRetryAttempts,
  resolveRetryDelayMs,
} from "@/lib/workflow/retry-policy";
import type { PagerDutyCredentials } from "../credentials";
import {
  type BackupOutcome,
  sendBackupNotification,
} from "@/lib/notifications/backup-channel";
import {
  countConsecutiveRuns,
  resolveConsecutiveRuns,
} from "./consecutive-core";
import {
  buildTriggerEvent,
  deriveDedupKey,
  describeTrims,
  failureIsExternal,
  type PagerDutyFailure,
  parseLinks,
  postEventWithRetries,
  resolveRoutingKeyWithRetries,
  serviceStatusIsRecognised,
  serviceSwallowsEvents,
  type Trim,
} from "./pagerduty-core";

const RETRY_ATTEMPT_LIMITS = { defaultAttempts: 2, maxAttempts: 5 };
const RETRY_DELAY_LIMITS = { defaultDelaySeconds: 1, maxDelaySeconds: 15 };
const DEFAULT_APP_URL = "https://app.keeperhub.com";
const CLIENT_NAME = "KeeperHub";
const TRAILING_SLASHES = /\/+$/;

const LOG_LABELS = {
  plugin_name: "pagerduty",
  action_name: "trigger-incident",
  service: "pagerduty",
};

export type TriggerIncidentCoreInput = {
  pagerdutyServiceId: string;
  summary: string;
  severity?: string;
  source?: string;
  dedupKey?: string;
  component?: string;
  group?: string;
  class?: string;
  customDetails?: string | Record<string, unknown>;
  /** One per line: "text | url", or a bare url. */
  links?: string;
  /** Runs in a row that must reach this node before it pages. 1 pages immediately. */
  consecutiveRuns?: number | string;
  retryAttempts?: number | string;
  retryDelay?: number | string;
  /** Default true. False returns delivered: false instead of failing the run. */
  failOnError?: boolean | string;
  /** Connection to notify when PagerDuty will not take the page. */
  backupIntegrationId?: string;
  /** Slack channel or Telegram chat id, when the backup connection needs one. */
  backupDestination?: string;
  /** "true" to treat a maintenance window as an undelivered page. */
  treatMaintenanceAsUndelivered?: boolean | string;
};

export type TriggerIncidentInput = StepInput &
  TriggerIncidentCoreInput & {
    integrationId: string;
  };

type TriggerIncidentResult =
  | {
      success: true;
      /** False when the event was held by the consecutive-runs guard, or soft-failed. */
      delivered: boolean;
      dedupKey: string;
      /**
       * "suppressed" is a delivered event on a service in a maintenance
       * window: PagerDuty took it and raised no incident, so calling it
       * "triggered" would name an incident state that never happened.
       */
      status: "triggered" | "suppressed" | "held" | "failed";
      consecutiveRuns: number;
      requiredRuns: number;
      detailsTruncated?: boolean;
      /** Lines of the links field that were not an https url, so were not sent. */
      linksDropped?: number;
      /**
       * Fields PagerDuty's ceilings forced shorter, named and measured. Present
       * only when something was actually shortened, so a Condition can branch on
       * it and a person reading the run can see what the responder did not.
       */
      fieldsTrimmed?: string;
      /** True when the summary template rendered empty and a fallback title was sent. */
      summaryFellBack?: boolean;
      /** PagerDuty's service status at send time. */
      serviceStatus?: string;
      /** True when the service was in maintenance, so no incident was raised. */
      suppressedByService?: boolean;
      /** Whether a backup notification was attempted, and whether it landed. */
      backupAttempted?: boolean;
      backupDelivered?: boolean;
      backupChannel?: BackupOutcome["channel"];
      backupError?: string;
      error?: string;
      message?: string;
    }
  | { success: false; error: string; errorClass?: ExecutionErrorType };

function appUrl(): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL?.replace(TRAILING_SLASHES, "") ??
    DEFAULT_APP_URL
  );
}

/**
 * Whatever the author put in the details field, plus the run's own identity.
 * A free-text value is kept under a `details` key rather than dropped, so a
 * non-JSON template still reaches the responder.
 */
function buildCustomDetails(
  raw: string | Record<string, unknown> | undefined,
  context: { workflowId?: string; executionId?: string; nodeName?: string }
): Record<string, unknown> {
  const base: Record<string, unknown> = {};

  if (typeof raw === "object" && raw !== null) {
    Object.assign(base, raw);
  } else if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        Object.assign(base, parsed as Record<string, unknown>);
      } else {
        base.details = parsed;
      }
    } catch {
      base.details = raw;
    }
  }

  base.keeperhub_workflow_id = context.workflowId ?? "unknown";
  base.keeperhub_execution_id = context.executionId ?? "unknown";
  base.keeperhub_node = context.nodeName ?? "PagerDuty";
  return base;
}

function toFailureResult(
  failure: PagerDutyFailure,
  failOnError: boolean,
  dedupKey: string,
  consecutive: number,
  required: number,
  backup: BackupOutcome
): TriggerIncidentResult {
  logUserError(
    ErrorCategory.EXTERNAL_SERVICE,
    "[PagerDuty] Could not trigger incident",
    failure.message,
    failure.status
      ? { ...LOG_LABELS, status: String(failure.status) }
      : LOG_LABELS
  );

  if (failOnError) {
    return {
      success: false,
      error: backup.attempted
        ? `${failure.message} Backup notification: ${backup.delivered ? "sent" : (backup.error ?? "failed")}.`
        : failure.message,
      errorClass: failureIsExternal(failure)
        ? ExecutionErrorType.EXTERNAL
        : ExecutionErrorType.USER,
    };
  }

  // Soft failure: the run continues so a Condition on `delivered` can route to
  // a backup channel. The error travels with the output rather than vanishing.
  return {
    success: true,
    delivered: false,
    dedupKey,
    status: "failed",
    consecutiveRuns: consecutive,
    requiredRuns: required,
    error: failure.message,
    backupAttempted: backup.attempted,
    backupDelivered: backup.delivered,
    backupChannel: backup.channel,
    backupError: backup.error,
  };
}

/**
 * The message the responder sees instead of a page.
 *
 * It is written here rather than in lib/notifications, because every line of
 * it is PagerDuty's: which service was aimed at, and what PagerDuty said when
 * it would not take the event. The delivery mechanism is shared; the wording
 * is not.
 */
function buildBackupMessage(params: {
  summary: string;
  severity: string;
  serviceId: string;
  reason: string;
  workflowUrl?: string;
}): string {
  const lines = [
    "PagerDuty page FAILED - this is the backup notification.",
    `Alert: ${params.summary}`,
    `Severity: ${params.severity}`,
    `PagerDuty service: ${params.serviceId}`,
    `Why PagerDuty did not take it: ${params.reason}`,
  ];
  if (params.workflowUrl) {
    lines.push(`Workflow: ${params.workflowUrl}`);
  }
  return lines.join("\n");
}

/**
 * Tell someone, through whatever channel the node names, that the page did not
 * go out. Runs before the failure is returned, whether or not the node is set
 * to fail the workflow: the run being marked failed is for the operator
 * reading history later, the backup is for the person who is supposed to be
 * woken up now.
 */
async function notifyBackup(params: {
  input: TriggerIncidentInput;
  failure: PagerDutyFailure;
  summary: string;
  serviceId: string;
  workflowUrl?: string;
}): Promise<BackupOutcome> {
  const { input, failure } = params;
  if (!input.backupIntegrationId) {
    return { attempted: false, delivered: false };
  }
  const outcome = await sendBackupNotification({
    integrationId: input.backupIntegrationId,
    destination: input.backupDestination,
    organizationId: input._context?.organizationId ?? null,
    plugin: "pagerduty",
    message: buildBackupMessage({
      summary: params.summary,
      severity: String(input.severity ?? "error"),
      serviceId: params.serviceId,
      reason: failure.message,
      workflowUrl: params.workflowUrl,
    }),
  });

  if (outcome.attempted && !outcome.delivered) {
    logUserError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[PagerDuty] Backup notification also failed",
      outcome.error,
      LOG_LABELS
    );
  }
  return outcome;
}

/**
 * What the node says happened, once the event is away.
 *
 * The middle case is the one worth the code: PagerDuty reported a service
 * status this plugin does not know. The event went out, which is right -
 * refusing to page over an unfamiliar status string would be far worse - but
 * whether an incident came of it cannot be inferred, and saying nothing would
 * report a page that may never have been raised.
 */
function unrecognisedStatusNote(
  serviceStatus: string | undefined,
  suppressed: boolean,
  pagerDutyMessage: string | undefined
): string | undefined {
  if (suppressed) {
    return `PagerDuty accepted the event, but the service is in ${serviceStatus} and will not raise an incident from it.`;
  }
  if (!serviceStatusIsRecognised(serviceStatus)) {
    return `PagerDuty accepted the event, but reported the service as "${serviceStatus}", which this node does not recognise - so it cannot tell whether an incident was raised. Check the service in PagerDuty, and report this: it means PagerDuty has a service state this integration predates.`;
  }
  return pagerDutyMessage;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one linear path - validate, gate, resolve, send - each branch returning its own result
async function stepHandler(
  input: TriggerIncidentInput,
  credentials: PagerDutyCredentials
): Promise<TriggerIncidentResult> {
  const failOnError = resolveFailOnError(input.failOnError);
  const context = input._context ?? { nodeId: "", nodeName: "", nodeType: "" };
  const trims: Trim[] = [];
  const dedupKey = deriveDedupKey(
    input.dedupKey,
    { workflowId: context.workflowId, nodeId: context.nodeId },
    trims
  );
  const requiredRuns = resolveConsecutiveRuns(input.consecutiveRuns);

  const serviceId = input.pagerdutyServiceId?.trim();
  if (!serviceId) {
    return {
      success: false,
      error:
        "No PagerDuty service selected. Pick the service this node should page.",
      errorClass: ExecutionErrorType.USER,
    };
  }

  // An empty summary is a broken template, not a reason to stay silent. The
  // alert goes out with a title that says what happened and carries the
  // template that produced nothing, because a page with a poor title beats no
  // page at all - the same fail-open reasoning the consecutive-runs guard uses.
  const configuredSummary = input.summary?.trim();
  const summaryFellBack = !configuredSummary;
  const summary =
    configuredSummary ||
    `${context.nodeName || "PagerDuty"}: alert fired, and its summary template rendered empty`;
  if (summaryFellBack) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[PagerDuty] Summary template rendered empty, paging with a fallback title",
      input.summary,
      LOG_LABELS
    );
  }

  const consecutiveRuns = await countConsecutiveRuns(
    {
      workflowId: context.workflowId,
      nodeId: context.nodeId,
      executionId: context.executionId,
    },
    requiredRuns
  );

  if (consecutiveRuns < requiredRuns) {
    return {
      success: true,
      delivered: false,
      dedupKey,
      status: "held",
      consecutiveRuns,
      requiredRuns,
      message: `Held: this is run ${consecutiveRuns} of the ${requiredRuns} consecutive runs configured before paging.`,
    };
  }

  const workflowUrl = context.workflowId
    ? `${appUrl()}/workflows/${context.workflowId}`
    : undefined;

  const maxRetries = resolveRetryAttempts(
    input.retryAttempts,
    RETRY_ATTEMPT_LIMITS
  );
  const baseDelayMs = resolveRetryDelayMs(input.retryDelay, RETRY_DELAY_LIMITS);
  const onRetry = (
    failure: PagerDutyFailure,
    attempt: number,
    delayMs: number
  ): void => {
    logUserError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[PagerDuty] Attempt failed, retrying",
      failure.message,
      { ...LOG_LABELS, attempt: String(attempt), retry_in_ms: String(delayMs) }
    );
  };

  const routingKey = await resolveRoutingKeyWithRetries({
    credentials,
    serviceId,
    maxRetries,
    baseDelayMs,
    wait: sleep,
    onRetry,
  });
  if (!routingKey.ok) {
    return toFailureResult(
      routingKey.failure,
      failOnError,
      dedupKey,
      consecutiveRuns,
      requiredRuns,
      await notifyBackup({
        input,
        failure: routingKey.failure,
        summary,
        serviceId,
        workflowUrl,
      })
    );
  }

  if (routingKey.value.serviceStatus === "disabled") {
    const disabled: PagerDutyFailure = {
      message: `PagerDuty service ${serviceId} is disabled. It accepts events and creates no incident, so this page would have gone nowhere. Re-enable the service in PagerDuty, or point this node at another one.`,
      retryable: false,
      fault: "user",
    };
    return toFailureResult(
      disabled,
      failOnError,
      dedupKey,
      consecutiveRuns,
      requiredRuns,
      await notifyBackup({
        input,
        failure: disabled,
        summary,
        serviceId,
        workflowUrl,
      })
    );
  }

  const parsedLinks = parseLinks(input.links);
  const {
    body,
    detailsDropped,
    trims: payloadTrims,
  } = buildTriggerEvent({
    routingKey: routingKey.value.routingKey,
    dedupKey,
    timestamp: new Date().toISOString(),
    input: {
      summary,
      severity: input.severity,
      source: input.source?.trim() || context.nodeName || CLIENT_NAME,
      component: input.component,
      group: input.group,
      class: input.class,
      customDetails: {
        ...buildCustomDetails(input.customDetails, {
          workflowId: context.workflowId,
          executionId: context.executionId,
          nodeName: context.nodeName,
        }),
        ...(summaryFellBack
          ? { keeperhub_summary_template: input.summary ?? "" }
          : {}),
      },
      links: parsedLinks.links,
      client: CLIENT_NAME,
      clientUrl: workflowUrl,
    },
  });

  trims.push(...payloadTrims);
  const fieldsTrimmed = describeTrims(trims);
  if (fieldsTrimmed) {
    // The author is the only person who can fix this, and they will not be
    // reading the incident - the responder will, and they have no way to know
    // a title was cut. So it is said here, and carried in the output.
    logUserError(
      ErrorCategory.VALIDATION,
      "[PagerDuty] Field over PagerDuty's limit, shortened before sending",
      fieldsTrimmed,
      LOG_LABELS
    );
  }

  const result = await postEventWithRetries({
    credentials,
    body,
    maxRetries,
    baseDelayMs,
    wait: sleep,
    onRetry,
  });

  if (!result.ok) {
    return toFailureResult(
      result.failure,
      failOnError,
      dedupKey,
      consecutiveRuns,
      requiredRuns,
      await notifyBackup({
        input,
        failure: result.failure,
        summary,
        serviceId,
        workflowUrl,
      })
    );
  }

  const suppressed = serviceSwallowsEvents(routingKey.value.serviceStatus);

  // A maintenance window is usually deliberate, so it is reported rather than
  // failed - but a window somebody forgot to end is indistinguishable from one
  // in progress, and it swallows every page. The node can be told to treat it
  // as undelivered, which fires the backup like any other lost page.
  const treatMaintenanceAsFailure =
    input.treatMaintenanceAsUndelivered === true ||
    input.treatMaintenanceAsUndelivered === "true";
  if (suppressed && treatMaintenanceAsFailure) {
    const swallowed: PagerDutyFailure = {
      message: `PagerDuty accepted the event, but service ${serviceId} is in ${routingKey.value.serviceStatus} and raises no incident from it, so nobody was paged.`,
      retryable: false,
      // PagerDuty took the event and answered 202. The maintenance window is
      // the customer's own, so without this the run is filed as PagerDuty
      // having been down - which is what the fault field exists to prevent.
      fault: "user",
    };
    return toFailureResult(
      swallowed,
      failOnError,
      dedupKey,
      consecutiveRuns,
      requiredRuns,
      await notifyBackup({
        input,
        failure: swallowed,
        summary,
        serviceId,
        workflowUrl,
      })
    );
  }

  return {
    success: true,
    delivered: true,
    dedupKey: result.value.dedupKey ?? dedupKey,
    status: suppressed ? "suppressed" : "triggered",
    consecutiveRuns,
    requiredRuns,
    detailsTruncated: detailsDropped,
    linksDropped: parsedLinks.dropped || undefined,
    fieldsTrimmed,
    summaryFellBack,
    serviceStatus: routingKey.value.serviceStatus,
    suppressedByService: suppressed,
    message: unrecognisedStatusNote(
      routingKey.value.serviceStatus,
      suppressed,
      result.value.message
    ),
  };
}

export async function triggerIncidentStep(
  input: TriggerIncidentInput
): Promise<TriggerIncidentResult> {
  "use step";

  // A throw here would leave the run with a raw system error and never reach
  // the backup channel, whose entire purpose is to tell someone when the
  // primary path is down - and a credential store that will not answer is
  // exactly that. An empty credential set takes the same route as a deleted
  // connection: a message naming the three things it can be, the backup fired,
  // and the run failed. The same reasoning as the consecutive-runs guard,
  // which fails open for the same reason.
  let credentials: Awaited<ReturnType<typeof fetchCredentials>> = {};
  try {
    credentials = await fetchCredentials(input.integrationId, {
      organizationId: input._context?.organizationId ?? null,
    });
  } catch (error) {
    logSystemWarn(
      ErrorCategory.DATABASE,
      "[PagerDuty] Could not read the connection, treating it as empty so the backup still fires",
      error,
      LOG_LABELS
    );
  }

  return runPluginStep(
    { pluginName: "pagerduty", actionName: "trigger-incident" },
    input,
    () => stepHandler(input, credentials as PagerDutyCredentials)
  );
}
// The step runs its own retry loop, which is the only place an event is
// re-sent; the engine must not stack a second one on top.
triggerIncidentStep.maxRetries = 0;

export const _integrationType = "pagerduty";
