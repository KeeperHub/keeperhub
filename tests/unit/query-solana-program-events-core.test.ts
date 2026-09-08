import { BN, BorshCoder, type Idl } from "@coral-xyz/anchor";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockDbSelect = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  workflowExecutions: { id: "id", userId: "userId" },
}));

vi.mock("drizzle-orm", () => ({
  eq: () => ({}),
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { VALIDATION: "validation" },
  logUserError: vi.fn(),
}));

const mockGetChainIdFromNetwork = vi.fn();
vi.mock("@/lib/rpc/network-utils", () => ({
  getChainIdFromNetwork: (...args: unknown[]) =>
    mockGetChainIdFromNetwork(...args),
}));

const mockGetSignaturesForAddress = vi.fn();
const mockGetTransaction = vi.fn();
const fakeConnection = {
  getSignaturesForAddress: (...args: unknown[]) =>
    mockGetSignaturesForAddress(...args),
  getTransaction: (...args: unknown[]) => mockGetTransaction(...args),
};
const mockExecuteWithFailover = vi.fn((operation: (c: unknown) => unknown) =>
  Promise.resolve(operation(fakeConnection))
);
const mockGetSolanaProvider = vi.fn();
vi.mock("@/lib/rpc/provider-factory", () => ({
  getSolanaProvider: (...args: unknown[]) => mockGetSolanaProvider(...args),
}));

import {
  DEFAULT_SIGNATURE_LOOKBACK,
  MAX_SIGNATURE_PAGES,
  MAX_SIGNATURES_PER_PAGE,
  NULL_TX_RETRY_ATTEMPTS,
  queryProgramEventsCore,
} from "@/plugins/web3/steps/query-solana-program-events-core";

const PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const OTHER_PROGRAM_ID = "So11111111111111111111111111111111111111112";

const DEPOSITED_DISCRIMINATOR = [11, 22, 33, 44, 55, 66, 77, 88];
const WITHDRAWN_DISCRIMINATOR = [1, 2, 3, 4, 5, 6, 7, 8];
const IDL: Idl = {
  address: "11111111111111111111111111111111",
  metadata: { name: "test_program", version: "0.1.0", spec: "0.1.0" },
  instructions: [],
  accounts: [],
  events: [
    { name: "Deposited", discriminator: DEPOSITED_DISCRIMINATOR },
    { name: "Withdrawn", discriminator: WITHDRAWN_DISCRIMINATOR },
  ],
  types: [
    {
      name: "Deposited",
      type: { kind: "struct", fields: [{ name: "amount", type: "u64" }] },
    },
    {
      name: "Withdrawn",
      type: { kind: "struct", fields: [{ name: "amount", type: "u64" }] },
    },
  ],
};

function anchorEventLog(amount: number, prefix = "Program data: "): string {
  const coder = new BorshCoder(IDL);
  const encoded = coder.types.encode("Deposited", { amount: new BN(amount) });
  const blob = Buffer.concat([Buffer.from(DEPOSITED_DISCRIMINATOR), encoded]);
  return `${prefix}${blob.toString("base64")}`;
}

function withdrawnEventLog(amount: number): string {
  const coder = new BorshCoder(IDL);
  const encoded = coder.types.encode("Withdrawn", { amount: new BN(amount) });
  const blob = Buffer.concat([Buffer.from(WITHDRAWN_DISCRIMINATOR), encoded]);
  return `Program data: ${blob.toString("base64")}`;
}

function wrapProgramLogs(programId: string, innerLogs: string[]): string[] {
  return [
    `Program ${programId} invoke [1]`,
    ...innerLogs,
    `Program ${programId} success`,
  ];
}

function sigInfo(
  signature: string,
  slot: number,
  overrides: Partial<{ err: unknown }> = {}
): {
  signature: string;
  slot: number;
  err: unknown;
  memo: null;
  blockTime: number;
  confirmationStatus: string;
} {
  return {
    signature,
    slot,
    err: overrides.err ?? null,
    memo: null,
    blockTime: 1_700_000_000,
    confirmationStatus: "finalized",
  };
}

