import type { Message } from "@aws-sdk/client-sqs";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Capture SQS sends and the system-error backstop without standing up AWS or a
// database. The spies are hoisted so they exist before the vi.mock factories run.
const { sendMock, failMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  failMock: vi.fn(),
}));

// A transitive lib import is server-only; stub the guard so the executor module
// imports under vitest (same pattern as the other e2e/vitest suites).
vi.mock("server-only", () => ({}));

// processMessage drives an injected processor, so the heavy dispatch submodules
// (which pull the generated step-registry and the workflow engine) are never
// exercised here - stub them so importing index.ts stays light.
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

vi.mock("./lib/db-helpers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/db-helpers")>()),
  failExecutionAsSystemError: failMock,
}));

import { processMessage, RequeueSignal } from "./index";

function message(body: unknown): Message {
  return { Body: JSON.stringify(body), ReceiptHandle: "rh-1" } as Message;
}

const VALID_BODY = { workflowId: "wf1", executionId: "e1" };

describe("processMessage SQS backstop", () => {
  beforeEach(() => {
    sendMock.mockReset();
    failMock.mockReset();
  });

  it("deletes the message after a successful process", async () => {
    await processMessage(message(VALID_BODY), () => Promise.resolve());

    expect(failMock).not.toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledTimes(1); // the delete
  });

  it("leaves the message on the queue for a RequeueSignal (no mark, no delete)", async () => {
    await processMessage(message(VALID_BODY), () =>
      Promise.reject(new RequeueSignal("at capacity"))
    );

    // Back-pressure must redeliver via SQS, so neither mark nor delete runs.
    expect(failMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("marks system_error (E-0004) and deletes on a genuine failure", async () => {
    failMock.mockResolvedValue(true);

    await processMessage(message(VALID_BODY), () =>
      Promise.reject(new Error("boom"))
    );

    expect(failMock).toHaveBeenCalledWith(
      expect.anything(),
      "e1",
      expect.objectContaining({ errorCode: "E-0004" })
    );
    expect(sendMock).toHaveBeenCalledTimes(1); // delete still happens
  });

  it("still deletes when the row already advanced past phantom/pending", async () => {
    failMock.mockResolvedValue(false); // CAS matched nothing (row already running)

    await processMessage(message(VALID_BODY), () =>
      Promise.reject(new Error("boom"))
    );

    expect(failMock).toHaveBeenCalledOnce();
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("deletes a malformed message body without marking", async () => {
    await processMessage(
      { Body: "not json{", ReceiptHandle: "rh-1" } as Message,
      () => Promise.resolve()
    );

    expect(failMock).not.toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledTimes(1); // the malformed-body delete
  });
});
