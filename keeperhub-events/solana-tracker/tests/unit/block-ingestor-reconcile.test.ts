import type { SQSClient } from "@aws-sdk/client-sqs";
import { describe, expect, it } from "vitest";
import type { DedupStore } from "../../src/dedup";
import { BlockIngestor } from "../../src/ingest/block-ingestor";
import type {
  ChainRegistration,
  SolanaBlockTrigger,
  SolanaEventTrigger,
} from "../../src/registrations";

const PROGRAM_A = "So11111111111111111111111111111111111111112";
const PROGRAM_B = "Vote111111111111111111111111111111111111111";

function eventTrigger(
  workflowId: string,
  programId: string,
  overrides: Partial<SolanaEventTrigger> = {},
): SolanaEventTrigger {
  return {
    workflowId,
    userId: "user-1",
    workflowName: workflowId,
    programId,
    configHash: `${workflowId}-${programId}`,
    ...overrides,
  };
}

function blockTrigger(workflowId: string): SolanaBlockTrigger {
  return {
    workflowId,
    userId: "user-1",
    workflowName: workflowId,
    blockInterval: 1,
    configHash: workflowId,
  };
}

function registration(
  overrides: Partial<ChainRegistration> = {},
): ChainRegistration {
  return {
    chainId: 101,
    rpcUrl: "https://rpc.example",
    wssUrl: "wss://ws.example",
    commitment: "confirmed",
    sourceMode: "signatures",
    eventTriggers: [eventTrigger("wf-1", PROGRAM_A)],
    blockTriggers: [],
    configHash: "base",
    ...overrides,
  };
}

function ingestorFor(reg: ChainRegistration): BlockIngestor {
  // Constructing does not open connections; start() is never called here.
  return new BlockIngestor({
    registration: reg,
    sqs: {} as SQSClient,
    sqsQueueUrl: "",
    dedup: {} as DedupStore,
  });
}

describe("BlockIngestor.canUpdateInPlace", () => {
  it("allows an in-place update when only trigger metadata changed", () => {
    const ingestor = ingestorFor(registration());
    const next = registration({
      eventTriggers: [
        eventTrigger("wf-1", PROGRAM_A, {
          eventName: "OFTSent",
          configHash: "changed",
        }),
      ],
      configHash: "next",
    });

    expect(ingestor.canUpdateInPlace(next)).toBe(true);
  });

  it("requires a restart when a new watched program appears", () => {
    // The running signatures source queries a program list frozen at start, so
    // absorbing this in place would leave the new program's workflow dead.
    const ingestor = ingestorFor(registration());
    const next = registration({
      eventTriggers: [
        eventTrigger("wf-1", PROGRAM_A),
        eventTrigger("wf-2", PROGRAM_B),
      ],
      configHash: "next",
    });

    expect(ingestor.canUpdateInPlace(next)).toBe(false);
  });

  it("requires a restart when a watched program disappears", () => {
    const ingestor = ingestorFor(
      registration({
        eventTriggers: [
          eventTrigger("wf-1", PROGRAM_A),
          eventTrigger("wf-2", PROGRAM_B),
        ],
      }),
    );

    expect(ingestor.canUpdateInPlace(registration())).toBe(false);
  });

  it("requires a restart when block triggers appear, so the composite is built", () => {
    const ingestor = ingestorFor(registration());
    const next = registration({
      blockTriggers: [blockTrigger("wf-block")],
      configHash: "next",
    });

    expect(ingestor.canUpdateInPlace(next)).toBe(false);
  });

  it("requires a restart when block triggers disappear", () => {
    const ingestor = ingestorFor(
      registration({ blockTriggers: [blockTrigger("wf-block")] }),
    );

    expect(ingestor.canUpdateInPlace(registration())).toBe(false);
  });

  it("still allows an in-place update when a second workflow watches a program already watched", () => {
    // Two triggers on one program are one program to watch, so the source's
    // inputs are unchanged and a restart would be pure downtime.
    const ingestor = ingestorFor(registration());
    const next = registration({
      eventTriggers: [
        eventTrigger("wf-1", PROGRAM_A),
        eventTrigger("wf-2", PROGRAM_A),
      ],
      configHash: "next",
    });

    expect(ingestor.canUpdateInPlace(next)).toBe(true);
  });

  it("requires a restart when endpoints or source mode change", () => {
    const ingestor = ingestorFor(registration());

    expect(
      ingestor.canUpdateInPlace(
        registration({ wssUrl: "wss://other.example", configHash: "next" }),
      ),
    ).toBe(false);
    expect(
      ingestor.canUpdateInPlace(
        registration({ sourceMode: "getblock", configHash: "next" }),
      ),
    ).toBe(false);
  });
});
