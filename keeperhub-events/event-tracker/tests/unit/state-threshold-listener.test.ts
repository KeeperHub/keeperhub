import type { SQSClient } from "@aws-sdk/client-sqs";
import { ethers } from "ethers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Aggregate3Result } from "../../src/chains/multicall3";
import type {
  ChainProviderManager,
  StateCallHandler,
  SubscribeStateOptions,
  Unsubscribe,
} from "../../src/chains/provider-manager";
import type { ArmStateStore } from "../../src/listener/arm-state";
import type { ArmState } from "../../src/listener/state-threshold";
import type { StateThresholdSubscription } from "../../src/listener/state-threshold";
import { StateThresholdListener } from "../../src/listener/state-threshold-listener";

const { createPhantomExecution, failPhantomExecution } = vi.hoisted(() => ({
  createPhantomExecution: vi.fn(),
  failPhantomExecution: vi.fn(),
}));
vi.mock("../../lib/phantom", () => ({
  createPhantomExecution,
  failPhantomExecution,
}));

const { enqueueWorkflowEventTrigger } = vi.hoisted(() => ({
  enqueueWorkflowEventTrigger: vi.fn(),
}));
vi.mock("../../lib/workflow-sqs", () => ({ enqueueWorkflowEventTrigger }));

const coder = ethers.AbiCoder.defaultAbiCoder();
const WORKFLOW_ID = "wf-1";
const SUBSCRIPTION_ID = "sub-1";

function uint(value: bigint): Aggregate3Result {
  return { success: true, returnData: coder.encode(["uint256"], [value]) };
}

const SUBSCRIPTION: StateThresholdSubscription = {
  subscriptionId: SUBSCRIPTION_ID,
  workflowId: WORKFLOW_ID,
  chainId: 1,
  contractAddress: "0x1111111111111111111111111111111111111111",
  callData: "0xdeadbeef",
  outputTypes: ["uint256"],
  outputIndex: 0,
  threshold: 100n,
  comparator: "lt",
  hysteresis: 10n,
};

function makeArmStore(initial: ArmState | null = null): {
  store: ArmStateStore;
  saved: ArmState[];
  loadError: { value: Error | null };
} {
  const saved: ArmState[] = [];
  const loadError = { value: null as Error | null };
  let current = initial;
  const store: ArmStateStore = {
    load: vi.fn(async () => {
      if (loadError.value) {
        throw loadError.value;
      }
      return current;
    }),
    save: vi.fn(async (_id: string, state: ArmState) => {
      current = state;
      saved.push(state);
    }),
    disconnect: vi.fn(async () => undefined),
  };
  return { store, saved, loadError };
}

function makeListener(
  armStore: ArmStateStore,
  overrides: Partial<StateThresholdSubscription> = {},
): {
  listener: StateThresholdListener;
  sample: (result: Aggregate3Result, block: number) => Promise<void>;
  unsubscribe: ReturnType<typeof vi.fn>;
} {
  let handler: StateCallHandler | null = null;
  const unsubscribe = vi.fn() as unknown as Unsubscribe;
  const providerManager = {
    subscribeToState: vi.fn(async (opts: SubscribeStateOptions) => {
      handler = opts.handler;
      return unsubscribe;
    }),
  } as unknown as ChainProviderManager;

  const listener = new StateThresholdListener({
    workflowId: WORKFLOW_ID,
    userId: "user-1",
    workflowName: "Health factor",
    chainId: 1,
    wssUrl: "ws://localhost:8546",
    subscription: { ...SUBSCRIPTION, ...overrides },
    sqs: { send: vi.fn() } as unknown as SQSClient,
    sqsQueueUrl: "https://sqs.test/queue",
    armStore,
    providerManager,
  });

  return {
    listener,
    sample: async (result, block) => {
      if (!handler) {
        throw new Error("listener not started");
      }
      await handler(result, block);
    },
    unsubscribe: unsubscribe as unknown as ReturnType<typeof vi.fn>,
  };
}

function dispatchKeys(): string[] {
  return createPhantomExecution.mock.calls.map((args) => String(args[2]));
}

