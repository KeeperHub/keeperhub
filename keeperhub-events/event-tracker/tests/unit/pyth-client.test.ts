import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchPendingPythWorkflows,
  fetchPythRegistrations,
  submitPythObservation,
} from "../../src/pyth/client";

const { enqueue, sign, fetchMock } = vi.hoisted(() => ({
  enqueue: vi.fn(),
  sign: vi.fn(),
  fetchMock: vi.fn(),
}));
vi.mock("../../lib/config/environment", () => ({
  KEEPERHUB_API_URL: "http://localhost",
  SQS_QUEUE_URL: "test-queue",
}));
vi.mock("../../lib/sqs-client", () => ({ sqs: {} }));
vi.mock("../../lib/utils/fetch-utils", () => ({ signHmacHeaders: sign }));
vi.mock("../../lib/workflow-sqs", () => ({
  enqueueWorkflowUpstreamTrigger: enqueue,
}));
const registration = {
  workflowId: "workflow",
  feedId: "a".repeat(64),
  configHash: "b".repeat(64),
};
const pending = {
  workflowId: registration.workflowId,
  userId: "owner",
  executionId: "persisted-execution",
  configHash: registration.configHash,
  triggerData: { source: "pyth-hermes" },
};
const update = {
  id: registration.feedId,
  price: { price: "100", conf: "1", expo: 0, publish_time: 1000 },
};
const respond = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200 });
const commands = () =>
  fetchMock.mock.calls.map((call) => JSON.parse(call[1].body));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  sign.mockReturnValue({ "X-KH-Caller": "events" });
  enqueue.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllGlobals());

describe("Pyth durable dispatch client", () => {
  it("does not ACK a failed or ambiguous queue send", async () => {
    fetchMock.mockResolvedValueOnce(respond({ outcome: "crossed", pending }));
    enqueue.mockRejectedValueOnce(new Error("queue timeout"));
    await expect(
      submitPythObservation(registration, "session", update),
    ).rejects.toThrow("queue timeout");
    expect(commands().map((command) => command.action)).toEqual(["observe"]);
  });

  it("reuses the persisted execution after a lost ACK reply", async () => {
    fetchMock
      .mockResolvedValueOnce(respond({ outcome: "crossed", pending }))
      .mockRejectedValueOnce(new Error("lost ACK reply"))
      .mockResolvedValueOnce(respond({ outcome: "pending", pending }))
      .mockResolvedValueOnce(respond({ outcome: "acknowledged" }));
    await expect(
      submitPythObservation(registration, "session", update),
    ).rejects.toThrow("lost ACK reply");
    await submitPythObservation(registration, "new-session");
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.calls.map((call) => call[2].executionId)).toEqual([
      pending.executionId,
      pending.executionId,
    ]);
    expect(commands().map((command) => command.action)).toEqual([
      "observe",
      "ack",
      "pending",
      "ack",
    ]);
  });

  it("flushes an older pending signal before retrying the same observation", async () => {
    fetchMock
      .mockResolvedValueOnce(respond({ outcome: "pending", pending }))
      .mockResolvedValueOnce(respond({ outcome: "acknowledged" }))
      .mockResolvedValueOnce(respond({ outcome: "observed" }));
    await submitPythObservation(registration, "session", update);
    const sent = commands();
    expect(sent.map((command) => command.action)).toEqual([
      "observe",
      "ack",
      "observe",
    ]);
    expect(sent[0]).toEqual(sent[2]);
  });

  it("sends the rebaseline request with the observation and reports the outcome", async () => {
    fetchMock
      .mockResolvedValueOnce(respond({ outcome: "baseline" }))
      .mockResolvedValueOnce(respond({ outcome: "idle" }));
    await expect(
      submitPythObservation(registration, "session", update, true),
    ).resolves.toBe("baseline");
    await expect(submitPythObservation(registration, "session")).resolves.toBe(
      "idle",
    );
    const [observe, recovery] = commands();
    expect(observe).toMatchObject({ action: "observe", rebaseline: true });
    expect(recovery).not.toHaveProperty("rebaseline");
  });

  it("rejects a pending dispatch for another workflow", async () => {
    fetchMock.mockResolvedValueOnce(
      respond({
        outcome: "pending",
        pending: { ...pending, workflowId: "other" },
      }),
    );
    await expect(
      submitPythObservation(registration, "session"),
    ).rejects.toThrow("Invalid pending");
    expect(enqueue).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces API failures without enqueueing or acknowledging", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("unavailable", { status: 503 }),
    );
    await expect(
      submitPythObservation(registration, "session", update),
    ).rejects.toThrow("HTTP 503");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("reports whether the app has Pyth enabled alongside its registrations", async () => {
    fetchMock.mockResolvedValueOnce(
      respond({ enabled: true, workflows: [registration] }),
    );
    await expect(fetchPythRegistrations()).resolves.toEqual({
      enabled: true,
      registrations: [registration],
    });
  });

  it("looks up pending dispatches through the signed discovery path", async () => {
    fetchMock
      .mockResolvedValueOnce(respond({ pending: ["workflow"] }))
      .mockResolvedValueOnce(respond({ pending: [7] }));
    await expect(fetchPendingPythWorkflows()).resolves.toEqual(
      new Set(["workflow"]),
    );
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://localhost/api/internal/pyth-triggers?view=pending",
    );
    expect(sign).toHaveBeenCalledWith(
      "GET",
      "http://localhost/api/internal/pyth-triggers?view=pending",
      "",
    );
    await expect(fetchPendingPythWorkflows()).rejects.toThrow(
      "Invalid pending Pyth workflows",
    );
  });

  it("authenticates discovery and rejects malformed registrations", async () => {
    fetchMock.mockResolvedValueOnce(
      respond({ workflows: [{ ...registration, feedId: "invalid" }] }),
    );
    await expect(fetchPythRegistrations()).rejects.toThrow(
      "Invalid Pyth workflow registrations",
    );
    expect(sign).toHaveBeenCalledWith(
      "GET",
      "http://localhost/api/internal/pyth-triggers",
      "",
    );
    expect(fetchMock.mock.calls[0][1].redirect).toBe("error");
  });
});
