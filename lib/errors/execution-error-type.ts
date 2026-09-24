/**
 * Fault domain a workflow execution failure is attributed to. Single source of
 * truth for both the values and the union type.
 *
 * Mirrors the `ErrorCategory` idiom (a `const` object plus a derived type) so
 * call sites reference `ExecutionErrorType.EXTERNAL` instead of the raw string.
 *
 * Kept dependency-free so it is safe to import from client components,
 * `"use step"` plugin files, and the executor/scheduler processes alike,
 * without pulling in the classifier's runtime dependencies.
 */
export const ExecutionErrorType = {
  /**
   * The workflow author's configuration or request: bad input, missing
   * credential, a 4xx from an endpoint they configured.
   */
  USER: "user",
  /**
   * KeeperHub's own platform: database, executor/engine, managed RPC
   * infrastructure, missing secret.
   */
  SYSTEM: "system",
  /**
   * A third-party dependency the workflow calls that is outside both the
   * author's config and KeeperHub's platform: an upstream endpoint timing out,
   * a webhook host down, a 5xx from a provider.
   */
  EXTERNAL: "external",
  /**
   * The organization's own guardrail refused the action.
   *
   * Its own domain rather than USER because it is not a mistake: the run did
   * exactly what the organization asked for. Folding it into USER would make an
   * org with strict rules look like an org with broken workflows, and folding
   * it into SYSTEM would page somebody every time a policy did its job.
   */
  POLICY: "policy",
} as const;

export type ExecutionErrorType =
  (typeof ExecutionErrorType)[keyof typeof ExecutionErrorType];
