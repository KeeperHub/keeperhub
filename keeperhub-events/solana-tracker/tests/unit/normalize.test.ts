import type { VersionedBlockResponse } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  normalizeBlock,
  parseInvokedPrograms,
} from "../../src/ingest/normalize";

const PROGRAM_A = "So11111111111111111111111111111111111111112";
const PROGRAM_B = "Vote111111111111111111111111111111111111111";

describe("parseInvokedPrograms", () => {
  it("extracts invoked programs from `Program <id> invoke [depth]` lines", () => {
    const programs = parseInvokedPrograms([
      `Program ${PROGRAM_A} invoke [1]`,
      "Program log: hello",
      `Program ${PROGRAM_B} invoke [2]`,
      `Program ${PROGRAM_B} success`,
    ]);
    expect(programs.sort()).toEqual([PROGRAM_A, PROGRAM_B].sort());
  });

  it("de-duplicates repeated invocations of the same program", () => {
    const programs = parseInvokedPrograms([
      `Program ${PROGRAM_A} invoke [1]`,
      `Program ${PROGRAM_A} invoke [2]`,
    ]);
    expect(programs).toEqual([PROGRAM_A]);
  });

  it("returns nothing when there are no invoke lines", () => {
    expect(
      parseInvokedPrograms(["Program log: noise", "some other line"]),
    ).toEqual([]);
  });
});

interface FakeTx {
  transaction: { signatures: string[] };
  meta: { logMessages: string[] | null; err: unknown } | null;
}

function fakeBlock(
  overrides: Partial<{
    transactions: FakeTx[] | undefined;
    blockHeight: number | null | undefined;
  }>,
): VersionedBlockResponse {
  return {
    blockhash: "hash",
    blockTime: 1_700_000_000,
    parentSlot: 249,
    previousBlockhash: "prev",
    transactions: overrides.transactions,
    ...(overrides.blockHeight === undefined
      ? {}
      : { blockHeight: overrides.blockHeight }),
  } as unknown as VersionedBlockResponse;
}

describe("normalizeBlock", () => {
  it("flattens transactions, parsing programIds and the failed flag", () => {
    const normalized = normalizeBlock(
      250,
      fakeBlock({
        blockHeight: 240,
        transactions: [
          {
            transaction: { signatures: ["sig-ok"] },
            meta: {
              logMessages: [`Program ${PROGRAM_A} invoke [1]`],
              err: null,
            },
          },
          {
            transaction: { signatures: ["sig-fail"] },
            meta: { logMessages: [], err: { InstructionError: [] } },
          },
        ],
      }),
    );
    expect(normalized.slot).toBe(250);
    expect(normalized.blockHeight).toBe(240);
    expect(normalized.transactions).toHaveLength(2);
    expect(normalized.transactions[0].signature).toBe("sig-ok");
    expect(normalized.transactions[0].programIds).toEqual([PROGRAM_A]);
    expect(normalized.transactions[0].failed).toBe(false);
    expect(normalized.transactions[1].failed).toBe(true);
  });

  it("degrades to an empty tx list when transactionDetails is 'none'", () => {
    const normalized = normalizeBlock(
      250,
      fakeBlock({ blockHeight: 240, transactions: undefined }),
    );
    expect(normalized.transactions).toEqual([]);
    expect(normalized.blockHeight).toBe(240);
  });

  it("reads blockHeight defensively as null when the RPC omits it", () => {
    const normalized = normalizeBlock(
      250,
      fakeBlock({ blockHeight: undefined, transactions: [] }),
    );
    expect(normalized.blockHeight).toBeNull();
  });
});
