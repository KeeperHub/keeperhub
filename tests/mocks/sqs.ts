import type { Message } from "@aws-sdk/client-sqs";
import { vi } from "vitest";

export type MockSQSMessage = {
  workflowId: string;
  scheduleId: string;
  triggerTime: string;
  triggerType: "schedule";
};

export function createMockSQSClient() {
  return {
    send: vi.fn(),
  };
}

export function createMockSQSMessage(
  body: MockSQSMessage,
  overrides: Partial<Message> = {}
): Message {
  return {
    MessageId: `msg_${Date.now()}`,
    ReceiptHandle: `receipt_${Date.now()}`,
    Body: JSON.stringify(body),
    MD5OfBody: "mock-md5",
    ...overrides,
  };
}

export function createMockReceiveMessageResponse(messages: Message[] = []) {
  return {
    Messages: messages,
    $metadata: {},
  };
}

export function createMockSendMessageResponse(messageId = `msg_${Date.now()}`) {
  return {
    MessageId: messageId,
    MD5OfMessageBody: "mock-md5",
    $metadata: {},
  };
}
