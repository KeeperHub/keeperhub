import { KEEPERHUB_API_URL, SQS_QUEUE_URL } from "../../lib/config/environment";
import { sqs } from "../../lib/sqs-client";
import { signHmacHeaders } from "../../lib/utils/fetch-utils";
import { enqueueWorkflowUpstreamTrigger } from "../../lib/workflow-sqs";
import type { HermesPrice } from "./hermes-stream";

export type PythRegistration = {
  workflowId: string;
  feedId: string;
  configHash: string;
};
type Pending = {
  workflowId: string;
  userId: string;
  executionId: string;
  configHash: string;
  triggerData: Record<string, unknown>;
};
type Observation = { outcome: string; pending?: Pending };
const API_PATH = "/api/internal/pyth-triggers";

async function callApi(
  method: "GET" | "POST",
  command?: unknown,
): Promise<unknown> {
  const url = `${KEEPERHUB_API_URL}${API_PATH}`;
  const body = command === undefined ? "" : JSON.stringify(command);
  const response = await fetch(url, {
    method,
    ...(method === "POST" ? { body } : {}),
    headers: {
      "Content-Type": "application/json",
      ...signHmacHeaders(method, url, body),
    },
    signal: AbortSignal.timeout(8000),
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(`Pyth trigger API returned HTTP ${response.status}`);
  }
  return await response.json();
}

export async function fetchPythRegistrations(): Promise<PythRegistration[]> {
  const data = (await callApi("GET")) as { workflows?: PythRegistration[] };
  if (
    !Array.isArray(data.workflows) ||
    data.workflows.some(
      (item) =>
        !item ||
        typeof item.workflowId !== "string" ||
        !/^[a-f0-9]{64}$/.test(item.feedId) ||
        !/^[a-f0-9]{64}$/.test(item.configHash),
    )
  ) {
    throw new Error("Invalid Pyth workflow registrations");
  }
  return data.workflows;
}

export async function submitPythObservation(
  registration: PythRegistration,
  sessionId: string,
  update?: HermesPrice,
): Promise<void> {
  const identity = {
    workflowId: registration.workflowId,
    configHash: registration.configHash,
    sessionId,
  };
  const command = {
    ...identity,
    action: update ? "observe" : "pending",
    ...(update ? { update } : {}),
  };
  // If an earlier pending dispatch blocks this observation, flush it then
  // offer the same price again. A replay is harmless: matching is durable.
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = (await callApi("POST", command)) as Observation;
    if (!response || typeof response.outcome !== "string") {
      throw new Error("Invalid Pyth observation response");
    }
    if (!response.pending) {
      return;
    }
    const pending = response.pending;
    if (
      pending.workflowId !== registration.workflowId ||
      pending.configHash !== registration.configHash ||
      typeof pending.executionId !== "string" ||
      !pending.executionId ||
      typeof pending.userId !== "string" ||
      !pending.triggerData
    ) {
      throw new Error("Invalid pending Pyth dispatch");
    }
    await enqueueWorkflowUpstreamTrigger(sqs, SQS_QUEUE_URL, pending);
    // Never acknowledge a failed/ambiguous send. The same execution ID stays
    // recoverable after a restart; the executor claims it at most once.
    await callApi("POST", {
      ...identity,
      action: "ack",
      executionId: pending.executionId,
    });
    if (!update || response.outcome !== "pending") {
      return;
    }
  }
}
