import { beforeEach, describe, expect, it, vi } from "vitest";

// writeContractStep composes withStepValueCap and applyFailOnError. A
// value-cap denial (daily cap exceeded, or a malformed ethValue caught
// during cap parsing) must always hard-fail, even with failOnError off,
// since it carries no errorClass and is not a writeContractCore result.
// applyFailOnError must run only on the actual writeContractCore result.

vi.mock("server-only", () => ({}));

vi.mock("@/lib/metrics/instrumentation/plugin", async () =>
  (await import("../mocks/step-mocks")).pluginMetricsPassthrough()
);

vi.mock("@/lib/workflow/executor/step-handler", async () =>
  (await import("../mocks/step-mocks")).stepHandlerPassthrough()
);

vi.mock("drizzle-orm", () => ({ eq: () => ({}) }));

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      explorerConfigs: { findFirst: vi.fn().mockResolvedValue(undefined) },
    },
  },
}));

vi.mock("@/lib/db/schema", () => ({ explorerConfigs: { chainId: "chainId" } }));

vi.mock("@/lib/explorer", () => ({
  getAddressUrl: vi.fn(),
  getTransactionUrl: vi.fn(),
}));

vi.mock("@/lib/rpc/network-utils", () => ({
  getChainIdFromNetwork: vi.fn().mockReturnValue(1),
}));

const { mockWithStepValueCap, mockApplyFailOnError, mockWriteContractCore } =
  vi.hoisted(() => {
    const mockWithStepValueCap = vi.fn();
    const mockApplyFailOnError = vi.fn(
      (result: unknown, _failOnError: unknown) => ({
        ...(result as object),
        softened: true,
      })
    );
    const mockWriteContractCore = vi.fn();

    return {
      mockWithStepValueCap,
      mockApplyFailOnError,
      mockWriteContractCore,
    };
  });

vi.mock("@/lib/execute/value-ledger", () => ({
  withStepValueCap: (...args: unknown[]) => mockWithStepValueCap(...args),
}));

vi.mock("@/plugins/web3/steps/write-contract-core", () => ({
  writeContractCore: (input: unknown) => mockWriteContractCore(input),
  applyFailOnError: (result: unknown, failOnError: unknown) =>
    mockApplyFailOnError(result, failOnError),
}));

import {
  type WriteContractInput,
  writeContractStep,
} from "@/plugins/web3/steps/write-contract";

describe("writeContractStep value-cap interaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("hard-fails a value-cap denial without softening, even when failOnError is false", async () => {
    const denial = { success: false, error: "Daily spending cap exceeded" };
    mockWithStepValueCap.mockImplementation(async () => denial);

    const input: WriteContractInput = {
      contractAddress: "0x1234567890123456789012345678901234567890",
      network: "ethereum",
      abi: "[]",
      abiFunction: "transfer",
      ethValue: "1",
      failOnError: false,
      _context: {
        nodeId: "node-1",
        nodeName: "Write",
        nodeType: "web3/write-contract",
        organizationId: "org-1",
      },
    };
    const result = await writeContractStep(input);

    expect(result).toBe(denial);
    expect(mockWriteContractCore).not.toHaveBeenCalled();
    expect(mockApplyFailOnError).not.toHaveBeenCalled();
  });

  it("never forwards a payerParam the node config supplied to the core", async () => {
    // payerParam is an internal writeContractCore option: the core uses it to
    // overwrite an ABI argument with the resolved paying address. The
    // workflow executor spreads node config into the step input, so without
    // the strip a web3/write-contract node could name the argument the core
    // rewrites -- and the stablecoin ceiling is the thing that decides what
    // the rewritten call is allowed to move.
    mockWriteContractCore.mockResolvedValue({ success: true });
    mockWithStepValueCap.mockImplementation(
      async (_args: unknown, run: () => Promise<unknown>) => run()
    );

    const input: WriteContractInput = {
      contractAddress: "0x1234567890123456789012345678901234567890",
      network: "ethereum",
      abi: "[]",
      abiFunction: "transferFrom",
      payerParam: "from",
      _context: {
        nodeId: "node-1",
        nodeName: "Write",
        nodeType: "web3/write-contract",
        organizationId: "org-1",
      },
    };
    const result = await writeContractStep(input);

    expect(result.success).toBe(true);
    expect(mockWriteContractCore).toHaveBeenCalledTimes(1);
    const coreInput = mockWriteContractCore.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect("payerParam" in coreInput).toBe(false);
  });

  it("applies failOnError softening to a genuine writeContractCore result", async () => {
    const coreFailure = {
      success: false,
      error: "Contract call failed: Error(Splitter/kicked-too-soon)",
    };
    mockWriteContractCore.mockResolvedValue(coreFailure);
    mockWithStepValueCap.mockImplementation(
      async (_args: unknown, run: () => Promise<unknown>) => run()
    );

    const input: WriteContractInput = {
      contractAddress: "0x1234567890123456789012345678901234567890",
      network: "ethereum",
      abi: "[]",
      abiFunction: "transfer",
      failOnError: false,
      _context: {
        nodeId: "node-1",
        nodeName: "Write",
        nodeType: "web3/write-contract",
        organizationId: "org-1",
      },
    };
    const result = await writeContractStep(input);

    expect(mockApplyFailOnError).toHaveBeenCalledWith(coreFailure, false);
    expect(result).toEqual({ ...coreFailure, softened: true });
  });
});

