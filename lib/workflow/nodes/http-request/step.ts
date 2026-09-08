/**
 * Executable step function for the HTTP Request action.
 *
 * This file is intentionally minimal: the Workflow DevKit bundler treats a
 * step file as a boundary -- only `"use step"` exports are stubbed into the
 * workflow-function bundle, while their bodies and the imports they reach
 * stay in the step's Node bundle. Anything else exported from here would be
 * pulled into the workflow bundle (where Node modules are forbidden), so all
 * the worker logic and its `safeFetch` dependency live in `./perform` and we
 * only re-export types.
 */
import "server-only";

import { withStepLogging } from "@/lib/workflow/executor/step-handler";
import {
  type HttpRequestInput,
  type HttpRequestResult,
  httpRequest,
} from "./perform";

export type { HttpRequestInput, HttpRequestResult } from "./perform";

/**
 * HTTP Request Step
 * Makes an HTTP request to an endpoint
 */
// biome-ignore lint/suspicious/useAwait: workflow "use step" requires async
export async function httpRequestStep(
  input: HttpRequestInput
): Promise<HttpRequestResult> {
  "use step";
  return withStepLogging(input, () => httpRequest(input));
}
httpRequestStep.maxRetries = 0;
