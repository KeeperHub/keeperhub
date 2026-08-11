import { describe, expect, it } from "vitest";
import type {
  AnchorEventDecoder,
  DecodedAnchorEvent,
} from "../../src/decode/solana-idl";
import { matchEvents } from "../../src/match/event-matcher";
import type { NormalizedBlock, NormalizedTx } from "../../src/match/types";
import type { SolanaEventTrigger } from "../../src/registrations";

const PROGRAM = "So11111111111111111111111111111111111111112";
const OTHER_PROGRAM = "Vote111111111111111111111111111111111111111";

function tx(overrides: Partial<NormalizedTx> = {}): NormalizedTx {
  return {
    signature: "sig-1",
    programIds: [PROGRAM],
    logMessages: [],
    failed: false,
    ...overrides,
  };
}

function block(transactions: NormalizedTx[]): NormalizedBlock {
  return {
    slot: 100,
    blockHeight: 90,
    blockhash: "hash",
    blockTime: 1_700_000_000,
    parentSlot: 99,
    transactions,
  };
}

function trigger(
  overrides: Partial<SolanaEventTrigger> = {},
): SolanaEventTrigger {
  return {
    workflowId: "wf-1",
    userId: "user-1",
    workflowName: "wf",
    programId: PROGRAM,
    configHash: "hash",
    ...overrides,
  };
}

/** Duck-typed decoder so the matcher's typed path can run without a real IDL. */
function fakeDecoder(events: DecodedAnchorEvent[]): AnchorEventDecoder {
  return { decodeLogs: () => events } as unknown as AnchorEventDecoder;
}

describe("matchEvents", () => {
  it("returns nothing when there are no triggers", () => {
    expect(matchEvents(block([tx()]), [], new Map(), "confirmed")).toEqual([]);
  });

  it("fires (raw mode) when a tx invokes a watched program", () => {
    const fires = matchEvents(
      block([tx({ signature: "sig-A" })]),
      [trigger()],
      new Map(),
      "confirmed",
    );
    expect(fires).toHaveLength(1);
    expect(fires[0].workflowId).toBe("wf-1");
    expect(fires[0].signature).toBe("sig-A");
    expect(fires[0].payload.programId).toBe(PROGRAM);
    expect(fires[0].payload.chainType).toBe("solana");
  });

  it("does not fire when the watched program is absent", () => {
    const fires = matchEvents(
      block([tx({ programIds: [OTHER_PROGRAM] })]),
      [trigger()],
      new Map(),
      "confirmed",
    );
    expect(fires).toEqual([]);
  });

  it("skips failed transactions", () => {
    const fires = matchEvents(
      block([tx({ failed: true })]),
      [trigger()],
      new Map(),
      "confirmed",
    );
    expect(fires).toEqual([]);
  });

  it("fires at most once per (workflow, tx) even with duplicate triggers", () => {
    const fires = matchEvents(
      block([tx()]),
      [trigger(), trigger()],
      new Map(),
      "confirmed",
    );
    expect(fires).toHaveLength(1);
  });

  it("fires separately for two workflows watching the same program", () => {
    const fires = matchEvents(
      block([tx()]),
      [trigger({ workflowId: "wf-1" }), trigger({ workflowId: "wf-2" })],
      new Map(),
      "confirmed",
    );
    expect(fires.map((f) => f.workflowId).sort()).toEqual(["wf-1", "wf-2"]);
  });

  it("typed mode fires only when the named event is present and attaches it", () => {
    const decoders = new Map<string, AnchorEventDecoder | null>([
      ["wf-1", fakeDecoder([{ name: "Deposited", data: { amount: 5n } }])],
    ]);
    const fires = matchEvents(
      block([tx()]),
      [trigger({ eventName: "Deposited", idl: "{}" })],
      decoders,
      "confirmed",
    );
    expect(fires).toHaveLength(1);
    expect(fires[0].payload.eventName).toBe("Deposited");
    expect(fires[0].payload.events?.[0].name).toBe("Deposited");
  });

  it("typed mode does not fire when the named event is absent", () => {
    const decoders = new Map<string, AnchorEventDecoder | null>([
      ["wf-1", fakeDecoder([{ name: "Withdrawn", data: {} }])],
    ]);
    const fires = matchEvents(
      block([tx()]),
      [trigger({ eventName: "Deposited", idl: "{}" })],
      decoders,
      "confirmed",
    );
    expect(fires).toEqual([]);
  });
});