describe("writeContractStep value cap for bundles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const ENDED = { settle: "settled", release: "released", hold: "held" };

  // Mirrors withValueCap: run with the reservation id, then end it as `ends` says.
  async function capOutcome(
    core: object
  ): Promise<"settled" | "released" | "held"> {
    let outcome: "settled" | "released" | "held" | undefined;
    mockWriteContractCore.mockResolvedValue(core);
    mockWithStepValueCap.mockImplementation(
      async (
        _args: unknown,
        run: (reservationId?: string) => Promise<{ success: boolean }>,
        ends: (result: {
          success: boolean;
        }) => "settle" | "release" | "hold" = (result) =>
          result.success ? "settle" : "release"
      ) => {
        const result = await run("res-1");
        outcome = ENDED[ends(result)] as "settled" | "released" | "held";
        return result;
      }
    );
    await writeContractStep({
      contractAddress: "0x1234567890123456789012345678901234567890",
      network: "ethereum",
      abi: "[]",
      abiFunction: "kick",
      ethValue: "1",
      _context: {
        nodeId: "node-1",
        nodeName: "Write",
        nodeType: "web3/write-contract",
        organizationId: "org-1",
        executionId: "exec-1",
      },
    });
    if (!outcome) {
      throw new Error("the value cap was not consulted");
    }
    return outcome;
  }

  const sent = { route: "bundle", targetBlocks: [11, 12] };

  it.each([
    [
      "skipped in flight",
      { success: true, route: "skipped-in-flight", included: false },
      "released",
    ],
    [
      "not picked (decided miss, may still land until the nonce is used)",
      {
        success: true,
        ...sent,
        included: false,
        notIncludedReason: "not-picked",
      },
      "held",
    ],
    [
      "not checked (may still land)",
      {
        success: true,
        ...sent,
        included: false,
        notIncludedReason: "not-checked",
      },
      "settled",
    ],
    [
      "landed",
      { success: true, ...sent, included: true, transactionHash: "0xab" },
      "settled",
    ],
    [
      "a replay that may still land (keeps its own charge)",
      {
        success: true,
        route: "bundle",
        included: false,
        notIncludedReason: "not-checked",
      },
      "settled",
    ],
    [
      "a replay that landed (keeps its own charge)",
      {
        success: true,
        route: "bundle",
        included: true,
        transactionHash: "0xab",
      },
      "settled",
    ],
  ])("%s: the reservation is %s", async (_name, core, expected) => {
    expect(await capOutcome(core)).toBe(expected);
  });

  it("passes the reservation id to the core, for the bundle row", async () => {
    await capOutcome({ success: true, ...sent, included: true });
    expect(mockWriteContractCore).toHaveBeenCalledWith(
      expect.objectContaining({
        _context: expect.objectContaining({ valueReservationId: "res-1" }),
      })
    );
  });
});
