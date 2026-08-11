import { type SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { signSqsMessageAttributes } from "./sqs-message-auth";

/**
 * SQS producers for both Solana trigger kinds. The executor is the single
 * consumer and already handles `triggerType: "event"` and `"block"`, so these
 * emit the exact same envelopes the EVM event-tracker and block-dispatcher do -
 * only the `triggerData` shape differs (built by the Solana payload modules).
 */

export interface WorkflowTrigger {
  // Pre-created phantom execution id; the executor upgrades that row to
  // 'pending'. Optional for messages enqueued before a phantom exists.
  executionId?: string;
  workflowId: string;
  userId: string;
  triggerData: unknown;
}

export async function enqueueWorkflowEventTrigger(
  client: SQSClient,
  queueUrl: string,
  trigger: WorkflowTrigger,
): Promise<void> {
  const body = JSON.stringify({
    executionId: trigger.executionId,
    workflowId: trigger.workflowId,
    userId: trigger.userId,
    triggerType: "event" as const,
    triggerData: trigger.triggerData,
  });
  await client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      MessageAttributes: {
        TriggerType: { DataType: "String", StringValue: "event" },
        WorkflowId: { DataType: "String", StringValue: trigger.workflowId },
        ...signSqsMessageAttributes("events", queueUrl, body),
      },
    }),
  );
}

export async function enqueueWorkflowBlockTrigger(
  client: SQSClient,
  queueUrl: string,
  trigger: WorkflowTrigger,
): Promise<void> {
  const body = JSON.stringify({
    executionId: trigger.executionId,
    workflowId: trigger.workflowId,
    userId: trigger.userId,
    triggerType: "block" as const,
    triggerData: trigger.triggerData,
  });
  await client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      MessageAttributes: {
        TriggerType: { DataType: "String", StringValue: "block" },
        WorkflowId: { DataType: "String", StringValue: trigger.workflowId },
        ...signSqsMessageAttributes("scheduler", queueUrl, body),
      },
    }),
  );
}