describe("queryProgramEventsCore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetChainIdFromNetwork.mockReturnValue(101);
    mockGetSolanaProvider.mockResolvedValue({
      executeWithFailover: mockExecuteWithFailover,
    });
    mockDbSelect.mockReturnValue({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([]) }),
      }),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects an invalid program id before making any RPC call", async () => {
    const result = await queryProgramEventsCore({
      network: "solana",
      programId: "not-a-valid-pubkey",
    });

    expect(result.success).toBe(false);
    expect(mockGetSignaturesForAddress).not.toHaveBeenCalled();
  });

  it("rejects an eventName filter when no valid IDL is supplied", async () => {
    const result = await queryProgramEventsCore({
      network: "solana",
      programId: PROGRAM_ID,
      eventName: "Deposited",
    });

    expect(result.success).toBe(false);
    expect(mockGetSignaturesForAddress).not.toHaveBeenCalled();
  });

  it("falls back to raw mode when the IDL has no events array", async () => {
    const idlWithoutEvents = { ...IDL, events: undefined };
    mockGetSignaturesForAddress.mockResolvedValueOnce([sigInfo("sig-1", 5)]);
    mockGetTransaction.mockResolvedValue({
      meta: {
        logMessages: wrapProgramLogs(PROGRAM_ID, ["Program log: something"]),
      },
    });

    const result = await queryProgramEventsCore({
      network: "solana",
      programId: PROGRAM_ID,
      idl: JSON.stringify(idlWithoutEvents),
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.events).toEqual([
      {
        signature: "sig-1",
        slot: 5,
        blockTime: 1_700_000_000,
        raw: wrapProgramLogs(PROGRAM_ID, ["Program log: something"]),
      },
    ]);
  });

  it("returns an empty result when the program has no signatures", async () => {
    mockGetSignaturesForAddress.mockResolvedValue([]);

    const result = await queryProgramEventsCore({
      network: "solana",
      programId: PROGRAM_ID,
    });

    expect(result).toEqual({
      success: true,
      events: [],
      oldestSignature: null,
      newestSignature: null,
      signatureCount: 0,
      eventCount: 0,
      truncated: false,
      nextBeforeSignature: null,
      failedSignatureCount: 0,
      otherEventNamesSeen: [],
    });
  });

  it("decodes matching events against the provided Anchor IDL, normalizing u64 amounts to decimal strings", async () => {
    mockGetSignaturesForAddress.mockResolvedValueOnce([
      sigInfo("sig-newest", 20),
      sigInfo("sig-oldest", 10),
    ]);
    mockGetTransaction.mockImplementation((signature: string) =>
      Promise.resolve({
        meta: {
          logMessages: wrapProgramLogs(PROGRAM_ID, [
            "Program log: instruction: deposit",
            anchorEventLog(signature === "sig-newest" ? 2 : 1),
          ]),
        },
      })
    );

    const result = await queryProgramEventsCore({
      network: "solana",
      programId: PROGRAM_ID,
      idl: JSON.stringify(IDL),
      eventName: "Deposited",
    });

    expect(result.success).toBe(true);
    if (!(result.success && result.events)) {
      return;
    }
    expect(result.events).toHaveLength(2);
    // Oldest-first ordering in the output, matching on-chain order.
    expect(result.events[0].signature).toBe("sig-oldest");
    expect(result.events[0].eventName).toBe("Deposited");
    expect(result.events[0].args?.amount).toBe("1");
    // Must survive a JSON round-trip as a decimal string, not bn.js's hex toJSON.
    expect(JSON.parse(JSON.stringify(result.events[0].args)).amount).toBe("1");
    expect(result.events[1].signature).toBe("sig-newest");
    expect(result.oldestSignature).toBe("sig-oldest");
    expect(result.newestSignature).toBe("sig-newest");
    expect(result.truncated).toBe(false);
    expect(result.otherEventNamesSeen).toEqual([]);
  });

  it("decodes an event logged via the bare 'Program log:' prefix, not just 'Program data:'", async () => {
    mockGetSignaturesForAddress.mockResolvedValueOnce([sigInfo("sig-1", 5)]);
    mockGetTransaction.mockResolvedValue({
      meta: {
        logMessages: wrapProgramLogs(PROGRAM_ID, [
          anchorEventLog(4, "Program log: "),
        ]),
      },
    });

    const result = await queryProgramEventsCore({
      network: "solana",
      programId: PROGRAM_ID,
      idl: JSON.stringify(IDL),
    });

    expect(result.success).toBe(true);
    if (!(result.success && result.events)) {
      return;
    }
    expect(result.events).toHaveLength(1);
    expect(result.events[0].args?.amount).toBe("4");
  });

  it("does not attribute an event logged by a CPI'd program to the queried program", async () => {
    mockGetSignaturesForAddress.mockResolvedValueOnce([sigInfo("sig-1", 5)]);
    mockGetTransaction.mockResolvedValue({
      meta: {
        logMessages: [
          `Program ${PROGRAM_ID} invoke [1]`,
          "Program log: outer program running",
          `Program ${OTHER_PROGRAM_ID} invoke [2]`,
          // Structurally decodable against our IDL, but logged while
          // OTHER_PROGRAM_ID is the executing program - must be excluded.
          anchorEventLog(999),
          `Program ${OTHER_PROGRAM_ID} success`,
          // The queried program's own, genuine event.
          anchorEventLog(1),
          `Program ${PROGRAM_ID} success`,
        ],
      },
    });

    const result = await queryProgramEventsCore({
      network: "solana",
      programId: PROGRAM_ID,
      idl: JSON.stringify(IDL),
    });

    expect(result.success).toBe(true);
    if (!(result.success && result.events)) {
      return;
    }
    expect(result.events).toHaveLength(1);
    expect(result.events[0].args?.amount).toBe("1");
  });

  it("reports otherEventNamesSeen when eventName filters out a different decoded event", async () => {
    mockGetSignaturesForAddress.mockResolvedValueOnce([sigInfo("sig-1", 5)]);
    mockGetTransaction.mockResolvedValue({
      meta: {
        logMessages: wrapProgramLogs(PROGRAM_ID, [withdrawnEventLog(5)]),
      },
    });

    const result = await queryProgramEventsCore({
      network: "solana",
      programId: PROGRAM_ID,
      idl: JSON.stringify(IDL),
      eventName: "Deposited",
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.events).toEqual([]);
    expect(result.otherEventNamesSeen).toEqual(["Withdrawn"]);
  });

  it("returns raw log lines when no IDL is supplied", async () => {
    mockGetSignaturesForAddress.mockResolvedValueOnce([sigInfo("sig-1", 5)]);
    mockGetTransaction.mockResolvedValue({
      meta: { logMessages: ["Program log: raw entry"] },
    });

    const result = await queryProgramEventsCore({
      network: "solana",
      programId: PROGRAM_ID,
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.events).toEqual([
      {
        signature: "sig-1",
        slot: 5,
        blockTime: 1_700_000_000,
        raw: ["Program log: raw entry"],
      },
    ]);
  });

  it("skips failed transactions without fetching them", async () => {
    mockGetSignaturesForAddress.mockResolvedValueOnce([
      sigInfo("sig-failed", 5, { err: { InstructionError: [0, "Custom"] } }),
    ]);

    const result = await queryProgramEventsCore({
      network: "solana",
      programId: PROGRAM_ID,
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.events).toEqual([]);
    expect(mockGetTransaction).not.toHaveBeenCalled();
  });

  it("retries a null getTransaction response and reports it as failed if it never resolves", async () => {
    vi.useFakeTimers();
    mockGetSignaturesForAddress.mockResolvedValueOnce([sigInfo("sig-1", 5)]);
    mockGetTransaction.mockResolvedValue(null);

    const promise = queryProgramEventsCore({
      network: "solana",
      programId: PROGRAM_ID,
    });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.events).toEqual([]);
    expect(result.failedSignatureCount).toBe(1);
    expect(mockGetTransaction).toHaveBeenCalledTimes(NULL_TX_RETRY_ATTEMPTS);
  });

  it("resolves a signature whose transaction is null on the first attempt but appears on retry", async () => {
    vi.useFakeTimers();
    mockGetSignaturesForAddress.mockResolvedValueOnce([sigInfo("sig-1", 5)]);
    mockGetTransaction
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ meta: { logMessages: ["Program log: ok"] } });

    const promise = queryProgramEventsCore({
      network: "solana",
      programId: PROGRAM_ID,
    });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.failedSignatureCount).toBe(0);
    expect(result.events).toEqual([
      {
        signature: "sig-1",
        slot: 5,
        blockTime: 1_700_000_000,
        raw: ["Program log: ok"],
      },
    ]);
  });

  it("preserves already-collected signatures and marks truncated when a later page fails", async () => {
    const page1 = Array.from({ length: MAX_SIGNATURES_PER_PAGE }, (_, i) =>
      sigInfo(`sig-${i}`, i)
    );
    mockGetSignaturesForAddress
      .mockResolvedValueOnce(page1)
      .mockRejectedValueOnce(new Error("RPC unavailable"));
    mockGetTransaction.mockResolvedValue({ meta: { logMessages: [] } });

    const result = await queryProgramEventsCore({
      network: "solana",
      programId: PROGRAM_ID,
      signatureLookback: MAX_SIGNATURES_PER_PAGE * 2,
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.signatureCount).toBe(MAX_SIGNATURES_PER_PAGE);
    expect(result.truncated).toBe(true);
    expect(result.nextBeforeSignature).toBe("sig-999");
  });

  it("surfaces a hard error when the very first signature page fails (nothing to salvage)", async () => {
    mockGetSignaturesForAddress.mockRejectedValueOnce(
      new Error("RPC unavailable")
    );

    const result = await queryProgramEventsCore({
      network: "solana",
      programId: PROGRAM_ID,
    });

    expect(result.success).toBe(false);
  });

  it("does not fail the query when the userId lookup throws", async () => {
    mockDbSelect.mockImplementation(() => {
      throw new Error("connection pool exhausted");
    });
    mockGetSignaturesForAddress.mockResolvedValueOnce([]);

    const result = await queryProgramEventsCore({
      network: "solana",
      programId: PROGRAM_ID,
      _context: { executionId: "exec-1" },
    });

    expect(result.success).toBe(true);
  });

  it("marks the result truncated and returns a resume cursor when the page cap is hit", async () => {
    const fullPage = Array.from({ length: MAX_SIGNATURES_PER_PAGE }, (_, i) =>
      sigInfo(`sig-${i}`, i)
    );
    mockGetSignaturesForAddress.mockResolvedValue(fullPage);
    mockGetTransaction.mockResolvedValue({ meta: { logMessages: [] } });

    const result = await queryProgramEventsCore({
      network: "solana",
      programId: PROGRAM_ID,
      signatureLookback: MAX_SIGNATURES_PER_PAGE * MAX_SIGNATURE_PAGES,
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(mockGetSignaturesForAddress).toHaveBeenCalledTimes(
      MAX_SIGNATURE_PAGES
    );
    expect(result.truncated).toBe(true);
    // Independently-known values (page 1's last entry, the only distinct
    // signature the naive mock ever returns), not each other - a cursor bug
    // that broke both fields identically would otherwise go undetected.
    expect(result.oldestSignature).toBe("sig-999");
    expect(result.nextBeforeSignature).toBe("sig-999");
  });

  it("rejects an invalid signatureLookback value", async () => {
    const result = await queryProgramEventsCore({
      network: "solana",
      programId: PROGRAM_ID,
      signatureLookback: "not-a-number",
    });

    expect(result.success).toBe(false);
    expect(mockGetSignaturesForAddress).not.toHaveBeenCalled();
  });

  it("rejects a scientific-notation signatureLookback instead of silently truncating it", async () => {
    const result = await queryProgramEventsCore({
      network: "solana",
      programId: PROGRAM_ID,
      signatureLookback: "1e5",
    });

    expect(result.success).toBe(false);
    expect(mockGetSignaturesForAddress).not.toHaveBeenCalled();
  });

  it("rejects a zero string signatureLookback instead of silently scanning nothing", async () => {
    const result = await queryProgramEventsCore({
      network: "solana",
      programId: PROGRAM_ID,
      signatureLookback: "0",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Invalid signatureLookback value");
    }
    expect(mockGetSignaturesForAddress).not.toHaveBeenCalled();
  });

  it("rejects a non-string, non-number signatureLookback instead of throwing", async () => {
    const result = await queryProgramEventsCore({
      network: "solana",
      programId: PROGRAM_ID,
      signatureLookback: true as unknown as number,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Invalid signatureLookback value");
    }
    expect(mockGetSignaturesForAddress).not.toHaveBeenCalled();
  });

  it("rejects a non-integer numeric signatureLookback", async () => {
    const result = await queryProgramEventsCore({
      network: "solana",
      programId: PROGRAM_ID,
      signatureLookback: 2.5,
    });

    expect(result.success).toBe(false);
    expect(mockGetSignaturesForAddress).not.toHaveBeenCalled();
  });

  it("rejects a malformed beforeSignature before making any RPC call", async () => {
    const result = await queryProgramEventsCore({
      network: "solana",
      programId: PROGRAM_ID,
      beforeSignature: "not-a-real-signature!!",
    });

    expect(result.success).toBe(false);
    expect(mockGetSignaturesForAddress).not.toHaveBeenCalled();
  });

  it("rejects a malformed untilSignature before making any RPC call", async () => {
    const result = await queryProgramEventsCore({
      network: "solana",
      programId: PROGRAM_ID,
      untilSignature: "short",
    });

    expect(result.success).toBe(false);
    expect(mockGetSignaturesForAddress).not.toHaveBeenCalled();
  });

  it("defaults signatureLookback when unset", async () => {
    mockGetSignaturesForAddress.mockResolvedValueOnce([]);

    await queryProgramEventsCore({
      network: "solana",
      programId: PROGRAM_ID,
    });

    expect(mockGetSignaturesForAddress).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ limit: DEFAULT_SIGNATURE_LOOKBACK })
    );
  });
});

