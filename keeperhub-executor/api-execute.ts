import { CONFIG } from "./config";
import type { ExecutorMessage } from "./types";

export type ApiExecuteTriggerType = ExecutorMessage["triggerType"];

/**
 * Execute a workflow via the KeeperHub API endpoint.
 * Used in "process" execution mode where the API handles execution
 * directly without K8s Job isolation.
 *
 * Sends the precise trigger source (schedule | block | event) in the
 * X-Trigger-Type header so the API can label the per-execution Prometheus
 * counter accurately (see KEEP-556). Without this header, the API falls
 * back to its legacy "scheduled" default for any internal call and the
 * "zero executions in N min" alert family cannot tell trigger sources apart.
 */
export async function executeViaApi(params: {
  workflowId: string;
  executionId: string;
  input: Record<string, unknown>;
  triggerType: ApiExecuteTriggerType;
}): Promise<void> {
  const { workflowId, executionId, input, triggerType } = params;

  const response = await fetch(
    `${CONFIG.keeperhubApiUrl}/api/workflow/${workflowId}/execute`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Service-Key": CONFIG.keeperhubApiKey,
        "X-Trigger-Type": triggerType,
      },
      body: JSON.stringify({ executionId, input }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API call failed: ${response.status} - ${errorText}`);
  }

  const result = (await response.json()) as { executionId: string };
  console.log(`[Executor:API] Execution started: ${result.executionId}`);
}
