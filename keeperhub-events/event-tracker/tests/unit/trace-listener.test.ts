import type { SQSClient } from "@aws-sdk/client-sqs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChainProviderManager,
  SubscribeTraceOptions,
  TraceCallFrame,
  Unsubscribe,
} from "../../src/chains/provider-manager";
import { TraceListener } from "../../src/listener/trace-listener";
import type { TraceSubscription } from "../../src/listener/trace-subscription";

/**
 * Dispatch shape of the trace trigger (issue #2464).
 *
 * The matcher's frame and the workflow payload are two different contracts.
 * `callTracer` answers in hex quantities; the trigger's output fields
 * document `value` as wei in a decimal string, and `minValueWei` is
 * configured in decimal. The conversion happens at this boundary.
 */

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

const WORKFLOW_ID = "wf-1";
const WATCHED = "0x1111111111111111111111111111111111111111";
const CALLER = "0x2222222222222222222222222222222222222222";

const SUBSCRIPTION: TraceSubscription = {
  contractAddress: WATCHED,
};

function makeFrame(overrides: Partial<TraceCallFrame> = {}): TraceCallFrame {
  return {
    blockNumber: 1000,
    transactionHash: "0xabc",
    transactionIndex: 0,
    frameIndex: 0,
    callType: "CALL",
    from: CALLER,
    to: WATCHED,
    value: "0x0",
    selector: "0x8456cb59",
    input: "0x8456cb59",
    depth: 0,
    reverted: false,
    ...overrides,
  };
}

/** Capture the handler the listener registers, so frames can be fed to it. */
function makeManager(): {
  manager: ChainProviderManager;
  handler: () => (matches: TraceCallFrame[]) => Promise<void>;
} {
  let captured: ((matches: TraceCallFrame[]) => Promise<void>) | null = null;
  const manager = {
    subscribeToTrace: async (
      opts: SubscribeTraceOptions,
    ): Promise<Unsubscribe> => {
      captured = opts.handler;
      return () => undefined;
    },
  } as unknown as ChainProviderManager;
  return {
    manager,
    handler: () => {
      if (!captured) {
        throw new Error("listener never subscribed");
      }
      return captured;
    },
  };
}

async function dispatch(
  frame: TraceCallFrame,
): Promise<Record<string, unknown>> {
  const { manager, handler } = makeManager();
  const listener = new TraceListener({
    workflowId: WORKFLOW_ID,
    userId: "user-1",
    workflowName: "Pause watcher",
    chainId: 1,
    wssUrl: "ws://localhost:8546",
    subscription: SUBSCRIPTION,
    sqs: {} as SQSClient,
    sqsQueueUrl: "https://sqs.test/queue",
    providerManager: manager,
  });
  await listener.start();
  await handler()([frame]);
  const [, , message] = enqueueWorkflowEventTrigger.mock.calls.at(-1) ?? [];
  return (message as { triggerData: Record<string, unknown> }).triggerData;
}

describe("TraceListener dispatch payload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createPhantomExecution.mockResolvedValue({
      executionId: "exec-1",
      alreadyExisted: false,
      refused: null,
    });
    enqueueWorkflowEventTrigger.mockResolvedValue(undefined);
  });

  it("sends value as a decimal wei string, not the tracer's hex", async () => {
    // 0.1 ETH. The editor documents `value` as "in wei (decimal string)", so
    // {{Trigger.value}} rendering 0x16345785d8a0000 against a contract that
    // promises decimal is a broken template for every downstream step that
    // does arithmetic on it.
    const data = await dispatch(makeFrame({ value: "0x16345785d8a0000" }));
    expect(data.value).toBe("100000000000000000");
  });

  it("sends zero as 0, not 0x0", async () => {
    const data = await dispatch(makeFrame({ value: "0x0" }));
    expect(data.value).toBe("0");
  });

  it("leaves a value the tracer already sent in decimal alone", async () => {
    // Not every upstream is geth. A decimal string round-trips unchanged
    // rather than being mangled into a second base.
    const data = await dispatch(makeFrame({ value: "42" }));
    expect(data.value).toBe("42");
  });

  it("falls back to 0 for a value it cannot parse", async () => {
    // Better than propagating a string no downstream step can parse. The
    // frame still dispatches, because the value is one field of many and the
    // match itself was real.
    const data = await dispatch(makeFrame({ value: "not-a-number" }));
    expect(data.value).toBe("0");
  });

  it("carries the rest of the frame through unchanged", async () => {
    const data = await dispatch(
      makeFrame({ callType: "DELEGATECALL", reverted: true, depth: 2 }),
    );
    expect(data).toMatchObject({
      triggerType: "Trace",
      chainId: 1,
      blockNumber: 1000,
      transactionHash: "0xabc",
      transactionIndex: 0,
      frameIndex: 0,
      callType: "DELEGATECALL",
      from: CALLER,
      to: WATCHED,
      selector: "0x8456cb59",
      depth: 2,
      reverted: true,
    });
  });
});
