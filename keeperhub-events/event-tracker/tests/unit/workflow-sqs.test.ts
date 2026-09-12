import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { describe, expect, it, vi } from "vitest";
import { enqueueWorkflowEventTrigger } from "../../lib/workflow-sqs";

function fakeClient() {
  const send = vi.fn().mockResolvedValue({});
  const client = { send } as unknown as ConstructorParameters<
    typeof enqueueWorkflowEventTrigger
  >[0];
  return { send, client };
}

function captureBody(send: ReturnType<typeof vi.fn>): unknown {
  const command = send.mock.calls[0][0] as SendMessageCommand;
  const input = command.input as { MessageBody: string };
  return JSON.parse(input.MessageBody);
}

describe("enqueueWorkflowEventTrigger", () => {
  it("carries correlationId and observedAt when provided", async () => {
    const { send, client } = fakeClient();
    await enqueueWorkflowEventTrigger(client, "https://queue", {
      executionId: "exec-1",
      workflowId: "wf-1",
      userId: "u-1",
      triggerData: { eventName: "Transfer" },
      correlationId: "abcd1234efgh5678",
      observedAt: 123456789,
    });

    const body = captureBody(send) as Record<string, unknown>;
    expect(body.workflowId).toBe("wf-1");
    expect(body.triggerType).toBe("event");
    expect(body.correlationId).toBe("abcd1234efgh5678");
    expect(body.observedAt).toBe(123456789);
  });

  it("omits the correlation fields for legacy calls (undefined is dropped)", async () => {
    const { send, client } = fakeClient();
    await enqueueWorkflowEventTrigger(client, "https://queue", {
      executionId: "exec-1",
      workflowId: "wf-1",
      userId: "u-1",
      triggerData: { eventName: "Transfer" },
    });

    const body = captureBody(send) as Record<string, unknown>;
    expect(body.correlationId).toBeUndefined();
    expect(body.observedAt).toBeUndefined();
    expect(Object.keys(body)).not.toContain("correlationId");
  });
});