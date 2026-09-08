import { createHash, createHmac } from "node:crypto";
import { CONFIG } from "./config";
import type { ExecutorMessage } from "./types";

export type ApiExecuteTriggerType = ExecutorMessage["triggerType"];

const HMAC_CALLER = "executor";

function signHmacHeaders(
  method: string,
  url: string,
  body: string,
): Record<string, string> {
  const secret = process.env.INTERNAL_SERVICE_HMAC_SECRET ?? "";
  const pathname = new URL(url).pathname;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const bodyDigest = createHash("sha256").update(body).digest("hex");
  const signingString = `${method}\n${pathname}\n${HMAC_CALLER}\n${bodyDigest}\n${timestamp}`;
  const signature = createHmac("sha256", secret)
    .update(signingString)
    .digest("hex");
  return {
    "X-KH-Caller": HMAC_CALLER,
    "X-KH-Timestamp": timestamp,
    "X-KH-Signature": signature,
  };
}

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

  const url = `${CONFIG.keeperhubApiUrl}/api/workflow/${workflowId}/execute`;
  const body = JSON.stringify({ executionId, input });
  const hmacHeaders = signHmacHeaders("POST", url, body);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...hmacHeaders,
      "X-Trigger-Type": triggerType,
    },
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API call failed: ${response.status} - ${errorText}`);
  }

  const result = (await response.json()) as { executionId: string };
  console.log(`[Executor:API] Execution started: ${result.executionId}`);
}
