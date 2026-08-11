import type { Message } from "@aws-sdk/client-sqs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same lightweight harness as process-message.test.ts: capture SQS sends and
// stub the heavy dispatch submodules so importing index.ts stays cheap.
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
  DeleteMessageCommand: class {},
  ReceiveMessageCommand: class {},
}));

import { signSqsMessageAttributes } from "../lib/sqs-message-auth";
import { CONFIG } from "./config";
import { processMessage } from "./index";

const VALID = {
  triggerType: "schedule",
  workflowId: "wf1",
  scheduleId: "s1",
  triggerTime: "2026-01-01T00:00:00.000Z",
};

function signed(body: unknown, caller: "scheduler" | "events" | "app" = "scheduler"): Message {
  const str = JSON.stringify(body);
  return {
    Body: str,
    ReceiptHandle: "rh-1",
    // Sign against the queue the executor verifies with (CONFIG.sqsQueueUrl).
    MessageAttributes: signSqsMessageAttributes(caller, CONFIG.sqsQueueUrl, str),
  } as Message;
}

function unsigned(body: unknown): Message {
  return { Body: JSON.stringify(body), ReceiptHandle: "rh-1" } as Message;
}

let savedMode: typeof CONFIG.sqsHmacMode;
let savedMaxAgeEnforce: boolean;
let savedMaxAgeSeconds: number;
let savedSecret: string | undefined;

beforeEach(() => {
  sendMock.mockReset();
  savedMode = CONFIG.sqsHmacMode;
  savedMaxAgeEnforce = CONFIG.sqsHmacMaxAgeEnforce;
  savedMaxAgeSeconds = CONFIG.sqsHmacMaxAgeSeconds;
  savedSecret = process.env.INTERNAL_SERVICE_HMAC_SECRET;
  process.env.INTERNAL_SERVICE_HMAC_SECRET = "test-secret";
});

afterEach(() => {
  CONFIG.sqsHmacMode = savedMode;
  CONFIG.sqsHmacMaxAgeEnforce = savedMaxAgeEnforce;
  CONFIG.sqsHmacMaxAgeSeconds = savedMaxAgeSeconds;
  process.env.INTERNAL_SERVICE_HMAC_SECRET = savedSecret;
});

// A validly-signed message stamped `ageSeconds` in the past.
function signedStale(ageSeconds: number): Message {
  const str = JSON.stringify(VALID);
  const ts = Math.floor(Date.now() / 1000) - ageSeconds;
  return {
    Body: str,
    ReceiptHandle: "rh-1",
    MessageAttributes: signSqsMessageAttributes(
      "scheduler",
      CONFIG.sqsQueueUrl,
      str,
      ts
    ),
  } as Message;
}

describe("processMessage HMAC gating", () => {
  it("off mode processes an unsigned, schema-invalid message", async () => {
    CONFIG.sqsHmacMode = "off";
    const run = vi.fn().mockResolvedValue(undefined);
    await processMessage(unsigned({ workflowId: "wf1" }), run);
    expect(run).toHaveBeenCalledOnce();
    expect(sendMock).toHaveBeenCalledTimes(1); // delete after success
  });

  it("warn mode still processes an unsigned message", async () => {
    CONFIG.sqsHmacMode = "warn";
    const run = vi.fn().mockResolvedValue(undefined);
    await processMessage(unsigned(VALID), run);
    expect(run).toHaveBeenCalledOnce();
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("warn mode still processes a schema-invalid message", async () => {
    CONFIG.sqsHmacMode = "warn";
    const run = vi.fn().mockResolvedValue(undefined);
    await processMessage(signed({ triggerType: "schedule", workflowId: "wf1" }), run);
    expect(run).toHaveBeenCalledOnce();
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("enforce mode drops an unsigned message without running it", async () => {
    CONFIG.sqsHmacMode = "enforce";
    const run = vi.fn().mockResolvedValue(undefined);
    await processMessage(unsigned(VALID), run);
    expect(run).not.toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledTimes(1); // the enforce drop-delete
  });

  it("enforce mode processes a validly signed message", async () => {
    CONFIG.sqsHmacMode = "enforce";
    const run = vi.fn().mockResolvedValue(undefined);
    await processMessage(signed(VALID), run);
    expect(run).toHaveBeenCalledOnce();
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("enforce mode drops a signed-but-tampered message", async () => {
    CONFIG.sqsHmacMode = "enforce";
    const run = vi.fn().mockResolvedValue(undefined);
    const msg = signed(VALID);
    msg.Body = JSON.stringify({ ...VALID, workflowId: "victim" });
    await processMessage(msg, run);
    expect(run).not.toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("enforce mode drops a validly-signed but schema-invalid message", async () => {
    CONFIG.sqsHmacMode = "enforce";
    const run = vi.fn().mockResolvedValue(undefined);
    // Signature is valid over this body, but it fails the schema.
    await processMessage(signed({ triggerType: "schedule", workflowId: "wf1" }), run);
    expect(run).not.toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("processes a stale message when max-age enforcement is off (advisory)", async () => {
    CONFIG.sqsHmacMode = "enforce";
    CONFIG.sqsHmacMaxAgeEnforce = false;
    CONFIG.sqsHmacMaxAgeSeconds = 60;
    const run = vi.fn().mockResolvedValue(undefined);
    await processMessage(signedStale(3600), run);
    expect(run).toHaveBeenCalledOnce();
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("enforce mode drops a stale message when max-age enforcement is on", async () => {
    CONFIG.sqsHmacMode = "enforce";
    CONFIG.sqsHmacMaxAgeEnforce = true;
    CONFIG.sqsHmacMaxAgeSeconds = 60;
    const run = vi.fn().mockResolvedValue(undefined);
    await processMessage(signedStale(3600), run);
    expect(run).not.toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});
