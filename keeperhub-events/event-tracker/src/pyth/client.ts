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
  query = "",
): Promise<unknown> {
  const url = `${KEEPERHUB_API_URL}${API_PATH}${query}`;
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

export async function fetchPythRegistrations(): Promise<{
  enabled: boolean;
  registrations: PythRegistration[];
}> {
  const data = (await callApi("GET")) as {
    enabled?: boolean;
    workflows?: PythRegistration[];
  };
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
  return { enabled: data.enabled === true, registrations: data.workflows };
}

/** Workflows whose checkpoint holds a dispatch still waiting to be enqueued. */
export async function fetchPendingPythWorkflows(): Promise<Set<string>> {
  const data = (await callApi("GET", undefined, "?view=pending")) as {
    pending?: unknown;
  };
  if (
    !Array.isArray(data.pending) ||
    data.pending.some((workflowId) => typeof workflowId !== "string")
  ) {
    throw new Error("Invalid pending Pyth workflows");
  }
  return new Set(data.pending as string[]);
}

/** Resolves to the outcome of the last observe or pending command sent. */
export async function submitPythObservation(
  registration: PythRegistration,
  sessionId: string,
  update?: HermesPrice,
  rebaseline = false,
): Promise<string> {
  const identity = {
    workflowId: registration.workflowId,
    configHash: registration.configHash,
    sessionId,
  };
  const command = {
    ...identity,
    action: update ? "observe" : "pending",
    ...(update ? { update, rebaseline } : {}),
  };
  let outcome = "";
  // If an earlier pending dispatch blocks this observation, flush it then
  // offer the same price again. A replay is harmless: matching is durable.
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = (await callApi("POST", command)) as Observation;
    if (!response || typeof response.outcome !== "string") {
      throw new Error("Invalid Pyth observation response");
    }
    outcome = response.outcome;
    if (!response.pending) {
      return outcome;
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
      return outcome;
    }
  }
  return outcome;
}
