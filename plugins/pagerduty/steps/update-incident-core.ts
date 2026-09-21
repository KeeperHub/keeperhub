/**
 * Shared body of the acknowledge and resolve actions.
 *
 * IMPORTANT: this file must NOT contain "use step".
 *
 * Both actions are the same call with a different event_action, and both are
 * only meaningful against an alert this workflow opened: PagerDuty applies an
 * acknowledge or a resolve to the open alert with the same dedup key, sent
 * through the same service's routing key, and drops it when there is none.
 * That makes a resolve on the healthy branch of a check safe to run every
 * time - it closes what the workflow opened, or does nothing.
 */
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { ErrorCategory, logUserError } from "@/lib/logging";
import { sleep } from "@/lib/sleep";
import { resolveFailOnError } from "@/lib/utils";
import {
  resolveRetryAttempts,
  resolveRetryDelayMs,
} from "@/lib/workflow/retry-policy";
import type { PagerDutyCredentials } from "../credentials";
import {
  buildUpdateEvent,
  deriveDedupKey,
  trimToLimit,
  failureIsExternal,
  findIncidentByKey,
  type IncidentLookup,
  postEventWithRetries,
  resolveRoutingKeyWithRetries,
} from "./pagerduty-core";

const RETRY_ATTEMPT_LIMITS = { defaultAttempts: 2, maxAttempts: 5 };
const RETRY_DELAY_LIMITS = { defaultDelaySeconds: 1, maxDelaySeconds: 15 };

/**
 * How long a resolve may be held back before it is sent.
 *
 * Capped low on purpose. This exists to lose a race by a second or two, not to
 * schedule anything: the step is occupying a worker while it waits, and a
 * resolve that needs longer than this is not racing a trigger, it is waiting
 * on something that should be a separate node.
 */
export const MAX_SEND_DELAY_SECONDS = 5;

/**
 * Seconds to wait before sending, from a field that may arrive as a string
 * from the editor or a number from an MCP caller.
 *
 * Anything unparseable means no delay rather than an error. Nothing about a
 * stale or malformed config should be able to hold a resolve indefinitely -
 * the failure mode of this whole node is an incident that stays open.
 */
export function resolveSendDelayMs(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") {
    return 0;
  }
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.min(value, MAX_SEND_DELAY_SECONDS) * 1000;
}

export type UpdateIncidentCoreInput = {
  pagerdutyServiceId: string;
  dedupKey?: string;
  /** Id of the Trigger Incident node whose alert this closes. */
  dedupKeyFromNodeId?: string;
  /** Read the incident back afterwards to report what state it is actually in. */
  verifyWithPagerDuty?: boolean | string;
  /** Seconds to hold the event back, to lose a race against its own trigger. */
  sendDelaySeconds?: number | string;
  retryAttempts?: number | string;
  retryDelay?: number | string;
  failOnError?: boolean | string;
};

export type UpdateIncidentResult =
  | {
      success: true;
      /** PagerDuty accepted the event. It does not promise an alert changed state. */
      delivered: boolean;
      dedupKey: string;
      action: "acknowledge" | "resolve";
      /**
       * Only present when the check is on: the incident's status when it was
       * read back, after the event was sent. The Events API is asynchronous,
       * so this can still show the previous state for a second or two, and
       * "unknown" means PagerDuty had nothing to show - which is not proof of
       * absence, since a service that groups alerts produces incidents with no
       * incident key.
       */
      incidentStatus?: IncidentLookup["status"];
      incidentUrl?: string;
      /** The incident's priority, when it has one. */
      incidentPriority?: string;
      /** Why verification could not answer, when it could not. Never fails the step. */
      verificationError?: string;
      /** Seconds this node waited before sending, when it was asked to wait. */
      delayedSeconds?: number;
      error?: string;
      message?: string;
    }
  | { success: false; error: string; errorClass?: ExecutionErrorType };

/**
 * PagerDuty identifies the alert to acknowledge or resolve by dedup key, and
 * the Events API requires one for both actions - it is only optional on a
 * trigger, where PagerDuty will generate it.
 *
 * It is deliberately not defaulted the way the trigger's is. The trigger
 * derives a key from its own node id; deriving one here would derive it from
 * THIS node's id, which is a different node, so the event would carry a key no
 * alert has ever used. PagerDuty answers 202 to that and drops it, which is
 * the quietest possible way to never close an incident. Referencing the
 * trigger node's `dedupKey` output is the shape that works.
 */
function missingDedupKeyError(action: "acknowledge" | "resolve"): string {
  return `This ${action} has no dedup key. PagerDuty needs the key of the alert to ${action}: pick the Trigger Incident node whose alert this closes, and the same key it uses is derived here, or set a dedup key explicitly on both nodes.`;
}

/**
 * The key of the alert to update.
 *
 * An explicit key wins. Otherwise it is derived from the trigger node the user
 * picked, using the same rule the trigger itself uses when its key is blank -
 * deriving from THIS node's id would produce a key no alert has ever carried,
 * and PagerDuty answers 202 to that and drops it.
 *
 * A template reference to the trigger node's output cannot be used for this:
 * the healthy branch of a check is precisely the branch where the trigger node
 * did not run, so the reference would be unresolved and the run would fail.
 */
