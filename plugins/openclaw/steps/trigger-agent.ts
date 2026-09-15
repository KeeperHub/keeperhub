import "server-only";

import { fetchCredentials } from "@/lib/credential-fetcher";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { ErrorCategory, logUserError } from "@/lib/logging";
import {
  assertUrlIsPublic,
  SsrfBlockedError,
  safeFetch,
} from "@/lib/safe-fetch";
import { getErrorMessage } from "@/lib/utils";
import {
  type StepInput,
  runPluginStep,
} from "@/lib/workflow/executor/step-handler";
import type { OpenClawCredentials } from "../credentials";

/**
 * Hand a workflow's structured result to an OpenClaw agent turn.
 *
 * What this action promises, and what it deliberately does not:
 *
 *   - It reports ADMISSION. `runId` proves OpenClaw accepted the turn, not
 *     that a model ran, answered, or delivered anything. The success payload
 *     says `admitted: true` for that reason and never says "completed" or
 *     "delivered".
 *   - It is NOT exactly-once. Two independent holes make that unachievable
 *     from this side, and neither is hidden behind the retry setting:
 *       1. `maxRetries = 0` is the house convention but not a guarantee. The
 *          DevKit's `step_completed` event is occasionally lost under heavy
 *          fan-in and the executor re-fires the step on resume even at
 *          `maxRetries = 0` (KEEP-398/431, see
 *          tests/unit/executor-spurious-max-retries.test.ts).
 *       2. OpenClaw's own replay state is in-memory, expires five minutes
 *          after terminal completion, is bounded at 1,000 entries, and is
 *          cleared on restart.
 *     The idempotency key below narrows the window; it does not close it.
 */

/** Fixed ingress path. The configured URL is a host, not a path. */
const AGENT_HOOK_PATH = "/hooks/agent";
const TRAILING_SLASHES = /\/+$/;

/**
 * Bound the upstream error text. OpenClaw returns JSON for admission
 * failures but plain text for early method/auth/path failures, and a proxy in
 * front of a self-hosted instance can return an HTML page; none of that
 * belongs in a run log at full length.
 */
const MAX_ERROR_CHARS = 400;

/** Placeholder written in place of anything that could carry the hook token. */
const REDACTED = "[redacted]";

/**
 * Bound the request itself, not only the response text.
 *
 * OpenClaw answers 503 when it cannot admit a turn within its own 15-second
 * window, so a shorter client timeout would abort before the instance's answer
 * arrives and report a bare abort instead of that status.
 */
const FETCH_TIMEOUT_MS = 20_000;

type TriggerAgentResult =
  | { success: true; admitted: true; runId: string }
  | { success: false; error: string; errorClass?: ExecutionErrorType };

export type TriggerAgentCoreInput = {
  /** Required agent input text. Templated in the builder. */
  message: string;
  /** Must name a configured OpenClaw agent when supplied. */
  agentId?: string;
  /** Hook label used in OpenClaw's logs and completion events. */
  name?: string;
  /** Positive turn-timeout override, in seconds. */
  timeoutSeconds?: number | string;
  /**
   * Replay key. Derived from execution and node identity, never a config
   * field: a workflow retry reuses the execution id, and a user-authored key
   * would reintroduce the duplicate-turn problem this exists to narrow.
   */
  idempotencyKey?: string;
};

export type TriggerAgentInput = StepInput &
  TriggerAgentCoreInput & {
    integrationId?: string;
  };

function bound(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_ERROR_CHARS) {
    return trimmed;
  }
  return `${trimmed.slice(0, MAX_ERROR_CHARS)}...`;
}

/**
 * Remove anything from `text` that could carry the hook token into a run log.
 *
 * Two passes: the configured token by value, then a generic `Bearer <value>`
 * pair by shape, which catches a token that reached the log without being the
 * configured one.
 */
function redactSecrets(text: string, hookToken: string): string {
  let out = text;
  if (hookToken) {
    out = out.split(hookToken).join(REDACTED);
  }
  return out.replace(/Bearer\s+\S+/gi, `Bearer ${REDACTED}`);
}

/**
 * Read whatever the instance returned, without assuming it is JSON.
 *
 * The result is redacted before it is bounded: an instance, or a reverse proxy
 * in front of one, can echo request headers back inside an error body, and
 * this text ends up in the run log.
 */
async function readFailureText(
  response: Response,
  hookToken: string
): Promise<string> {
  try {
    const raw = await response.text();
    if (!raw) {
      return "";
    }
    let text = raw;
    try {
      const parsed = JSON.parse(raw) as { error?: unknown };
      const error = parsed?.error;
      if (typeof error === "string" && error.trim()) {
        text = error;
      }
    } catch {
      // Not JSON - fall through to the raw text.
    }
    return bound(redactSecrets(text, hookToken));
  } catch {
    return "";
  }
}