describe("queryProgramEventsCore - failOnError", () => {
  type SoftResult = {
    success: boolean;
    events: unknown[] | null;
    signatureCount: number | null;
    error?: string;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetChainIdFromNetwork.mockReturnValue(101);
    mockGetSolanaProvider.mockResolvedValue({
      executeWithFailover: mockExecuteWithFailover,
    });
    mockDbSelect.mockReturnValue({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([]) }),
      }),
    });
    mockGetSignaturesForAddress.mockRejectedValue(new Error("RPC down"));
  });

  it("softens a failed signature lookup when the toggle is off", async () => {
    const result = (await queryProgramEventsCore({
      network: "solana",
      programId: PROGRAM_ID,
      idl: JSON.stringify(IDL),
      failOnError: false,
    })) as SoftResult;

    expect(result.success).toBe(true);
    // Null, not []: a lookup that never completed must not look like
    // "no events in range".
    expect(result.events).toBeNull();
    expect(result.signatureCount).toBeNull();
    expect(result.error).toContain("Signature lookup failed");
  });

  it("hard-fails the same lookup by default", async () => {
    const result = (await queryProgramEventsCore({
      network: "solana",
      programId: PROGRAM_ID,
      idl: JSON.stringify(IDL),
    })) as SoftResult;

    expect(result.success).toBe(false);
  });

  it("still hard-fails an invalid program id when the toggle is off", async () => {
    const result = (await queryProgramEventsCore({
      network: "solana",
      programId: "not-a-valid-pubkey",
      failOnError: false,
    })) as SoftResult;

    expect(result.success).toBe(false);
  });
});
