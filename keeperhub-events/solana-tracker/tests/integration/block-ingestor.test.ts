import type { SQSClient } from "@aws-sdk/client-sqs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DedupStore } from "../../src/dedup";
import { BlockIngestor } from "../../src/ingest/block-ingestor";
import type { NormalizedBlock, NormalizedTx } from "../../src/match/types";
import type { ChainRegistration } from "../../src/registrations";

const PROGRAM = "So11111111111111111111111111111111111111112";

// Captured onBlock + enqueue/phantom spies. Hoisted so the vi.mock factories
// (themselves hoisted above imports) can close over them.
const mocks = vi.hoisted(() => ({
  onBlock: null as ((block: unknown) => Promise<void>) | null,
  enqueueEvent: vi.fn(() => Promise.resolve()),
  enqueueBlock: vi.fn(() => Promise.resolve()),
  createPhantom: vi.fn(() => Promise.resolve({ executionId: "exec-1" })),
  failPhantom: vi.fn(() => Promise.resolve()),
}));

// Replace the ingestion source with a stub that captures the onBlock the
// ingestor wires in, so the test can drive a NormalizedBlock through the real
// matcher -> decode -> dedup -> enqueue path without any network.
vi.mock("@/src/ingest/source-factory", () => ({
  createBlockSource: (opts: { onBlock: (block: unknown) => Promise<void> }) => {
    mocks.onBlock = opts.onBlock;
    return {
      start: () => Promise.resolve(),
      stop: () => Promise.resolve(),
      getHealth: () => ({}),
    };
  },
}));

vi.mock("@/lib/phantom", () => ({
  createPhantomExecution: mocks.createPhantom,
  failPhantomExecution: mocks.failPhantom,
}));

vi.mock("@/lib/workflow-sqs", () => ({
  enqueueWorkflowEventTrigger: mocks.enqueueEvent,
  enqueueWorkflowBlockTrigger: mocks.enqueueBlock,
}));

function registration(): ChainRegistration {
  return {
    chainId: 101,
    rpcUrl: "https://rpc",
    wssUrl: "wss://ws",
    commitment: "confirmed",
    eventTriggers: [
      {
        workflowId: "wf-event",
        userId: "user-1",
        workflowName: "event",
        programId: PROGRAM,
        configHash: "h",
      },
    ],
    blockTriggers: [
      {
        workflowId: "wf-block",
        userId: "user-1",
        workflowName: "block",
        blockInterval: 5,
        configHash: "h",
      },
    ],
    configHash: "chain-hash",
  };
}

function block(tx: Partial<NormalizedTx> = {}): NormalizedBlock {
  return {
    slot: 100,
    blockHeight: 10, // divisible by the block trigger's interval (5)
    blockhash: "hash",
    blockTime: 1_700_000_000,
    parentSlot: 99,
    transactions: [
      {
        signature: "sig-1",
        programIds: [PROGRAM],
        logMessages: ["Program log: hi"],
        failed: false,
        ...tx,
      },
    ],
  };
}

function fakeDedup(isProcessed: boolean): DedupStore {
  return {
    isProcessed: vi.fn(() => Promise.resolve(isProcessed)),
    markProcessed: vi.fn(() => Promise.resolve()),
  } as unknown as DedupStore;
}

/**
 * Key-aware dedup backed by a Set of `${workflowId}:${key}` entries, so a test
 * can distinguish the event key (a tx signature) from the block key
 * (`block:<height>`). `initial` pre-marks entries as already processed.
 */
function statefulDedup(initial: string[] = []): DedupStore {
  const seen = new Set(initial);
  return {
    isProcessed: (wf: string, key: string) =>
      Promise.resolve(seen.has(`${wf}:${key}`)),
    markProcessed: (wf: string, key: string) => {
      seen.add(`${wf}:${key}`);
      return Promise.resolve();
    },
  } as unknown as DedupStore;
}

async function startIngestor(dedup: DedupStore): Promise<void> {
  const ingestor = new BlockIngestor({
    registration: registration(),
    sqs: undefined as unknown as SQSClient,
    sqsQueueUrl: "queue-url",
    dedup,
  });
  await ingestor.start();
}

beforeEach(() => {
  mocks.onBlock = null;
  vi.clearAllMocks();
  // clearAllMocks keeps implementations, so restore the admitted default for
  // every test that does not override it.
  mocks.createPhantom.mockResolvedValue({ executionId: "exec-1" });
});