/**
 * Map an OpenClaw status onto a fault domain and a sentence a workflow author
 * can act on.
 *
 * 503 is the interesting one. OpenClaw returns it when single-run admission
 * did not happen within 15 seconds and the queued work is canceled, or when
 * the Gateway is suspended (`503 gateway_unavailable`). It is the status that
 * most invites a retry, and a retry there is a duplicate admitted turn
 * whenever the 15-second window was the only thing that expired. It is
 * reported as an external failure so the run surfaces it, and this action
 * never retries it on its own.
 */
function describeFailure(
  status: number,
  detail: string
): { error: string; errorClass: ExecutionErrorType } {
  const suffix = detail ? ` OpenClaw said: ${detail}` : "";

  switch (status) {
    case 400:
      return {
        error: `OpenClaw rejected the request as invalid (400). Check the message, agent id and timeout, and any destination policy on the instance.${suffix}`,
        errorClass: ExecutionErrorType.USER,
      };
    case 401:
      return {
        error: `OpenClaw rejected the hook token (401). Check OPENCLAW_HOOK_TOKEN - it must be the dedicated hook token, not the Gateway shared secret.${suffix}`,
        errorClass: ExecutionErrorType.USER,
      };
    case 404:
      return {
        error: `No agent hook is served at ${AGENT_HOOK_PATH} on this instance (404). Check OPENCLAW_BASE_URL and that hooks are enabled.${suffix}`,
        errorClass: ExecutionErrorType.USER,
      };
    case 405:
      return {
        error: `OpenClaw refused the method (405); this action only sends POST.${suffix}`,
        errorClass: ExecutionErrorType.USER,
      };
    case 409:
      return {
        error: `OpenClaw declined admission because the target session changed or cannot accept work (409). Retrying the same request is unlikely to help.${suffix}`,
        errorClass: ExecutionErrorType.USER,
      };
    case 413:
      return {
        error: `The payload exceeded this hook's byte limit (413). Shorten the message.${suffix}`,
        errorClass: ExecutionErrorType.USER,
      };
    case 429:
      return {
        error: `OpenClaw rejected the request with 429 (too many requests). The turn was not admitted; back off before sending the same turn again.${suffix}`,
        errorClass: ExecutionErrorType.EXTERNAL,
      };
    case 503:
      return {
        error: `OpenClaw did not admit the turn within its 15-second window, or the Gateway is unavailable (503). The queued work was canceled. This action does not retry it: a retry can admit the same turn twice.${suffix}`,
        errorClass: ExecutionErrorType.EXTERNAL,
      };
    default:
      return {
        error: `OpenClaw returned HTTP ${status}.${suffix}`,
        errorClass:
          status >= 500 ? ExecutionErrorType.EXTERNAL : ExecutionErrorType.USER,
      };
  }
}

