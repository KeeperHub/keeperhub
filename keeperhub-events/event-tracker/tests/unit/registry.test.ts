import type { SQSClient } from "@aws-sdk/client-sqs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChainProviderManager,
  SubscribeOptions,
  Unsubscribe,
} from "../../src/chains/provider-manager";
import type { AbiEvent } from "../../src/chains/validation";
import type { DedupStore } from "../../src/listener/dedup";
import {
  ListenerRegistry,
  type WorkflowRegistration,
} from "../../src/listener/registry";

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

function makeWorkflow(
  id: string,
  overrides: Partial<WorkflowRegistration> = {},
): WorkflowRegistration {
  return {
    workflowId: id,
    userId: "user-1",
    workflowName: `Test ${id}`,
    chainId: 31_337,
    wssUrl: "ws://localhost:8546",
    contractAddress: "0x1111111111111111111111111111111111111111",
    eventName: "Emitted",
    eventsAbiStrings: EVENTS_ABI_STRINGS,
    rawEventsAbi: RAW_EVENTS_ABI,
    // Stable dummy hash. Registry tests assert add/remove behaviour; the
    // real hash is produced by workflow-mapper and covered in its own tests.
    configHash: `hash-${id}`,
    ...overrides,
  };
}

function makeDeps(): {
  providerManager: ChainProviderManager;
  subscribeToLogs: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  dedup: DedupStore;
  sqs: SQSClient;
  sqsQueueUrl: string;
} {
  const unsubscribe: Unsubscribe = vi.fn();
  const subscribeToLogs = vi.fn(async (_opts: SubscribeOptions) => {
    return unsubscribe;
  });
  const providerManager = {
    subscribeToLogs,
  } as unknown as ChainProviderManager;
  const dedup: DedupStore = {
    isProcessed: vi.fn(async () => false),
    markProcessed: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
  };
  const sqs = { send: vi.fn(async () => ({ MessageId: "m" })) };
  return {
    providerManager,
    subscribeToLogs,
    unsubscribe: unsubscribe as ReturnType<typeof vi.fn>,
    dedup,
    sqs: sqs as unknown as SQSClient,
    sqsQueueUrl: "https://sqs.test/queue",
  };
}

describe("ListenerRegistry", () => {
  let deps: ReturnType<typeof makeDeps>;
  let registry: ListenerRegistry;

  beforeEach(() => {
    deps = makeDeps();
    registry = new ListenerRegistry({
      providerManager: deps.providerManager,
      dedup: deps.dedup,
      sqs: deps.sqs,
      sqsQueueUrl: deps.sqsQueueUrl,
    });
  });

  it("add starts a listener and records it by workflowId", async () => {
    await registry.add(makeWorkflow("wf-1"));
    expect(deps.subscribeToLogs).toHaveBeenCalledTimes(1);
    expect(registry.has("wf-1")).toBe(true);
    expect(registry.size()).toBe(1);
    expect(registry.ids()).toEqual(["wf-1"]);
  });

  it("add is idempotent for the same workflowId", async () => {
    await registry.add(makeWorkflow("wf-1"));
    await registry.add(makeWorkflow("wf-1"));
    expect(deps.subscribeToLogs).toHaveBeenCalledTimes(1);
    expect(registry.size()).toBe(1);
  });

  it("remove unsubscribes and drops the listener", async () => {
    await registry.add(makeWorkflow("wf-1"));
    registry.remove("wf-1");
    expect(deps.unsubscribe).toHaveBeenCalledTimes(1);
    expect(registry.has("wf-1")).toBe(false);
    expect(registry.size()).toBe(0);
  });

  it("remove for an unknown id is a no-op", () => {
    registry.remove("unknown");
    expect(deps.unsubscribe).not.toHaveBeenCalled();
  });

  it("stopAll stops every listener and clears the registry", async () => {
    await registry.add(makeWorkflow("wf-1"));
    await registry.add(makeWorkflow("wf-2"));
    await registry.stopAll();
    expect(deps.unsubscribe).toHaveBeenCalledTimes(2);
    expect(registry.size()).toBe(0);
    expect(registry.ids()).toEqual([]);
  });

  it("does not record a listener whose start() throws", async () => {
    // Simulate a start failure by making subscribeToLogs reject.
    deps.subscribeToLogs.mockRejectedValueOnce(new Error("provider down"));
    await registry.add(makeWorkflow("wf-broken"));
    expect(registry.has("wf-broken")).toBe(false);
    expect(registry.size()).toBe(0);
  });

  it("different workflowIds do not collide", async () => {
    await registry.add(makeWorkflow("wf-1"));
    await registry.add(makeWorkflow("wf-2"));
    expect(deps.subscribeToLogs).toHaveBeenCalledTimes(2);
    expect(new Set(registry.ids())).toEqual(new Set(["wf-1", "wf-2"]));
  });

  describe("getConfigHash", () => {
    it("returns the configHash that was added", async () => {
      await registry.add(makeWorkflow("wf-1", { configHash: "abc123" }));
      expect(registry.getConfigHash("wf-1")).toBe("abc123");
    });

    it("returns undefined for unknown workflowId", () => {
      expect(registry.getConfigHash("unknown")).toBeUndefined();
    });

    it("returns undefined after remove", async () => {
      await registry.add(makeWorkflow("wf-1", { configHash: "abc123" }));
      registry.remove("wf-1");
      expect(registry.getConfigHash("wf-1")).toBeUndefined();
    });

    it("does not change when add is idempotent (same id, different hash)", async () => {
      // A second add for the same workflowId is a no-op - the new config
      // is NOT picked up. Callers must remove+add to update. This locks
      // in the expected behaviour the reconciler relies on.
      await registry.add(makeWorkflow("wf-1", { configHash: "first" }));
      await registry.add(makeWorkflow("wf-1", { configHash: "second" }));
      expect(registry.getConfigHash("wf-1")).toBe("first");
    });

    it("reflects the new hash after remove+add (config change flow)", async () => {
      await registry.add(makeWorkflow("wf-1", { configHash: "first" }));
      registry.remove("wf-1");
      await registry.add(makeWorkflow("wf-1", { configHash: "second" }));
      expect(registry.getConfigHash("wf-1")).toBe("second");
    });
  });
});