function resolveTargetDedupKey(
  input: UpdateIncidentCoreInput,
  workflowId: string | undefined
): string {
  const explicit = input.dedupKey?.trim();
  if (explicit) {
    // Through the same trim the trigger applies, so both sides of a pair
    // produce the same key for the same input. PagerDuty drops an update
    // whose key it does not know, and answers 202 either way.
    return trimToLimit(explicit, "Dedup key", []);
  }
  const triggerNodeId = input.dedupKeyFromNodeId?.trim();
  if (triggerNodeId) {
    return deriveDedupKey(undefined, { workflowId, nodeId: triggerNodeId });
  }
  return "";
}

type Verification = {
  incidentStatus?: IncidentLookup["status"];
  incidentUrl?: string;
  incidentPriority?: string;
  verificationError?: string;
};

/**
 * Read the incident back, when the node asks for it.
 *
 * PagerDuty answers 202 to an acknowledge or a resolve whether or not it had
 * anything to apply it to: an alert already resolved, a dedup key that was
 * never used, or an event sent through a different service's routing key all
 * look identical from the response. This turns that into a reported state.
 *
 * Never fails the step. A missing incidents.read scope, a rate limit, or a
 * service that groups alerts (whose incidents carry no incident key) all come
 * back as "unknown" with a note - refusing to resolve an incident because the
 * read-back was inconclusive would be worse than the ambiguity it replaces.
 *
 * It reports the state AFTER the event, which is what can be observed; it
 * cannot say whether the incident was already in that state, because the read
 * happens after the write. Reading first would answer that and cost a second
 * call on every run, for an answer nothing acts on.
 */
async function verifyIfAsked(params: {
  input: UpdateIncidentCoreInput;
  credentials: PagerDutyCredentials;
  serviceId: string;
  dedupKey: string;
  action: "acknowledge" | "resolve";
}): Promise<Verification> {
  // Absent means on, not off. Both actions declare the field's default as
  // "true", but that default is seeded into the config by the editor when
  // somebody picks the action - a node created through the API or an MCP
  // caller never goes through that, so the field simply is not there. Reading
  // an absent value as "no" turned the check off for every one of those
  // nodes, silently and against what the action, its help text and the docs
  // all say. Only an explicit no means no.
  const asked =
    params.input.verifyWithPagerDuty !== false &&
    params.input.verifyWithPagerDuty !== "false";
  if (!asked) {
    return {};
  }

  const lookup = await findIncidentByKey(params.credentials, {
    serviceId: params.serviceId,
    incidentKey: params.dedupKey,
  });

  if (!lookup.ok) {
    return {
      incidentStatus: "unknown",
      verificationError: lookup.failure.message,
    };
  }

  return {
    incidentStatus: lookup.value.status,
    incidentUrl: lookup.value.htmlUrl,
    incidentPriority: lookup.value.priority,
  };
}

export async function runUpdateIncident(params: {
  input: UpdateIncidentCoreInput;
  credentials: PagerDutyCredentials;
  workflowId?: string;
  action: "acknowledge" | "resolve";
}): Promise<UpdateIncidentResult> {
  const { input, credentials, action } = params;
  const failOnError = resolveFailOnError(input.failOnError);
  const dedupKey = resolveTargetDedupKey(input, params.workflowId);
  const logLabels = {
    plugin_name: "pagerduty",
    action_name: `${action}-incident`,
    service: "pagerduty",
  };

  if (!dedupKey) {
    return {
      success: false,
      error: missingDedupKeyError(action),
      errorClass: ExecutionErrorType.USER,
    };
  }

  const serviceId = input.pagerdutyServiceId?.trim();
  if (!serviceId) {
    return {
      success: false,
      error: `No PagerDuty service selected. An ${action} has to go through the same service that triggered the alert.`,
      errorClass: ExecutionErrorType.USER,
    };
  }

  const maxRetries = resolveRetryAttempts(
    input.retryAttempts,
    RETRY_ATTEMPT_LIMITS
  );
  const baseDelayMs = resolveRetryDelayMs(input.retryDelay, RETRY_DELAY_LIMITS);
  const onRetry = (
    failure: { message: string },
    attempt: number,
    delayMs: number
  ): void => {
    logUserError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[PagerDuty] Attempt failed, retrying",
      failure.message,
      { ...logLabels, attempt: String(attempt), retry_in_ms: String(delayMs) }
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

  // Held back here rather than at the top of the step, so a run that cannot
  // resolve its routing key fails immediately instead of waiting first, and so
  // the wait sits as close to the send as it can - which is what the race
  // needs. See the field's help text for what the race is.
  const sendDelayMs = resolveSendDelayMs(input.sendDelaySeconds);
  if (routingKey.ok && sendDelayMs > 0) {
    await sleep(sendDelayMs);
  }

  const result = routingKey.ok
    ? await postEventWithRetries({
        credentials,
        body: buildUpdateEvent({
          routingKey: routingKey.value.routingKey,
          dedupKey,
          action,
        }),
        maxRetries,
        baseDelayMs,
        wait: sleep,
        onRetry,
      })
    : routingKey;

  if (result.ok) {
    const verification = await verifyIfAsked({
      input,
      credentials,
      serviceId,
      dedupKey,
      action,
    });
    return {
      success: true,
      delivered: true,
      dedupKey,
      action,
      message: result.value.message,
      delayedSeconds: sendDelayMs > 0 ? sendDelayMs / 1000 : undefined,
      ...verification,
    };
  }

  logUserError(
    ErrorCategory.EXTERNAL_SERVICE,
    `[PagerDuty] Could not ${action} incident`,
    result.failure.message,
    result.failure.status
      ? { ...logLabels, status: String(result.failure.status) }
      : logLabels
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

  return {
    success: true,
    delivered: false,
    dedupKey,
    action,
    error: result.failure.message,
  };
}
