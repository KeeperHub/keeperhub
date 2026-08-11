import type { Message } from "@aws-sdk/client-sqs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same lightweight harness as process-message-auth.test.ts, but the SQS mock
// also captures SendMessageCommand so we can assert the DLQ copy, and records
// each command's constructor input so a send can be told apart from a delete.
const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("./in-process", () => ({ executeInProcess: vi.fn() }));
vi.mock("./k8s-job", () => ({ createWorkflowJob: vi.fn() }));
vi.mock("./api-execute", () => ({ executeViaApi: vi.fn() }));
vi.mock("./execution-mode", () => ({ resolveDispatchTarget: vi.fn() }));
vi.mock("./billing-guard", () => ({ checkExecutionLimitForExecutor: vi.fn() }));
vi.mock("./feature-guard", () => ({
  checkWorkflowFeaturesForExecutor: vi.fn(),
}));
vi.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: class {
    send = sendMock;
  },
  DeleteMessageCommand: class {
    kind = "delete";
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  },
  SendMessageCommand: class {
    kind = "send";
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  },
  ReceiveMessageCommand: class {},
}));

import { signSqsMessageAttributes } from "../lib/sqs-message-auth";
import { CONFIG } from "./config";
import { processMessage } from "./index";

const DLQ_URL = "https://sqs.test/000000000000/keeperhub-workflow-queue-dlq";

const VALID = {
  triggerType: "schedule",
  workflowId: "wf1",
  scheduleId: "s1",
  triggerTime: "2026-01-01T00:00:00.000Z",
};

function signed(body: unknown): Message {
  const str = JSON.stringify(body);
  return {
    Body: str,
    ReceiptHandle: "rh-1",
    MessageAttributes: signSqsMessageAttributes("scheduler", CONFIG.sqsQueueUrl, str),
  } as Message;
}

function unsigned(body: unknown): Message {
  return { Body: JSON.stringify(body), ReceiptHandle: "rh-1" } as Message;
}

type Sent = { kind: string; input: Record<string, unknown> };
function sends(): Sent[] {
  return sendMock.mock.calls.map((c) => c[0] as Sent);
}

let savedMode: typeof CONFIG.sqsHmacMode;
let savedDlqUrl: string | undefined;
let savedSecret: string | undefined;

beforeEach(() => {
  sendMock.mockReset();
  savedMode = CONFIG.sqsHmacMode;
  savedDlqUrl = CONFIG.sqsDlqUrl;
  savedSecret = process.env.INTERNAL_SERVICE_HMAC_SECRET;
  process.env.INTERNAL_SERVICE_HMAC_SECRET = "test-secret";
  CONFIG.sqsDlqUrl = DLQ_URL;
});

afterEach(() => {
  CONFIG.sqsHmacMode = savedMode;
  CONFIG.sqsDlqUrl = savedDlqUrl;
  process.env.INTERNAL_SERVICE_HMAC_SECRET = savedSecret;
});

describe("processMessage DLQ capture", () => {
  it("copies an enforce-mode unsigned drop to the DLQ before deleting", async () => {
    CONFIG.sqsHmacMode = "enforce";
    const run = vi.fn().mockResolvedValue(undefined);
    const msg = unsigned(VALID);

    await processMessage(msg, run);

    expect(run).not.toHaveBeenCalled();
    const calls = sends();
    expect(calls).toHaveLength(2);
    // The DLQ copy happens first, then the delete from the main queue.
    expect(calls[0].kind).toBe("send");
    expect(calls[0].input.QueueUrl).toBe(DLQ_URL);
    expect(calls[0].input.MessageBody).toBe(msg.Body);
    const attrs = calls[0].input.MessageAttributes as Record<
      string,
      { StringValue?: string }
    >;
    expect(attrs["X-KH-Reason"].StringValue).toBe("unsigned");
    expect(calls[1].kind).toBe("delete");
    expect(calls[1].input.QueueUrl).toBe(CONFIG.sqsQueueUrl);
    expect(calls[1].input.ReceiptHandle).toBe("rh-1");
  });

  it("tags a tampered-signature drop with its failure reason and keeps its attributes", async () => {
    CONFIG.sqsHmacMode = "enforce";
    const run = vi.fn().mockResolvedValue(undefined);
    const msg = signed(VALID);
    msg.Body = JSON.stringify({ ...VALID, workflowId: "victim" });

    await processMessage(msg, run);

    const calls = sends();
    expect(calls).toHaveLength(2);
    const attrs = calls[0].input.MessageAttributes as Record<
      string,
      { StringValue?: string }
    >;
    expect(attrs["X-KH-Reason"].StringValue).toBe("bad_signature");
    // Original signing attributes ride along for forensic review.
    expect(attrs["X-KH-Signature"]).toBeDefined();
  });

  it("copies a malformed-JSON drop to the DLQ regardless of HMAC mode", async () => {
    CONFIG.sqsHmacMode = "off";
    const run = vi.fn().mockResolvedValue(undefined);
    const msg = { Body: "{not-json", ReceiptHandle: "rh-1" } as Message;

    await processMessage(msg, run);

    expect(run).not.toHaveBeenCalled();
    const calls = sends();
    expect(calls).toHaveLength(2);
    expect(calls[0].kind).toBe("send");
    expect(calls[0].input.MessageBody).toBe("{not-json");
    const attrs = calls[0].input.MessageAttributes as Record<
      string,
      { StringValue?: string }
    >;
    expect(attrs["X-KH-Reason"].StringValue).toBe("malformed_json");
  });

  it("deletes without a DLQ copy when SQS_DLQ_URL is unset", async () => {
    CONFIG.sqsDlqUrl = undefined;
    CONFIG.sqsHmacMode = "enforce";
    const run = vi.fn().mockResolvedValue(undefined);

    await processMessage(unsigned(VALID), run);

    const calls = sends();
    expect(calls).toHaveLength(1);
    expect(calls[0].kind).toBe("delete");
  });

  it("still deletes from the main queue when the DLQ copy fails", async () => {
    CONFIG.sqsHmacMode = "enforce";
    // The DLQ send rejects; the subsequent delete resolves.
    sendMock.mockRejectedValueOnce(new Error("dlq unreachable"));
    const run = vi.fn().mockResolvedValue(undefined);

    await processMessage(unsigned(VALID), run);

    const calls = sends();
    expect(calls).toHaveLength(2);
    expect(calls[0].kind).toBe("send");
    expect(calls[1].kind).toBe("delete");
    expect(calls[1].input.QueueUrl).toBe(CONFIG.sqsQueueUrl);
  });

  it("does not route a successfully processed message to the DLQ", async () => {
    CONFIG.sqsHmacMode = "enforce";
    const run = vi.fn().mockResolvedValue(undefined);

    await processMessage(signed(VALID), run);

    expect(run).toHaveBeenCalledOnce();
    const calls = sends();
    expect(calls).toHaveLength(1);
    expect(calls[0].kind).toBe("delete");
    expect(calls[0].input.QueueUrl).toBe(CONFIG.sqsQueueUrl);
  });
});
