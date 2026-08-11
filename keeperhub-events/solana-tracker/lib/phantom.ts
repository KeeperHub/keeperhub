/**
 * Phantom execution helpers (KEEP-693). Before enqueuing a trigger the ingestor
 * pre-creates a 'phantom' workflow_executions row via the internal API so the
 * run is visible even if it never reaches the executor; the executor upgrades it
 * to 'pending' on dequeue. If the enqueue fails, the phantom is resolved to a
 * coded failure. Both calls are best-effort and must never fail a real trigger.
 *
 * Serves both trigger kinds: event triggers sign as caller "events" with
 * triggerSource "event"; block triggers sign as "scheduler" with source "block".
 */

import { KEEPERHUB_API_URL } from "./config/environment";
import { type HmacCaller, signHmacHeaders } from "./utils/fetch-utils";
import { logger } from "./utils/logger";

export type PhantomTriggerSource = "event" | "block";
/** ES-* = event enqueue failure, BS-* = block enqueue failure, N-* = generic. */
export type PhantomErrorCode = "ES-0001" | "BS-0001" | "N-0002";

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function createPhantomExecution(
  workflowId: string,
  userId: string,
  source: PhantomTriggerSource,
  caller: HmacCaller,
): Promise<string | undefined> {
  const url = `${KEEPERHUB_API_URL}/api/internal/executions`;
  const body = JSON.stringify({
    workflowId,
    userId,
    status: "phantom",
    triggerSource: source,
  });
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...signHmacHeaders("POST", url, body, caller),
      },
      body,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = (await response.json()) as { executionId: string };
    return data.executionId;
  } catch (error) {
    logger.warn(
      `[Phantom] Failed to pre-create execution for ${workflowId}: ${formatError(error)}`,
    );
    return undefined;
  }
}

export async function failPhantomExecution(
  executionId: string,
  errorCode: PhantomErrorCode,
  errorMessage: string,
  caller: HmacCaller,
): Promise<void> {
  const url = `${KEEPERHUB_API_URL}/api/internal/executions/${executionId}`;
  const body = JSON.stringify({
    status: "system_error",
    error: errorMessage,
    errorCode,
  });
  try {
    const response = await fetch(url, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...signHmacHeaders("PATCH", url, body, caller),
      },
      body,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
  } catch (error) {
    logger.warn(
      `[Phantom] Failed to mark execution ${executionId} as failed: ${formatError(error)}`,
    );
  }
}
