/**
 * Shared "Fail workflow on error" handling for the web3 read steps.
 *
 * IMPORTANT: This file must NOT contain "use step" or be a step file.
 * It exists so that multiple step files can reuse the soft-fail decision
 * without exporting functions from "use step" files (which breaks the
 * workflow bundler).
 */
import "server-only";
import { redactAllUrls } from "@/lib/rpc/scrub-rpc-urls";
import { resolveFailOnError } from "@/lib/utils";

/** The `failOnError` config field carried by every web3 read action. */
export type ReadFailOnErrorInput = {
  // Mirrors HTTP Request's failOnError. Defaults to true. When false, the step
  // only fails the run for the destination problems marked below.
  failOnError?: boolean;
};

/**
 * Marks the failures the toggle never covers: the ones where the read has no
 * usable destination to call.
 *
 * This is the read-side of the line HTTP Request draws (see httpRequest in
 * lib/workflow/nodes/http-request/perform.ts). There, a missing URL, an
 * unresolved `{{ }}` token, an SSRF-blocked host and a malformed URL hard-fail
 * whatever the toggle says, because a null-data success would let a node that
 * can never work run forever unnoticed. Everything else softens -- including
 * every non-2xx, so a 400 rejecting the request body and a 404 for a missing
 * resource both hand the next node an error rather than aborting the run.
 *
 * The equivalent split for a chain read: the network, the contract address and
 * the RPC config are the destination, so they hard-fail. The ABI, the function
 * name and the arguments are the payload, and whether the chain accepts them
 * is the 400/404 case, so they soften. That matters most inside a For Each,
 * where the payload is built per item from `{{currentItem}}`: one item the
 * contract rejects is a miss to record, not a reason to kill the run.
 */
export type ReadDestinationFailure = {
  // Set only on a failure that leaves the step with nowhere to call.
  destinationError?: true;
};

/**
 * Turn a failed read into a success carrying `error`, when the author has
 * switched "Fail workflow on error" off.
 *
 * Applied once, to the step's final result, so every failure exit is covered.
 * Applying it per-branch instead is what shipped first, and it silently missed
 * every validation exit above the chain call: those return before the toggle
 * is ever read, which is why a node with a bad function name failed identically
 * in both switch positions.
 *
 * `softFields` are the step's data fields, all null, so a downstream node
 * cannot read a failed lookup as real data.
 *
 * Observability is unaffected: every failure path logs through
 * logUserError/logSystemError before returning, so Sentry, Prometheus and the
 * execution log still record the failure. Only control flow changes.
 *
 * The message is redacted here because every web3 URL is an RPC provider
 * endpoint, and withStepLogging only redacts the `success: false` branch (see
 * redactStepError in step-handler.ts) -- a softened success gets no redaction
 * safety net downstream.
 */
export function applyReadFailOnError<TResult extends { success: boolean }>(
  result: TResult,
  failOnError: unknown,
  softFields: Omit<Extract<TResult, { success: true }>, "success" | "error">
): TResult {
  if (result.success || resolveFailOnError(failOnError)) {
    return result;
  }
  const failure = result as unknown as ReadDestinationFailure & {
    error?: string;
  };
  if (failure.destinationError) {
    return result;
  }
  return {
    ...softFields,
    success: true,
    error: redactAllUrls(failure.error ?? "Read failed"),
  } as unknown as TResult;
}