describe("StateThresholdListener", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createPhantomExecution.mockResolvedValue({
      executionId: "exec-1",
      alreadyExisted: false,
    });
    enqueueWorkflowEventTrigger.mockResolvedValue(undefined);
  });

  it("dispatches once on the crossing and not again while it holds", async () => {
    const { store, saved } = makeArmStore();
    const { listener, sample } = makeListener(store);
    await listener.start();

    await sample(uint(50n), 100);
    await sample(uint(40n), 101);
    await sample(uint(45n), 102);

    expect(enqueueWorkflowEventTrigger).toHaveBeenCalledTimes(1);
    expect(dispatchKeys()).toEqual(["state:wf-1:1:sub-1:100"]);
    expect(saved.at(-1)).toEqual({
      phase: "FIRED",
      armGeneration: 100,
      lastFiredBlock: 100,
    });
  });

  it("resumes a FIRED episode across a restart without re-dispatching", async () => {
    // The crash-resume case: the process died mid-breach. A listener that
    // seeded a fresh generation would open a new episode and dispatch for a
    // condition that was already dispatched before the restart.
    const { store } = makeArmStore({
      phase: "FIRED",
      armGeneration: 100,
      lastFiredBlock: 100,
    });
    const { listener, sample } = makeListener(store);
    await listener.start();

    await sample(uint(40n), 500);
    await sample(uint(45n), 501);

    expect(enqueueWorkflowEventTrigger).not.toHaveBeenCalled();
    expect(listener.getArmState()).toEqual({
      phase: "FIRED",
      armGeneration: 100,
      lastFiredBlock: 100,
    });
  });

  it("resumes an ARMED episode at its stored generation, not at the resume block", async () => {
    const { store } = makeArmStore({
      phase: "ARMED",
      armGeneration: 90,
      lastFiredBlock: null,
    });
    const { listener, sample } = makeListener(store);
    await listener.start();

    await sample(uint(50n), 500);

    expect(dispatchKeys()).toEqual(["state:wf-1:1:sub-1:90"]);
  });

  it("skips the enqueue when the dispatch key already exists", async () => {
    // The durable guard: a redelivery under the same generation is refused by
    // the unique index behind createPhantomExecution, so nothing is enqueued.
    createPhantomExecution.mockResolvedValue({
      executionId: undefined,
      alreadyExisted: true,
    });
    const { store } = makeArmStore();
    const { listener, sample } = makeListener(store);
    await listener.start();

    await sample(uint(50n), 100);

    expect(createPhantomExecution).toHaveBeenCalledTimes(1);
    expect(enqueueWorkflowEventTrigger).not.toHaveBeenCalled();
  });

  it("skips a refused dispatch without enqueuing", async () => {
    createPhantomExecution.mockResolvedValue({
      executionId: undefined,
      alreadyExisted: false,
      refused: "plan_feature",
    });
    const { store } = makeArmStore();
    const { listener, sample } = makeListener(store);
    await listener.start();

    await sample(uint(50n), 100);

    expect(enqueueWorkflowEventTrigger).not.toHaveBeenCalled();
  });

  it("skips a sample that does not decode rather than reading it as a breach", async () => {
    const { store, saved } = makeArmStore();
    const { listener, sample } = makeListener(store);
    await listener.start();

    await sample({ success: false, returnData: "0x" }, 100);
    await sample({ success: true, returnData: "0x1234" }, 101);

    expect(enqueueWorkflowEventTrigger).not.toHaveBeenCalled();
    expect(saved).toEqual([]);
    expect(listener.getArmState()).toBeNull();
  });

  it("skips the sample when the arm-state store cannot be read", async () => {
    // A store failure must not be read as a cold start: re-seeding would open
    // a new generation and manufacture a duplicate out of an outage.
    const { store, loadError } = makeArmStore({
      phase: "FIRED",
      armGeneration: 100,
      lastFiredBlock: 100,
    });
    loadError.value = new Error("redis down");
    const { listener, sample } = makeListener(store);
    await listener.start();

    await sample(uint(50n), 500);
    expect(enqueueWorkflowEventTrigger).not.toHaveBeenCalled();

    // Once the store answers, the stored episode is resumed as normal.
    loadError.value = null;
    await sample(uint(50n), 501);
    expect(enqueueWorkflowEventTrigger).not.toHaveBeenCalled();
    expect(listener.getArmState()?.phase).toBe("FIRED");
  });

  it("advances to FIRED even when the enqueue fails", async () => {
    enqueueWorkflowEventTrigger.mockRejectedValue(new Error("sqs down"));
    const { store } = makeArmStore();
    const { listener, sample } = makeListener(store);
    await listener.start();

    await sample(uint(50n), 100);

    expect(failPhantomExecution).toHaveBeenCalledTimes(1);
    expect(listener.getArmState()?.phase).toBe("FIRED");

    // No second attempt on the next sample: retrying under the same
    // generation would be refused by the unique index anyway.
    enqueueWorkflowEventTrigger.mockResolvedValue(undefined);
    await sample(uint(50n), 101);
    expect(createPhantomExecution).toHaveBeenCalledTimes(1);
  });

  it("dispatches a second episode after the band is cleared", async () => {
    const { store } = makeArmStore();
    const { listener, sample } = makeListener(store);
    await listener.start();

    await sample(uint(50n), 100);
    await sample(uint(105n), 101); // inside the band, still FIRED
    await sample(uint(120n), 102); // clears it, re-arms at 102
    await sample(uint(50n), 103);

    expect(dispatchKeys()).toEqual([
      "state:wf-1:1:sub-1:100",
      "state:wf-1:1:sub-1:102",
    ]);
  });

  it("stops delivering after stop()", async () => {
    const { store } = makeArmStore();
    const { listener, unsubscribe } = makeListener(store);
    await listener.start();
    expect(listener.isStarted()).toBe(true);
    listener.stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(listener.isStarted()).toBe(false);
  });
});
