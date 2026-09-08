/**
 * Attribution helpers for security/audit columns on workflow_executions.
 *
 * The values produced here are written to non-FK audit columns and consumed
 * by KEEP-612 detection alerts (throughput spike per key, org-API-key use
 * off-hours, ASN anomaly). They are never load-bearing for authorization.
 *
 * IP resolution policy: Cloudflare's `cf-connecting-ip` is the canonical
 * client IP because our prod ingress terminates at CF and CF strips any
 * client-supplied value. If the header is absent (local dev, internal
 * services that bypass the edge), we fall through to the trusted-proxy XFF
 * resolver from `./trusted-proxies` and return `null` when neither source
 * is trustworthy. Audit columns stay NULL rather than recording a misleading
 * sentinel.
 */

import { isTriggerType, type TriggerType } from "@/lib/metrics/types";
import { resolveTrustedClientIp } from "./trusted-proxies";

/**
 * `trigger_source` label written to `workflow_executions.trigger_source`.
 *
 * Relationship to `TriggerType` (lib/metrics/types.ts): this union is a
 * strict superset. TriggerType is the Prometheus-label vocabulary for the
 * `keeperhub_workflow_executions_started_total` metric and contains
 * (manual | webhook | scheduled | schedule | block | event). TriggerSource
 * adds `mcp` and `internal` to distinguish auth paths the metric label set
 * intentionally conflates -- a workflow with a manual trigger node can be
 * invoked via the MCP marketplace path OR a direct API call, and the
 * security attribution column wants to tell them apart even though both
 * report `manual` to Prometheus.
 *
 * If a new value is added here that doesn't also belong in TriggerType,
 * the `triggerType as TriggerSource` cast in
 * `app/api/workflow/[workflowId]/execute/route.ts` will be unsound. Keep
 * the cast direction (TriggerType -> TriggerSource) and add new values
 * to whichever union actually needs them; do not invert.
 */
export type TriggerSource =
  | "manual"
  | "webhook"
  | "scheduled"
  | "schedule"
  | "mcp"
  | "internal"
  | "block"
  | "event";

export type TriggerLabels = {
  /** Prometheus metric label (keeperhub_workflow_executions_started_total). */
  triggerType: TriggerType;
  /** Audit column value (workflow_executions.trigger_source). */
  triggerSource: TriggerSource;
};

/**
 * Resolve the (metric, audit) trigger labels for an execution created by the
 * manual/internal execute route, from the `x-trigger-type` header and whether
 * the caller authenticated as an internal service.
 *
 * - A recognised header wins for BOTH labels (block / event / schedule).
 * - Header-less internal callers: metric "schedule" (canonical, converges
 *   with the executor's emit -- NOT "scheduled", which fragmented the
 *   series), audit "internal" (more precise: records the auth path).
 * - Everything else is a human "manual" run.
 *
 * The trigger_source can legitimately differ from triggerType ("internal"
 * vs "schedule") because the audit column carries auth-path precision the
 * coarse metric label intentionally omits. Pure + exported so the value
 * mapping is unit-tested (a typo here silently re-fragments metrics).
 */
export function resolveTriggerLabels(
  headerTrigger: string | null,
  isInternal: boolean
): TriggerLabels {
  if (isTriggerType(headerTrigger)) {
    // Normalise the legacy "scheduled" alias to the canonical "schedule" so
    // an explicit `x-trigger-type: scheduled` header can't re-fragment the
    // metric/audit series -- TriggerType still accepts "scheduled" for back-
    // compat, but nothing downstream should ever see it.
    const normalized: TriggerType =
      headerTrigger === "scheduled" ? "schedule" : headerTrigger;
    return {
      triggerType: normalized,
      triggerSource: normalized as TriggerSource,
    };
  }
  if (isInternal) {
    return { triggerType: "schedule", triggerSource: "internal" };
  }
  return { triggerType: "manual", triggerSource: "manual" };
}

export function getRequestSourceIp(request: Request): string | null {
  const cf = request.headers.get("cf-connecting-ip")?.trim();
  if (cf) {
    return cf;
  }

  const peer = request.headers.get("x-real-ip")?.trim();
  if (!peer) {
    return null;
  }
  const resolved = resolveTrustedClientIp(request, peer);
  return resolved === "unknown" ? null : resolved;
}

/**
 * Cloudflare emits a two-letter ISO country code via `cf-ipcountry` on every
 * request it proxies. Cheaper than MaxMind enrichment and good enough as a
 * v0 dimension for "org-API-key use from a new country" behavioural alerts.
 * Returns null for direct-to-origin traffic or non-CF deployments.
 */
export function getRequestCountry(request: Request): string | null {
  const raw = request.headers.get("cf-ipcountry")?.trim();
  if (!raw) {
    return null;
  }
  // CF uses "XX" for unknown / Tor / anonymizing proxies. Treat as null so
  // alert grouping doesn't pollute the legitimate-country buckets.
  if (raw === "XX" || raw === "T1") {
    return null;
  }
  return raw;
}

/**
 * Credential class an execution was triggered with. Recorded durably (it
 * survives revoking/deleting the underlying key) so the audit trail can always
 * answer "what kind of credential ran this".
 */
export type ExecutionCredentialType =
  | "webhook_key"
  | "org_api_key"
  | "oauth"
  | "session"
  | "internal";

export type ExecutionAttribution = {
  triggeredByUserApiKeyId: string | null;
  triggeredByOrgApiKeyId: string | null;
  triggeredByIp: string | null;
  triggeredByCountry: string | null;
  triggerSource: TriggerSource;
  triggeredByCredentialType: ExecutionCredentialType | null;
  triggeredByCredentialLabel: string | null;
};

export function buildAttribution(input: {
  request?: Request;
  source: TriggerSource;
  userApiKeyId?: string | null;
  orgApiKeyId?: string | null;
  credentialType?: ExecutionCredentialType | null;
  credentialLabel?: string | null;
}): ExecutionAttribution {
  return {
    triggeredByUserApiKeyId: input.userApiKeyId ?? null,
    triggeredByOrgApiKeyId: input.orgApiKeyId ?? null,
    triggeredByIp: input.request ? getRequestSourceIp(input.request) : null,
    triggeredByCountry: input.request ? getRequestCountry(input.request) : null,
    triggerSource: input.source,
    triggeredByCredentialType: input.credentialType ?? null,
    triggeredByCredentialLabel: input.credentialLabel ?? null,
  };
}