async function stepHandler(
  input: TriggerAgentCoreInput,
  credentials: OpenClawCredentials
): Promise<TriggerAgentResult> {
  const baseUrl = credentials.OPENCLAW_BASE_URL?.trim();
  const hookToken = credentials.OPENCLAW_HOOK_TOKEN?.trim();

  if (!baseUrl) {
    return {
      success: false,
      error:
        "OPENCLAW_BASE_URL is not configured. Add the public base URL of your OpenClaw instance in the integration settings.",
      errorClass: ExecutionErrorType.USER,
    };
  }
  if (!hookToken) {
    return {
      success: false,
      error:
        "OPENCLAW_HOOK_TOKEN is not configured. Add the dedicated hook token in the integration settings.",
      errorClass: ExecutionErrorType.USER,
    };
  }

  const message = input.message?.trim();
  if (!message) {
    return {
      success: false,
      error: "A message is required: it is the agent's input text.",
      errorClass: ExecutionErrorType.USER,
    };
  }

  const url = `${baseUrl.replace(TRAILING_SLASHES, "")}${AGENT_HOOK_PATH}`;

  try {
    // The base URL is user-configurable, so validate it before any outbound
    // request. `assertUrlIsPublic` is always-on -- it ignores
    // `SAFE_FETCH_SHADOW` -- whereas `safeFetch` on its own degrades to
    // log-and-continue in shadow mode, and the CI check only forces
    // `safeFetch`. Declaring the field `type: "url"` also gets the
    // Test Connection path its own check (lib/db/test-connection.ts), which
    // covers the dialog, not this call site.
    //
    // Classified here rather than by the catch below, for the reason the two
    // sibling plugins classify it: a blocked internal target and a URL that
    // does not parse are both the author's configuration mistake, and
    // recording them as `external` attributes it to a third-party outage.
    // See plugins/webhook/steps/send-webhook.ts and
    // plugins/blockscout/steps/blockscout-core.ts.
    try {
      await assertUrlIsPublic(url);
    } catch (error) {
      const blocked = error instanceof SsrfBlockedError;
      logUserError(
        ErrorCategory.VALIDATION,
        blocked
          ? "[OpenClaw] Blocked SSRF target"
          : "[OpenClaw] Could not validate instance URL",
        error,
        { plugin_name: "openclaw", action_name: "trigger-agent" }
      );
      return {
        success: false,
        error: blocked
          ? `OpenClaw instance URL is not allowed: ${error.message}`
          : `OpenClaw instance URL could not be validated: ${bound(getErrorMessage(error))}`,
        errorClass: ExecutionErrorType.USER,
      };
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${hookToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (input.idempotencyKey) {
      // Header only. OpenClaw resolves Idempotency-Key, then
      // X-OpenClaw-Idempotency-Key, then the payload field, and nothing in
      // this repo puts an idempotency key in a body.
      headers["Idempotency-Key"] = input.idempotencyKey;
    }

    const timeoutSeconds = Number(input.timeoutSeconds);
    const body: Record<string, unknown> = {
      message,
      // `deliver` defaults to true on OpenClaw's side, so pinning it false is
      // a real behaviour change: successful completion is logged on the
      // instance instead of being announced to a channel. v1 exposes no
      // channel or recipient, so it cannot construct a partial destination.
      deliver: false,
      // Already OpenClaw's default. Pinned to defend against that default
      // changing, not because the request needs it.
      sessionMode: "isolated",
      ...(input.agentId?.trim() && { agentId: input.agentId.trim() }),
      ...(input.name?.trim() && { name: input.name.trim() }),
      ...(Number.isFinite(timeoutSeconds) &&
        timeoutSeconds > 0 && { timeoutSeconds: Math.floor(timeoutSeconds) }),
    };

    const response = await safeFetch(url, {
      plugin: "openclaw",
      method: "POST",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const detail = await readFailureText(response, hookToken);
      const failure = describeFailure(response.status, detail);
      return { success: false, ...failure };
    }

    const raw = await response.text();
    let payload: { ok?: unknown; runId?: unknown };
    try {
      payload = JSON.parse(raw) as { ok?: unknown; runId?: unknown };
    } catch {
      return {
        success: false,
        error:
          "OpenClaw returned a 200 that was not JSON, so admission could not be confirmed.",
        errorClass: ExecutionErrorType.EXTERNAL,
      };
    }

    const runId = typeof payload.runId === "string" ? payload.runId.trim() : "";
    if (payload.ok !== true || !runId) {
      return {
        success: false,
        error:
          "OpenClaw returned 200 without an admission receipt (ok: true and a non-empty runId), so the turn cannot be confirmed as admitted.",
        errorClass: ExecutionErrorType.EXTERNAL,
      };
    }

    return { success: true, admitted: true, runId };
  } catch (error) {
    return {
      success: false,
      error: `Failed to reach OpenClaw: ${bound(getErrorMessage(error))}`,
      errorClass: ExecutionErrorType.EXTERNAL,
    };
  }
}

/**
 * Replay key for one node's request.
 *
 * `executionId` alone is not enough. OpenClaw replays on this key, so two
 * Trigger Agent nodes in the same run would send the same key and the second
 * node would receive the first node's admission receipt instead of admitting
 * its own turn. The node id is what makes the key identify this request, and a
 * loop iteration appends its own identity for the same reason: each iteration
 * is meant to admit a separate turn.
 */
function buildIdempotencyKey(
  context: TriggerAgentInput["_context"]
): string | undefined {
  if (!context?.executionId) {
    return undefined;
  }
  const parts: Array<string | undefined> = [
    context.executionId,
    context.nodeId,
  ];
  if (context.forEachNodeId) {
    parts.push(context.forEachNodeId);
  }
  if (typeof context.iterationIndex === "number") {
    parts.push(String(context.iterationIndex));
  }
  // A context without a node id degrades to the execution id alone, which is
  // what this action sent before node identity was part of the key.
  return parts.filter((part) => part).join(":");
}

export async function triggerAgentStep(
  input: TriggerAgentInput
): Promise<TriggerAgentResult> {
  "use step";

  const credentials = input.integrationId
    ? await fetchCredentials(input.integrationId, {
        organizationId: input._context?.organizationId ?? null,
      })
    : ({} as OpenClawCredentials);

  const coreInput: TriggerAgentCoreInput = {
    ...input,
    idempotencyKey: buildIdempotencyKey(input._context),
  };

  return runPluginStep(
    { pluginName: "openclaw", actionName: "trigger-agent" },
    input,
    () => stepHandler(coreInput, credentials)
  );
}
// Convention (plugins/AGENTS.md), and it keeps the executor from retrying a
// side-effecting POST on its own. It is not a duplicate-suppression guarantee:
// see the note at the top of this file.
triggerAgentStep.maxRetries = 0;

export const _integrationType = "openclaw";