describe("BlockIngestor end-to-end fan-out", () => {
  it("enqueues one event and one block message for a matching block", async () => {
    const dedup = fakeDedup(false);
    await startIngestor(dedup);
    expect(mocks.onBlock).toBeTypeOf("function");

    await mocks.onBlock?.(block());

    expect(mocks.enqueueEvent).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueBlock).toHaveBeenCalledTimes(1);
    expect(dedup.markProcessed).toHaveBeenCalledWith("wf-event", "sig-1");

    // The phantom for each fire carries its dispatch key: the tx signature for
    // an event (the matcher fires once per tx), the slot for a block.
    expect(mocks.createPhantom).toHaveBeenCalledWith(
      "wf-event",
      "user-1",
      "event",
      "events",
      "event:wf-event:101:sig-1",
    );
    expect(mocks.createPhantom).toHaveBeenCalledWith(
      "wf-block",
      "user-1",
      "block",
      "scheduler",
      "block:wf-block:101:100",
    );

    const eventArg = mocks.enqueueEvent.mock.calls[0][2] as {
      workflowId: string;
      triggerData: { chainType: string; programId: string };
    };
    expect(eventArg.workflowId).toBe("wf-event");
    expect(eventArg.triggerData.chainType).toBe("solana");
    expect(eventArg.triggerData.programId).toBe(PROGRAM);
  });

  it("skips both enqueues when the dispatch is refused on plan grounds", async () => {
    mocks.createPhantom.mockResolvedValue({ refused: "execution_limit" });
    const dedup = fakeDedup(false);
    await startIngestor(dedup);

    await mocks.onBlock?.(block());

    expect(mocks.enqueueEvent).not.toHaveBeenCalled();
    expect(mocks.enqueueBlock).not.toHaveBeenCalled();
    // A refusal is settled, so it is marked: re-processing the block would
    // otherwise pay for the admission round-trip again and reach the same
    // answer.
    expect(dedup.markProcessed).toHaveBeenCalledWith("wf-event", "sig-1");
    expect(dedup.markProcessed).toHaveBeenCalledWith("wf-block", "block:10");
  });

  // A re-processed block whose Redis dedup entries were missed collides on the
  // dispatch keys: both rows were already enqueued once and must not be again.
  it("skips both enqueues when the dispatch keys already exist, and marks them settled", async () => {
    mocks.createPhantom.mockResolvedValue({
      executionId: "exec-existing",
      alreadyExisted: true,
    });
    const dedup = fakeDedup(false);
    await startIngestor(dedup);

    await mocks.onBlock?.(block());

    expect(mocks.enqueueEvent).not.toHaveBeenCalled();
    expect(mocks.enqueueBlock).not.toHaveBeenCalled();
    expect(mocks.failPhantom).not.toHaveBeenCalled();
    expect(dedup.markProcessed).toHaveBeenCalledWith("wf-event", "sig-1");
    expect(dedup.markProcessed).toHaveBeenCalledWith("wf-block", "block:10");
  });

  it("skips the event enqueue when its signature is already processed", async () => {
    // Only the event's signature is pre-marked; the block key is not.
    const dedup = statefulDedup(["wf-event:sig-1"]);
    await startIngestor(dedup);

    await mocks.onBlock?.(block());

    expect(mocks.enqueueEvent).not.toHaveBeenCalled();
    // The block key ("block:10") is independent, so the block still fires.
    expect(mocks.enqueueBlock).toHaveBeenCalledTimes(1);
  });

  it("does not re-enqueue a block trigger for a block already processed", async () => {
    const dedup = statefulDedup();
    await startIngestor(dedup);

    await mocks.onBlock?.(block());
    await mocks.onBlock?.(block()); // same block height (10) again

    // Both the event (by signature) and the block (by height) fire once.
    expect(mocks.enqueueEvent).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueBlock).toHaveBeenCalledTimes(1);
  });

  it("does not enqueue an event for a failed transaction, but still fires the block", async () => {
    const dedup = fakeDedup(false);
    await startIngestor(dedup);

    await mocks.onBlock?.(block({ failed: true }));

    expect(mocks.enqueueEvent).not.toHaveBeenCalled();
    expect(mocks.enqueueBlock).toHaveBeenCalledTimes(1);
  });
});
