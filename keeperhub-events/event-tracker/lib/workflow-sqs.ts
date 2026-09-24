import { type SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { signSqsMessageAttributes } from "./sqs-message-auth";

/**
 * Shape of every event-trigger message the tracker enqueues to SQS. Kept
 * in one place so the fork-path (`AbstractChain.executeWorkflow`) and
 * the in-process path (`EventListener.sendToSqs`) can not drift from
 * each other as the refactor progresses.
 *
 * Phase 6 will delete the fork path and this helper survives as the sole
 * producer of the SQS contract.
 */

export interface WorkflowEventTrigger {
  // Pre-created phantom execution id. The executor upgrades that row to
  // 'pending'; optional for messages enqueued before phantom pre-creation.
  executionId?: string;
  workflowId: string;
  userId: string;
  triggerData: unknown;
  /**
   * End-to-end latency correlation (issue #2289): minted at the moment the
   * event is first observed, so the executor can join its receive/dispatch
   * stages to the tracker's observation on one key and measure the queue leg.
   */
  correlationId?: string;
  /** Epoch ms when the event was first observed by the tracker. */
  observedAt?: number;
}

export async function enqueueWorkflowEventTrigger(
  client: SQSClient,
  queueUrl: string,
  trigger: WorkflowEventTrigger,
): Promise<void> {
  const payload = {
    // undefined is dropped by JSON.stringify, so legacy messages stay identical.
    executionId: trigger.executionId,
    workflowId: trigger.workflowId,
    userId: trigger.userId,
    triggerType: "event" as const,
    triggerData: trigger.triggerData,
    // Latency correlation (issue #2289): absent for messages enqueued by
    // older tracker versions, so the executor falls back to minting its own.
    correlationId: trigger.correlationId,
    observedAt: trigger.observedAt,
  };
  const body = JSON.stringify(payload);
  await client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      MessageAttributes: {
        TriggerType: { DataType: "String", StringValue: "event" },
        WorkflowId: {
          DataType: "String",
          StringValue: trigger.workflowId,
        },
        ...signSqsMessageAttributes("events", queueUrl, body),
      },
    }),
  );
}
