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
