import type { SQSClient } from "@aws-sdk/client-sqs";
import type { ethers } from "ethers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearInterfaceCache,
  getInterface,
} from "../../src/chains/interface-cache";
import type {
  ChainProviderManager,
  SubscribeOptions,
  Unsubscribe,
} from "../../src/chains/provider-manager";
import type { AbiEvent } from "../../src/chains/validation";
import type { DedupStore } from "../../src/listener/dedup";
import {
  EventListener,
  type EventListenerOptions,
} from "../../src/listener/event-listener";

// KEEP-693: stub the phantom helpers so the listener does not call the internal
// API. Default (undefined) keeps existing SQS-path tests on the id-less path.
const { createPhantomExecution, failPhantomExecution } = vi.hoisted(() => ({
  createPhantomExecution: vi.fn(),
  failPhantomExecution: vi.fn(),
}));
vi.mock("../../lib/phantom", () => ({
  createPhantomExecution,
  failPhantomExecution,
}));

// Minimal ABI fixture: a single `Emitted(address indexed sender, uint256 value)`
// matching the Phase 0 E2E fixture contract so unit and integration tests
// share a mental model.
const RAW_EVENTS_ABI: AbiEvent[] = [
  {
    type: "event",
    name: "Emitted",
    inputs: [
      { name: "sender", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
];

const EVENTS_ABI_STRINGS = [
  "event Emitted(address indexed sender, uint256 value)",
];

const WORKFLOW_ID = "wf-abc";
const USER_ID = "user-1";
const CONTRACT_ADDRESS = "0x1111111111111111111111111111111111111111";
const SENDER = "0x2222222222222222222222222222222222222222";
const SQS_QUEUE_URL = "https://sqs.test/queue";

interface MockProviderManager {
  manager: ChainProviderManager;
  subscribeToLogs: ReturnType<typeof vi.fn>;
  capturedHandler: ((log: ethers.Log) => Promise<void> | void) | null;
  unsubscribe: ReturnType<typeof vi.fn>;
}

function makeProviderManagerMock(): MockProviderManager {
  const unsubscribe: Unsubscribe = vi.fn();
  let capturedHandler: ((log: ethers.Log) => Promise<void> | void) | null =
    null;
  const subscribeToLogs = vi.fn(async (opts: SubscribeOptions) => {
    capturedHandler = opts.handler;
    return unsubscribe;
  });
  const manager = {
    subscribeToLogs,
  } as unknown as ChainProviderManager;
  return {
    manager,
    subscribeToLogs,
    get capturedHandler() {
      return capturedHandler;
    },
    set capturedHandler(fn) {
      capturedHandler = fn;
    },
    unsubscribe: unsubscribe as ReturnType<typeof vi.fn>,
  };
}

function makeDedupMock(): DedupStore & {
  isProcessed: ReturnType<typeof vi.fn>;
  markProcessed: ReturnType<typeof vi.fn>;
} {
  return {
    isProcessed: vi.fn(async () => false),
    markProcessed: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
  } as DedupStore & {
    isProcessed: ReturnType<typeof vi.fn>;
    markProcessed: ReturnType<typeof vi.fn>;
  };
}

function makeSqsMock(): SQSClient & { send: ReturnType<typeof vi.fn> } {
  return {
    send: vi.fn(async () => ({ MessageId: "msg-1" })),
  } as unknown as SQSClient & { send: ReturnType<typeof vi.fn> };
}

function buildOptions(
  overrides: Partial<EventListenerOptions> = {},
): EventListenerOptions {
  const providerMock = makeProviderManagerMock();
  return {
    workflowId: WORKFLOW_ID,
    userId: USER_ID,
    workflowName: "Unit Test",
    chainId: 31_337,
    wssUrl: "ws://localhost:8546",
    contractAddress: CONTRACT_ADDRESS,
    eventName: "Emitted",
    eventsAbiStrings: EVENTS_ABI_STRINGS,
    rawEventsAbi: RAW_EVENTS_ABI,
    sqs: makeSqsMock(),
    sqsQueueUrl: SQS_QUEUE_URL,
    dedup: makeDedupMock(),
    providerManager: providerMock.manager,
    jitterMs: 0,
    ...overrides,
  };
}

function makeLog(params: {
  txHash: string;
  sender: string;
  value: bigint;
}): ethers.Log {
  const iface = getInterface(EVENTS_ABI_STRINGS);
  const { topics, data } = iface.encodeEventLog("Emitted", [
    params.sender,
    params.value,
  ]);
  // Cast via unknown because ethers.Log has getters on a real Log instance
  // that we don't need here; the EventListener only reads topics/data and
  // metadata fields.
  return {
    topics,
    data,
    address: CONTRACT_ADDRESS,
    blockNumber: 100,
    blockHash:
      "0x3333333333333333333333333333333333333333333333333333333333333333",
    transactionHash: params.txHash,
    transactionIndex: 0,
    index: 0,
  } as unknown as ethers.Log;
}

describe("EventListener", () => {
  beforeEach(() => {
    clearInterfaceCache();
    createPhantomExecution.mockReset();
    failPhantomExecution.mockReset();
  });

  describe("lifecycle", () => {
    it("subscribes with the correct (chain, address, topic0) on start", async () => {
      const providerMock = makeProviderManagerMock();
      const listener = new EventListener(
        buildOptions({ providerManager: providerMock.manager }),
      );
      await listener.start();

      expect(providerMock.subscribeToLogs).toHaveBeenCalledTimes(1);
      const call = providerMock.subscribeToLogs.mock
        .calls[0][0] as SubscribeOptions;
      expect(call.chainId).toBe(31_337);
      expect(call.address).toBe(CONTRACT_ADDRESS);

      const iface = getInterface(EVENTS_ABI_STRINGS);
      const expectedTopic = iface.getEvent("Emitted")?.topicHash;
      expect(call.topic0).toBe(expectedTopic);
      expect(listener.isStarted()).toBe(true);
    });

    it("start is idempotent", async () => {
      const providerMock = makeProviderManagerMock();
      const listener = new EventListener(
        buildOptions({ providerManager: providerMock.manager }),
      );
      await listener.start();
      await listener.start();
      expect(providerMock.subscribeToLogs).toHaveBeenCalledTimes(1);
    });

    it("stop calls the unsubscribe returned by subscribeToLogs", async () => {
      const providerMock = makeProviderManagerMock();
      const listener = new EventListener(
        buildOptions({ providerManager: providerMock.manager }),
      );
      await listener.start();
      listener.stop();
      expect(providerMock.unsubscribe).toHaveBeenCalledTimes(1);
      expect(listener.isStarted()).toBe(false);
    });

    it("stop without start is a no-op", () => {
      const providerMock = makeProviderManagerMock();
      const listener = new EventListener(
        buildOptions({ providerManager: providerMock.manager }),
      );
      listener.stop();
      expect(providerMock.unsubscribe).not.toHaveBeenCalled();
    });

    it("throws if the event name is not in the ABI", async () => {
      const listener = new EventListener(
        buildOptions({ eventName: "Missing" }),
      );
      await expect(listener.start()).rejects.toThrow(/Missing/);
    });
  });

  describe("log handling", () => {
    it("dedup miss -> mark + SQS send", async () => {
      const providerMock = makeProviderManagerMock();
      const dedup = makeDedupMock();
      const sqs = makeSqsMock();
      const listener = new EventListener(
        buildOptions({
          providerManager: providerMock.manager,
          dedup,
          sqs,
        }),
      );
      await listener.start();

      const log = makeLog({
        txHash:
          "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        sender: SENDER,
        value: 42n,
      });
      await providerMock.capturedHandler!(log);

      expect(dedup.isProcessed).toHaveBeenCalledWith(
        WORKFLOW_ID,
        log.transactionHash,
      );
      expect(dedup.markProcessed).toHaveBeenCalledWith(
        WORKFLOW_ID,
        log.transactionHash,
      );
      expect(sqs.send).toHaveBeenCalledTimes(1);
    });

    // KEEP-693: phantom pre-creation wiring.
    it("pre-creates a phantom and carries its id on the event message", async () => {
      createPhantomExecution.mockResolvedValue("exec_ph");
      const providerMock = makeProviderManagerMock();
      const sqs = makeSqsMock();
      const listener = new EventListener(
        buildOptions({
          providerManager: providerMock.manager,
          dedup: makeDedupMock(),
          sqs,
        }),
      );
      await listener.start();

      await providerMock.capturedHandler!(
        makeLog({
          txHash: `0x${"a".repeat(64)}`,
          sender: SENDER,
          value: 7n,
        }),
      );

      expect(createPhantomExecution).toHaveBeenCalledWith(WORKFLOW_ID, USER_ID);
      const command = sqs.send.mock.calls[0][0] as {
        input: { MessageBody: string };
      };
      expect(JSON.parse(command.input.MessageBody).executionId).toBe("exec_ph");
    });

    it("marks the phantom failed with ES-0001 when the enqueue fails", async () => {
      createPhantomExecution.mockResolvedValue("exec_ph");
      const providerMock = makeProviderManagerMock();
      const sqs = makeSqsMock();
      sqs.send.mockRejectedValueOnce(new Error("SQS down"));
      const listener = new EventListener(
        buildOptions({
          providerManager: providerMock.manager,
          dedup: makeDedupMock(),
          sqs,
        }),
      );
      await listener.start();

      await providerMock.capturedHandler!(
        makeLog({
          txHash: `0x${"b".repeat(64)}`,
          sender: SENDER,
          value: 7n,
        }),
      );

      expect(failPhantomExecution).toHaveBeenCalledWith(
        "exec_ph",
        "ES-0001",
        expect.stringContaining("SQS down"),
      );
    });

    it("dedup hit -> skip SQS", async () => {
      const providerMock = makeProviderManagerMock();
      const dedup = makeDedupMock();
      dedup.isProcessed.mockResolvedValue(true);
      const sqs = makeSqsMock();
      const listener = new EventListener(
        buildOptions({
          providerManager: providerMock.manager,
          dedup,
          sqs,
        }),
      );
      await listener.start();
      await providerMock.capturedHandler!(
        makeLog({
          txHash:
            "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          sender: SENDER,
          value: 1n,
        }),
      );
      expect(dedup.markProcessed).not.toHaveBeenCalled();
      expect(sqs.send).not.toHaveBeenCalled();
    });

    it("dedup isProcessed failure -> still forwards to SQS (best-effort)", async () => {
      // The dedup read failing must not drop the event. Downstream is the
      // idempotency authority, so a duplicate is acceptable; a lost event
      // is not.
      const providerMock = makeProviderManagerMock();
      const dedup = makeDedupMock();
      dedup.isProcessed.mockRejectedValue(new Error("redis down"));
      const sqs = makeSqsMock();
      const listener = new EventListener(
        buildOptions({
          providerManager: providerMock.manager,
          dedup,
          sqs,
        }),
      );
      await listener.start();

      await expect(
        providerMock.capturedHandler!(
          makeLog({
            txHash:
              "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            sender: SENDER,
            value: 1n,
          }),
        ),
      ).resolves.toBeUndefined();
      expect(sqs.send).toHaveBeenCalledTimes(1);
    });

    it("applies jitter up to the configured cap before forwarding", async () => {
      // Pin Math.random() to 1 so the jitter is exactly the cap, and use
      // fake timers so the test does not actually wait. The goal is to
      // verify the jitter branch executes and respects the cap; precise
      // timing is out of scope.
      const randomSpy = vi.spyOn(Math, "random").mockReturnValue(1);
      vi.useFakeTimers();
      try {
        const providerMock = makeProviderManagerMock();
        const sqs = makeSqsMock();
        const listener = new EventListener(
          buildOptions({
            providerManager: providerMock.manager,
            sqs,
            jitterMs: 7_000,
          }),
        );
        await listener.start();

        const handlerPromise = providerMock.capturedHandler!(
          makeLog({
            txHash:
              "0xffff000000000000000000000000000000000000000000000000000000000000",
            sender: SENDER,
            value: 9n,
          }),
        );

        // Before advancing timers the handler has not reached SQS.
        await Promise.resolve();
        expect(sqs.send).not.toHaveBeenCalled();

        // Advance to just under the cap - still no send.
        await vi.advanceTimersByTimeAsync(6_999);
        expect(sqs.send).not.toHaveBeenCalled();

        // Advance past the cap - send happens.
        await vi.advanceTimersByTimeAsync(1);
        await handlerPromise;
        expect(sqs.send).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
        randomSpy.mockRestore();
      }
    });

    it("dedup markProcessed failure -> SQS send already happened, swallowed", async () => {
      // The mark happens after the send. A mark failure must not throw out
      // of the handler (it's logged and swallowed) and must not affect the
      // SQS delivery we already made.
      const providerMock = makeProviderManagerMock();
      const dedup = makeDedupMock();
      dedup.markProcessed.mockRejectedValue(new Error("redis down"));
      const sqs = makeSqsMock();
      const listener = new EventListener(
        buildOptions({
          providerManager: providerMock.manager,
          dedup,
          sqs,
        }),
      );
      await listener.start();

      await expect(
        providerMock.capturedHandler!(
          makeLog({
            txHash:
              "0xdede000000000000000000000000000000000000000000000000000000000000",
            sender: SENDER,
            value: 1n,
          }),
        ),
      ).resolves.toBeUndefined();
      expect(sqs.send).toHaveBeenCalledTimes(1);
    });

    it("SQS message contains the correct workflowId, triggerType, and payload", async () => {
      const providerMock = makeProviderManagerMock();
      const sqs = makeSqsMock();
      const listener = new EventListener(
        buildOptions({ providerManager: providerMock.manager, sqs }),
      );
      await listener.start();

      const txHash =
        "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
      await providerMock.capturedHandler!(
        makeLog({ txHash, sender: SENDER, value: 42n }),
      );

      expect(sqs.send).toHaveBeenCalledTimes(1);
      const command = sqs.send.mock.calls[0][0] as {
        input: {
          QueueUrl: string;
          MessageBody: string;
          MessageAttributes: Record<string, { StringValue: string }>;
        };
      };
      expect(command.input.QueueUrl).toBe(SQS_QUEUE_URL);
      expect(command.input.MessageAttributes.WorkflowId.StringValue).toBe(
        WORKFLOW_ID,
      );
      expect(command.input.MessageAttributes.TriggerType.StringValue).toBe(
        "event",
      );
      const body = JSON.parse(command.input.MessageBody) as {
        workflowId: string;
        userId: string;
        triggerType: string;
        triggerData: {
          eventName: string;
          args: { value: { value: string; type: string } };
          transactionHash: string;
        };
      };
      expect(body.workflowId).toBe(WORKFLOW_ID);
      expect(body.userId).toBe(USER_ID);
      expect(body.triggerType).toBe("event");
      expect(body.triggerData.eventName).toBe("Emitted");
      expect(body.triggerData.args.value.value).toBe("42");
      expect(body.triggerData.args.value.type).toBe("uint256");
      expect(body.triggerData.transactionHash).toBe(txHash);
    });

    it("ignores logs whose parsed name does not match eventName", async () => {
      // Build a second listener configured for a different event name; feed
      // it a log for "Emitted" and assert nothing is forwarded. Parsing the
      // log with a cache that only knows the Emitted ABI will succeed, but
      // the name filter rejects it.
      const providerMock = makeProviderManagerMock();
      const dedup = makeDedupMock();
      const sqs = makeSqsMock();
      const listener = new EventListener(
        buildOptions({
          eventName: "DifferentEvent",
          eventsAbiStrings: [
            "event Emitted(address indexed sender, uint256 value)",
            "event DifferentEvent(uint256 value)",
          ],
          rawEventsAbi: [
            ...RAW_EVENTS_ABI,
            {
              type: "event",
              name: "DifferentEvent",
              inputs: [{ name: "value", type: "uint256", indexed: false }],
            },
          ],
          providerManager: providerMock.manager,
          dedup,
          sqs,
        }),
      );
      await listener.start();
      await providerMock.capturedHandler!(
        makeLog({
          txHash:
            "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          sender: SENDER,
          value: 1n,
        }),
      );
      expect(dedup.markProcessed).not.toHaveBeenCalled();
      expect(sqs.send).not.toHaveBeenCalled();
    });
  });
});
