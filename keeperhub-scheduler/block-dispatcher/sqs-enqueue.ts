/**
 * SQS Enqueue Helper for Block Triggers
 *
 * Sends block trigger messages to the shared SQS queue.
 */

import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { SQS_QUEUE_URL } from "../lib/config.js";
import { sqs } from "../lib/sqs-client.js";
import { signSqsMessageAttributes } from "../lib/sqs-message-auth.js";
import type { BlockMessage } from "../lib/types.js";

export async function enqueueBlockTrigger(
  message: BlockMessage,
): Promise<void> {
  console.log(
    `[SQS] Enqueuing block trigger: workflow=${message.workflowId}, block=${message.triggerData.blockNumber}`,
  );
  const body = JSON.stringify(message);
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: SQS_QUEUE_URL,
      MessageBody: body,
      MessageAttributes: {
        TriggerType: {
          DataType: "String",
          StringValue: "block",
        },
        WorkflowId: {
          DataType: "String",
          StringValue: message.workflowId,
        },
        ...signSqsMessageAttributes("scheduler", SQS_QUEUE_URL, body),
      },
    }),
  );
}
