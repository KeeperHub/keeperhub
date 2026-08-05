/**
 * HTTP Request worker logic.
 *
 * Kept in its own module rather than directly in `step.ts` because the
 * Workflow DevKit bundler treats step files specially: only `"use step"`
 * exports are stubbed into the workflow-function bundle. Anything *else*
 * exported from a step file gets pulled into the workflow bundle along with
 * its transitive imports, which fails on the Node-only modules `safeFetch`
 * pulls in (undici, node:net, node:async_hooks). Living here, the worker is
 * reachable only via the `"use step"` wrapper, so its safeFetch dependency
 * stays in the step bundle where it belongs.
 */
import "server-only";

import { ErrorCategory, logUserError } from "@/lib/logging";
import {
  assertUrlIsPublic,
  SsrfBlockedError,
  safeFetch,
} from "@/lib/safe-fetch";
import { getErrorMessage, resolveFailOnError } from "@/lib/utils";
import { extractTemplateTokens } from "@/lib/utils/template";
import type { StepInput } from "@/lib/workflow/executor/step-handler";
import { DEFAULT_HTTP_METHOD } from "./constants";

export type HttpRequestResult =
  // KEEP-444: the success variant carries an optional `error` so a soft-failed
  // request (failOnError=false) can hand `{ data: null, status, error }` to the
  // next node without failing the step. `status` is null when no HTTP response
  // was received at all (timeout, DNS, connection error).
  | { success: true; data: unknown; status: number | null; error?: string }
  | { success: false; error: string; status?: number };

export type HttpRequestInput = StepInput & {
  endpoint: string;
  // Optional: the visual editor only persists this when the user changes the
  // dropdown, so it can arrive undefined. resolveHttpMethod defaults it to POST.
  httpMethod?: string;
  httpHeaders?: string;
  httpBody?: string;
  // KEEP-444: per-node request timeout in seconds (default 5, clamped 1-30).
  timeout?: number;
  // KEEP-444: when false, non-2xx responses and timeouts return a soft result
  // to the next node instead of failing the step. Defaults to true.
  failOnError?: boolean;
};

const DEFAULT_TIMEOUT_SECONDS = 5;
const MIN_TIMEOUT_SECONDS = 1;
const MAX_TIMEOUT_SECONDS = 30;

/**
 * Resolve the request timeout in milliseconds. Accepts the raw config value
 * (numbers from MCP callers, strings from the visual editor), coerces it, and
 * clamps to [1, 30] seconds. Falls back to the 5s default for missing or
 * non-numeric input. Exported for tests.
 */
export function resolveTimeoutMs(timeout: unknown): number {
  // Treat missing / empty / null as "use default" -- otherwise Number(null) and
  // Number("") both coerce to 0 and clamp up to the 1s minimum, which is the
  // most punishing possible timeout for a config the user did not actually set.
  if (timeout === undefined || timeout === null || timeout === "") {
    return DEFAULT_TIMEOUT_SECONDS * 1000;
  }
  const requested = typeof timeout === "number" ? timeout : Number(timeout);
  const seconds = Number.isFinite(requested)
    ? Math.min(Math.max(MIN_TIMEOUT_SECONDS, requested), MAX_TIMEOUT_SECONDS)
    : DEFAULT_TIMEOUT_SECONDS;
  return seconds * 1000;
}

// Re-exported for tests and existing call sites; canonical implementation
// lives in lib/utils.ts so Write Contract's failOnError toggle shares it.
export { resolveFailOnError } from "@/lib/utils";

/**
 * Resolve the HTTP method. The visual editor only writes `httpMethod` to the
 * node config when the user actively changes the dropdown -- leaving it on its
 * displayed default means the field is never persisted, so `input.httpMethod`
 * arrives undefined and fetch silently falls back to GET (which then rejects a
 * configured body). Default the missing/empty case to POST and uppercase so the
 * GET-body guard in parseBody matches regardless of casing. Exported for tests.
 */
export function resolveHttpMethod(httpMethod: unknown): string {
  if (typeof httpMethod !== "string" || httpMethod.trim() === "") {
    return DEFAULT_HTTP_METHOD;
  }
  return httpMethod.trim().toUpperCase();
}

// URLs never legitimately contain `{{`, so any token left in the endpoint
// after template processing is a user-config bug we surface clearly instead
// of forwarding to fetch as a malformed URL.
function findUnresolvedTemplateVariables(value: string): string[] {
  return [...new Set(extractTemplateTokens(value))];
}

/**
 * Validate the rendered endpoint string before any network IO. Trims
 * surrounding whitespace and rejects unresolved `{{var}}` template tokens
 * (which usually mean a missing trigger payload field). Exported for tests.
 */
export type EndpointValidation =
  | { ok: true; endpoint: string }
  | { ok: false; error: string };

export function validateHttpRequestEndpoint(
  rawEndpoint: string | undefined | null
): EndpointValidation {
  const endpoint = rawEndpoint?.trim();
  if (!endpoint) {
    return { ok: false, error: "HTTP request failed: URL is required" };
  }
  const unresolved = findUnresolvedTemplateVariables(endpoint);
  if (unresolved.length > 0) {
    return {
      ok: false,
      error: `HTTP request failed: Missing template variable(s) in URL: ${unresolved.join(", ")}`,
    };
  }
  return { ok: true, endpoint };
}

function parseHeaders(httpHeaders?: string): Record<string, string> {
  if (!httpHeaders) {
    return {};
  }
  try {
    return JSON.parse(httpHeaders);
  } catch {
    return {};
  }
}

function parseBody(httpMethod: string, httpBody?: string): string | undefined {
  if (httpMethod === "GET" || !httpBody) {
    return;
  }
  try {
    const parsedBody = JSON.parse(httpBody);
    return Object.keys(parsedBody).length > 0
      ? JSON.stringify(parsedBody)
      : undefined;
  } catch {
    const trimmed = httpBody.trim();
    return trimmed && trimmed !== "{}" ? httpBody : undefined;
  }
}

function parseResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type");
  if (contentType?.includes("application/json")) {
    return response.json();
  }
  return response.text();
}

/**
 * HTTP request logic. Exported for tests.
 */
export async function httpRequest(
  input: HttpRequestInput
): Promise<HttpRequestResult> {
  const validation = validateHttpRequestEndpoint(input.endpoint);
  if (!validation.ok) {
    return { success: false, error: validation.error };
  }
  const { endpoint } = validation;
  const failOnError = resolveFailOnError(input.failOnError);
  const httpMethod = resolveHttpMethod(input.httpMethod);

  try {
    // SSRF guard: reject private/loopback/link-local/metadata destinations
    // before any outbound request. `assertUrlIsPublic` is always-on -- it
    // ignores `SAFE_FETCH_SHADOW`/shadow mode -- so a user-supplied endpoint
    // pointing at an internal address (e.g.
    // http://169.254.169.254/latest/meta-data/) is blocked here even in
    // environments where `safeFetch` itself would only log-and-continue.
    // Mirrors plugins/webhook/steps/send-webhook.ts.
    await assertUrlIsPublic(endpoint);

    const response = await safeFetch(endpoint, {
      method: httpMethod,
      headers: parseHeaders(input.httpHeaders),
      body: parseBody(httpMethod, input.httpBody),
      signal: AbortSignal.timeout(resolveTimeoutMs(input.timeout)),
      plugin: "http-request",
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      const error = `HTTP request failed with status ${response.status}: ${errorText}`;
      if (failOnError) {
        return { success: false, error, status: response.status };
      }
      // Soft-fail: hand the error to the next node instead of failing the
      // step, so aggregator workflows can treat one bad source as a miss.
      return { success: true, data: null, status: response.status, error };
    }

    const data = await parseResponse(response);
    return { success: true, data, status: response.status };
  } catch (error) {
    // An SSRF block is a security/config error, not a transient source miss:
    // hard-fail it regardless of failOnError so an aggregator workflow never
    // silently swallows a request aimed at an internal/metadata address. This
    // fires for both the always-on assertUrlIsPublic pre-check and a safeFetch
    // block in enforce mode.
    if (error instanceof SsrfBlockedError) {
      logUserError(
        ErrorCategory.VALIDATION,
        "[HTTP Request] Blocked SSRF target",
        error.message,
        { node_type: "http-request" }
      );
      return {
        success: false,
        error: `HTTP request failed: URL is not allowed: ${error.message}`,
      };
    }
    // A malformed endpoint makes assertUrlIsPublic's URL parse throw a
    // TypeError. That is a configuration error, not a transient source miss,
    // so hard-fail it regardless of failOnError rather than soft-failing into
    // a null-data success an aggregator workflow would silently swallow.
    if (error instanceof TypeError) {
      return {
        success: false,
        error: `HTTP request failed: ${getErrorMessage(error)}`,
      };
    }
    // A timeout abort surfaces here too -- AbortSignal.timeout() rejects the
    // fetch, which getErrorMessage renders as a timeout error.
    const message = `HTTP request failed: ${getErrorMessage(error)}`;
    if (failOnError) {
      return { success: false, error: message };
    }
    return { success: true, data: null, status: null, error: message };
  }
}
