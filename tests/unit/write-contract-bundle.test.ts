/**
 * Send as Bundle in Write Contract: the refusals before anything is sent, the
 * in-flight skip, and how each send outcome becomes the step's output and the
 * run-outcome signals the finalizer reads.
 */
import { ethers } from "ethers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/logging", () => ({
  ErrorCategory: {
    CONFIGURATION: "configuration",
    NETWORK_RPC: "network_rpc",
    EXTERNAL_SERVICE: "external_service",
    WORKFLOW_ENGINE: "workflow_engine",
    DATABASE: "database",
  },
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logUserError: vi.fn(),
  logSystemError: vi.fn(),
  logSystemWarn: vi.fn(),
}));

const h = vi.hoisted(() => ({
  chainBuilders: [] as { name: string; url: string }[],
  inFlight: vi.fn(),
  send: vi.fn(),
  affordable: true,
  sessions: 0,
  // The options the last nonce session was asked for, and an error it throws instead.
  sessionOptions: undefined as unknown,
  sessionError: undefined as Error | undefined,
  // linkBundleReservation calls: a replay's own reservation joins the row's nonce.
  links: [] as unknown[][],
  // What the max fee cap check says: an error while the cap is below the next base fee.
  capError: undefined as string | undefined,
  capChecks: 0,
  // Hands the cap check to the real one, which reads eth_feeHistory.
  realCapCheck: false,
  realSend: undefined as ((...args: unknown[]) => unknown) | undefined,
  signs: 0,
}));

vi.mock("@/lib/web3/nonce-manager", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/web3/nonce-manager")>()),
  linkBundleReservation: async (...args: unknown[]) => {
    h.links.push(args);
  },
}));

vi.mock("@/lib/web3/bundles/builders", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/web3/bundles/builders")>()),
  loadChainBuilders: async () => h.chainBuilders,
}));
vi.mock("@/lib/web3/bundles/in-flight", () => ({
  bundleInFlight: (...args: unknown[]) => h.inFlight(...args),
}));
vi.mock("@/lib/web3/bundles/send-bundle", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/web3/bundles/send-bundle")>();
  // A test may hand the send to the real code, over the stubs below.
  h.realSend = actual.sendBundleInSession as (...args: unknown[]) => unknown;
  return {
    ...actual,
    sendBundleInSession: (...args: unknown[]) => h.send(...args),
  };
});
// Only the real send reaches these: every target simulates, and the cap is Max Fee.
vi.mock("@/lib/web3/next-block-simulation", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/web3/next-block-simulation")
  >()),
  simulateSendAtNextBlock: async () => ({
    gasEstimate: BigInt(50_000),
    simulation: {},
  }),
}));
vi.mock("@/lib/web3/gas-strategy", () => ({
  getGasStrategy: () => ({
    getGasConfig: async () => ({
      gasLimit: BigInt(60_000),
      maxFeePerGas: BigInt(30e9),
      maxPriorityFeePerGas: BigInt(1e9),
    }),
    priorityFeeLimit: async () => BigInt(500e9),
  }),
}));
vi.mock("@/lib/web3/gas-preflight", () => ({
  preflightGasBalance: async () =>
    h.affordable
      ? { affordable: true }
      : { affordable: false, message: "Insufficient funds for gas" },
}));
vi.mock("@/lib/web3/max-fee-check", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/web3/max-fee-check")>();
  return {
    maxFeeBelowBaseFeeError: async (
      ...args: Parameters<typeof actual.maxFeeBelowBaseFeeError>
    ) => {
      h.capChecks += 1;
      return h.realCapCheck
        ? await actual.maxFeeBelowBaseFeeError(...args)
        : await Promise.resolve(h.capError);
    },
  };
});
vi.mock("@/lib/web3/transaction-manager", () => ({
  withNonceSession: async (
    _context: unknown,
    _wallet: string,
    fn: (session: unknown) => Promise<unknown>,
    options?: unknown
  ) => {
    h.sessionOptions = options;
    if (h.sessionError) {
      throw h.sessionError;
    }
    h.sessions += 1;
    return await fn({ currentNonce: 1, startedAt: new Date() });
  },
}));
vi.mock("@/lib/web3/wallet-helpers", () => ({
  initializeWalletSigner: async () => ({
    provider: {},
    signTransaction: async () => {
      h.signs += 1;
      return "0x";
    },
  }),
}));
vi.mock("@/lib/web3/chain-adapter", () => ({
  getChainAdapter: () => ({
    getTransactionUrl: async (hash: string) =>
      `https://scan.example/tx/${hash}`,
  }),
}));

import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { logSystemError } from "@/lib/logging";
import {
  BUNDLE_RUN_MARGIN_MS,
  LONGEST_BUNDLE_HOLD_MS,
} from "@/lib/web3/bundles/bundle-history";
import {
  BundleRecordError,
  BundleSigningError,
} from "@/lib/web3/bundles/send-bundle";
import { NonceLockWaitEndedError } from "@/lib/web3/nonce-manager";
import { signalsOfStep } from "@/lib/workflow/executor/run-outcome";
import {
  bundleReservationEnd,
  waitingStepSentence,
} from "@/lib/workflow/executor/run-outcome-keys";
import { RUN_DEADLINE_AT_ENV } from "@/lib/workflow/executor/runner-constants";
import {
  type BundleRoute,
  bundleSignerRefusal,
  prepareBundleRoute,
  writeAsBundle,
} from "@/plugins/web3/steps/write-contract-bundle";
import {
  applyFailOnError,
  type WriteContractResult,
} from "@/plugins/web3/steps/write-contract-core";

const SEARCHER_KEY = `0x${"33".repeat(32)}`;
const CONTEXT = {
  executionId: "exec-1",
  workflowId: "wf-1",
  nodeId: "write-1",
  nodeName: "Kick",
  nodeType: "web3/write-contract",
};
const BUILDERS = [
  { name: "flashbots", url: "https://relay.example" },
  { name: "titan", url: "https://titan.example" },
];

async function prepare(
  overrides: {
    context?: Record<string, unknown>;
    config?: Record<string, unknown>;
  } = {}
) {
  return await prepareBundleRoute({
    organizationId: "org-1",
    chainId: 1,
    context: { ...CONTEXT, ...overrides.context },
    config: overrides.config ?? {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  replayReceipt = null;
  vi.stubEnv("BUNDLE_SEND_ROLLOUT", "all");
  vi.stubEnv("BUNDLE_SEARCHER_PRIVATE_KEY", SEARCHER_KEY);
  h.chainBuilders = BUILDERS;
  h.inFlight.mockResolvedValue({ kind: "none" });
  h.affordable = true;
  h.sessions = 0;
  h.links = [];
  h.sessionOptions = undefined;
  h.sessionError = undefined;
  h.capError = undefined;
  h.capChecks = 0;
  h.realCapCheck = false;
  h.signs = 0;
});

describe("prepareBundleRoute", () => {
  it("takes every builder of the network by default", async () => {
    const prepared = await prepare();
    expect(prepared.ok && prepared.route).toMatchObject({
      settings: { blocks: 3, tipIncreasePercent: 0 },
      builders: BUILDERS,
      unknownBuilders: [],
      workflowId: "wf-1",
      executionId: "exec-1",
      node: { id: "write-1", name: "Kick" },
    });
  });

  it("refuses a step inside a nested For Each, keeps a single one", async () => {
    const nested = await prepare({
      context: { iterationIndex: 0, loopDepth: 2 },
    });
    expect(nested).toEqual({
      ok: false,
      failure: {
        success: false,
        error: expect.stringContaining("inside another For Each"),
        errorClass: ExecutionErrorType.USER,
      },
    });
    expect((await prepare({ context: { iterationIndex: 0 } })).ok).toBe(true);
  });

  it("names the step's loop iteration", async () => {
    const prepared = await prepare({ context: { iterationIndex: 4 } });
    expect(prepared.ok && prepared.route.node).toEqual({
      id: "write-1",
      name: "Kick",
      iterationIndex: 4,
    });
  });

  it("refuses an organization outside the rollout first", async () => {
    vi.stubEnv("BUNDLE_SEND_ROLLOUT", "orgs:org-2");
    vi.stubEnv("BUNDLE_SEARCHER_PRIVATE_KEY", "");
    const prepared = await prepare({ context: { workflowId: undefined } });
    expect(prepared).toEqual({
      ok: false,
      failure: {
        success: false,
        error: expect.stringContaining("not enabled for this organization"),
        errorClass: ExecutionErrorType.USER,
      },
    });
  });

  it.each([
    ["direct execution (no workflow)", { workflowId: undefined }],
    ["a node-test call", { nodeType: "action" }],
    ["a protocol write", { nodeType: "aave/supply" }],
    ["no node", { nodeId: undefined }],
  ])("refuses %s", async (_name, context) => {
    const prepared = await prepare({ context });
    expect(prepared.ok).toBe(false);
    expect(!prepared.ok && prepared.failure).toMatchObject({
      error: expect.stringContaining("only run in a Write Contract step"),
      errorClass: ExecutionErrorType.USER,
    });
  });

  it("accepts the legacy Write Contract node type", async () => {
    expect(
      (await prepare({ context: { nodeType: "Write Contract" } })).ok
    ).toBe(true);
  });

  it("refuses bad settings as a user error", async () => {
    const prepared = await prepare({ config: { bundleBlocks: 6 } });
    expect(!prepared.ok && prepared.failure.errorClass).toBe(
      ExecutionErrorType.USER
    );
  });

  it("refuses a network with no builders", async () => {
    h.chainBuilders = [];
    const prepared = await prepare();
    expect(!prepared.ok && prepared.failure.error).toContain(
      "no block builders"
    );
  });

  it("keeps unknown picked names beside known ones, refuses only unknown ones", async () => {
    const some = await prepare({
      config: { bundleBuilders: ["titan", "ghost"] },
    });
    expect(some.ok && some.route.builders).toEqual([BUILDERS[1]]);
    expect(some.ok && some.route.unknownBuilders).toEqual(["ghost"]);

    const none = await prepare({ config: { bundleBuilders: ["ghost"] } });
    expect(!none.ok && none.failure.error).toBe(
      "None of the picked builders (ghost) is in this network's builder list. Pick from: flashbots, titan."
    );
  });

  it("refuses a missing searcher key as a system error, without the value", async () => {
    vi.stubEnv("BUNDLE_SEARCHER_PRIVATE_KEY", "0xnot-a-key");
    const prepared = await prepare();
    expect(!prepared.ok && prepared.failure).toMatchObject({
      errorClass: ExecutionErrorType.SYSTEM,
    });
    expect(JSON.stringify(prepared)).not.toContain("not-a-key");
    expect(logSystemError).toHaveBeenCalled();
  });

  it("never puts a builder URL in a refusal", async () => {
    const prepared = await prepare({ config: { bundleBuilders: ["ghost"] } });
    expect(JSON.stringify(prepared)).not.toContain("example");
  });
});

describe("bundleSignerRefusal", () => {
  it("lets the wallet (EOA) through and refuses Safe and Roles", () => {
    expect(bundleSignerRefusal({ kind: "eoa" } as never)).toBeUndefined();
    for (const kind of ["safe", "safe-role"]) {
      expect(bundleSignerRefusal({ kind } as never)).toMatchObject({
        success: false,
        error: expect.stringContaining("Safe or Roles"),
        errorClass: ExecutionErrorType.USER,
      });
    }
  });
});

const ABI = ["function kick()"];
const REPORT = {
  targetBlocks: [11, 12],
  targetTipsGwei: ["1", "1.2"],
  builders: [{ name: "flashbots", accepted: true }],
};

async function route(): Promise<BundleRoute> {
  const prepared = await prepare();
  if (!prepared.ok) {
    throw new Error("expected a route");
  }
  return prepared.route;
}

// A mined receipt for the landed-replay reads, else null.
let replayReceipt: Record<string, unknown> | null | Error = null;

type BundleWrite = Parameters<typeof writeAsBundle>[0];

async function write(
  overrides: Partial<BundleWrite> = {}
): Promise<WriteContractResult> {
  return await writeAsBundle({
    route: await route(),
    chainId: 1,
    organizationId: "org-1",
    walletAddress: `0x${"aa".repeat(20)}`,
    rpcUrl: "https://rpc.example",
    rpcManager: {
      executeWithFailover: async (
        operation: (provider: unknown) => Promise<unknown>
      ) =>
        await operation({
          getBlockNumber: async () => 10,
          getTransactionReceipt: async () => {
            if (replayReceipt instanceof Error) {
              throw replayReceipt;
            }
            return replayReceipt;
          },
        }),
    } as never,
    traceExecuted: async () => undefined,
    txContext: {} as never,
    contractAddress: `0x${"cc".repeat(20)}`,
    parsedAbi: ABI,
    abiFunction: "kick",
    functionKey: "kick",
    args: [],
    gas: {},
    ...overrides,
  });
}

// A bundle that landed and succeeded at block 12.
const landed = (hash: string) => ({
  kind: "included",
  gasLimit: BigInt(60_000),
  mined: {
    hash,
    blockNumber: 12,
    succeeded: true,
    gasUnits: BigInt(40_000),
    feeWei: BigInt(40_000) * BigInt(11),
  },
  report: REPORT,
});

const signals = (output: WriteContractResult) =>
  signalsOfStep("web3/write-contract", output);

describe("writeAsBundle", () => {
  it("skips without the wallet lock while another run's bundle may land", async () => {
    h.inFlight.mockResolvedValue({ kind: "other", untilBlock: 15 });
    const result = await write();
    expect(result).toEqual({
      success: true,
      route: "skipped-in-flight",
      included: false,
      inFlightUntilBlock: 15,
    });
    expect(h.sessions).toBe(0);
    expect(h.send).not.toHaveBeenCalled();
    expect(signals(result)).toEqual({
      bundleSent: false,
      otherWork: true,
      skippedInFlight: true,
      notIncluded: false,
      waiting: false,
    });
    expect(h.inFlight).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: "wf-1",
        chainId: 1,
        walletAddress: `0x${"aa".repeat(20)}`,
        step: {
          executionId: "exec-1",
          nodeId: "write-1",
          iterationIndex: undefined,
        },
      })
    );
  });

  it("checks again under the lock: a row recorded while it waited skips it before signing", async () => {
    h.inFlight
      .mockResolvedValueOnce({ kind: "none" })
      .mockResolvedValueOnce({ kind: "other", untilBlock: 12 });
    const result = await write();
    expect(result).toMatchObject({ route: "skipped-in-flight" });
    expect(h.sessions).toBe(1);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("decides dropped rows only under the lock, with the session's nonce", async () => {
    h.send.mockResolvedValue({
      kind: "not-included",
      reason: "not-picked",
      report: REPORT,
    });
    await write();
    const [before, under] = h.inFlight.mock.calls.map(
      ([options]) => (options as { sessionNonce?: number }).sessionNonce
    );
    expect(before).toBeUndefined();
    expect(under).toBe(1);
  });

  it("a replay of this step while its bundle may land never signs again: not-checked, not skipped", async () => {
    h.inFlight.mockResolvedValue({ kind: "replay" });
    const result = await write();
    expect(result).toEqual({
      success: true,
      route: "bundle",
      included: false,
      notIncludedReason: "not-checked",
    });
    expect(h.send).not.toHaveBeenCalled();
    expect(signals(result)).toEqual({
      bundleSent: true,
      otherWork: true,
      skippedInFlight: false,
      notIncluded: true,
      waiting: false,
    });
  });

  it("a replay of a step whose bundle landed returns the landing, signs nothing and keeps its own value charge", async () => {
    replayReceipt = {
      blockNumber: 50,
      status: 1,
      gasUsed: BigInt(40_000),
      gasPrice: BigInt(11),
    };
    h.inFlight.mockResolvedValue({
      kind: "replay",
      nonce: 7,
      landedHash: "0xab",
    });
    const result = await write();
    expect(result).toMatchObject({
      success: true,
      route: "bundle",
      included: true,
      includedBlock: 50,
      transactionHash: "0xab",
    });
    expect(result).not.toHaveProperty("targetBlocks");
    expect(h.send).not.toHaveBeenCalled();
    expect(h.sessions).toBe(0);
    expect(bundleReservationEnd(result)).toBe("settle");
  });

  it("finds a landed replay under the lock too (reconcile confirmed it), and reads its receipt after the lock", async () => {
    replayReceipt = {
      blockNumber: 50,
      status: 1,
      gasUsed: BigInt(40_000),
      gasPrice: BigInt(11),
    };
    h.inFlight
      .mockResolvedValueOnce({ kind: "none" })
      .mockResolvedValueOnce({ kind: "replay", nonce: 7, landedHash: "0xab" });
    expect(await write()).toMatchObject({
      included: true,
      transactionHash: "0xab",
    });
    expect(h.send).not.toHaveBeenCalled();
    expect(h.sessions).toBe(1);
  });

  it("a replay of a decided miss returns that miss, signs nothing and holds its value", async () => {
    h.inFlight.mockResolvedValue({
      kind: "replay",
      nonce: 7,
      missed: "no-longer-needed",
    });
    const result = await write();
    expect(result).toEqual({
      success: true,
      route: "bundle",
      included: false,
      notIncludedReason: "no-longer-needed",
    });
    expect(h.send).not.toHaveBeenCalled();
    expect(h.sessions).toBe(0);
    expect(bundleReservationEnd(result)).toBe("hold");
  });

  it("a replay of a bundle no builder accepted fails again as it did, signing nothing", async () => {
    h.inFlight.mockResolvedValue({
      kind: "replay",
      nonce: 7,
      missed: "no-builder-accepted",
    });
    const result = await write();
    expect(result).toMatchObject({
      success: false,
      errorClass: ExecutionErrorType.EXTERNAL,
      route: "bundle",
      included: false,
      broadcastAttempted: true,
    });
    const error = result.success ? "" : result.error;
    expect(error).toBe(
      "No block builder accepted the bundle, so it is not expected to be included. This step ran again after a crash and sent nothing new; the first attempt's builder answers are not kept."
    );
    expect(error).not.toContain("builders output");
    expect(h.send).not.toHaveBeenCalled();
    // Each builder that answered still read the signed bytes: the value is held.
    expect(bundleReservationEnd(result)).toBe("hold");
  });

  it("a replay links its own reservation to the replayed row's nonce, so the cap counts it once", async () => {
    h.inFlight.mockResolvedValue({
      kind: "replay",
      nonce: 7,
      missed: "not-picked",
    });
    const replayRoute = { ...(await route()), valueReservationId: "res-2" };
    await write({ route: replayRoute });
    expect(h.links).toEqual([
      [
        "res-2",
        { chainId: 1, walletAddress: `0x${"aa".repeat(20)}`, nonce: 7 },
      ],
    ]);
  });

  it("a replay with no reservation (no value) links nothing", async () => {
    h.inFlight.mockResolvedValue({ kind: "replay", nonce: 7 });
    await write();
    expect(h.links).toEqual([]);
  });

  it("a landed replay whose receipt cannot be read is not-checked (the sweep settles the run)", async () => {
    replayReceipt = new Error("rpc down");
    h.inFlight.mockResolvedValue({
      kind: "replay",
      nonce: 7,
      landedHash: "0xab",
    });
    expect(await write()).toEqual({
      success: true,
      route: "bundle",
      included: false,
      notIncludedReason: "not-checked",
    });
  });

  it("a failed row write is logged as a system database error, nothing sent", async () => {
    h.send.mockRejectedValueOnce(new BundleRecordError("db down"));
    const result = await write();
    expect(result).toMatchObject({
      success: false,
      broadcastAttempted: false,
      errorClass: ExecutionErrorType.SYSTEM,
    });
    expect(logSystemError).toHaveBeenCalledWith(
      "database",
      expect.any(String),
      expect.anything(),
      expect.anything()
    );
  });

  describe("with a max fee cap below the next base fee", () => {
    const CAP = { maxFeeOverride: BigInt(1e9) };
    const CAP_ERROR =
      "Max fee 1 gwei is below the next block's base fee of 2 gwei, so the transaction could not be included. Raise the max fee or leave it empty.";
    beforeEach(() => {
      h.capError = CAP_ERROR;
    });

    it("a replay of a landed step still returns the landing", async () => {
      replayReceipt = {
        blockNumber: 50,
        status: 1,
        gasUsed: BigInt(40_000),
        gasPrice: BigInt(11),
      };
      h.inFlight.mockResolvedValue({
        kind: "replay",
        nonce: 7,
        landedHash: "0xab",
      });
      const result = await write({ gas: CAP });
      expect(result).toMatchObject({
        success: true,
        route: "bundle",
        included: true,
        transactionHash: "0xab",
      });
      expect(h.send).not.toHaveBeenCalled();
    });

    it("another run's bundle in flight still ends skipped in flight", async () => {
      h.inFlight.mockResolvedValue({ kind: "other", untilBlock: 15 });
      const result = await write({ gas: CAP });
      expect(result).toEqual({
        success: true,
        route: "skipped-in-flight",
        included: false,
        inFlightUntilBlock: 15,
      });
    });

    it("with nothing in flight fails as an external error, before the gas check and the lock", async () => {
      h.affordable = false;
      const result = await write({ gas: CAP });
      expect(result).toEqual({
        success: false,
        error: CAP_ERROR,
        errorClass: ExecutionErrorType.EXTERNAL,
      });
      expect(h.capChecks).toBe(1);
      expect(h.sessions).toBe(0);
      expect(h.send).not.toHaveBeenCalled();
    });

    it("leaves the check out without a cap", async () => {
      h.send.mockResolvedValue(landed("0xcd"));
      const result = await write();
      expect(result).toMatchObject({ success: true, included: true });
      expect(h.capChecks).toBe(0);
    });
  });

  it("checks gas before taking the lock", async () => {
    h.affordable = false;
    const result = await write();
    expect(result).toMatchObject({ success: false });
    expect(h.sessions).toBe(0);
  });

  it("not included: success with the reason and no transactionHash", async () => {
    h.send.mockResolvedValue({
      kind: "not-included",
      reason: "no-longer-needed",
      report: REPORT,
    });
    const result = await write();
    expect(result).toEqual({
      success: true,
      route: "bundle",
      included: false,
      notIncludedReason: "no-longer-needed",
      ...REPORT,
    });
    expect(result).not.toHaveProperty("transactionHash");
    expect(signals(result)).toEqual({
      bundleSent: true,
      otherWork: true,
      skippedInFlight: false,
      notIncluded: true,
      waiting: false,
    });
  });

  it("included: the mined hash, fee and block", async () => {
    const hash = `0x${"ab".repeat(32)}`;
    h.send.mockResolvedValue({
      kind: "included",
      gasLimit: BigInt(60_000),
      mined: {
        hash,
        blockNumber: 12,
        succeeded: true,
        gasUnits: BigInt(40_000),
        feeWei: BigInt(40_000) * BigInt(11),
      },
      report: REPORT,
    });
    const result = await write();
    expect(result).toMatchObject({
      success: true,
      route: "bundle",
      included: true,
      includedBlock: 12,
      transactionHash: hash,
      chainId: 1,
      transactionLink: `https://scan.example/tx/${hash}`,
      gasUsed: "440000",
      gasUsedUnits: "40000",
      effectiveGasPrice: "11",
      ...REPORT,
    });
    expect(signals(result)).toEqual({
      bundleSent: true,
      otherWork: true,
      skippedInFlight: false,
      notIncluded: false,
      waiting: false,
    });
  });

  it("included: traces the landed call once and returns it as executedCall", async () => {
    const hash = `0x${"ab".repeat(32)}`;
    h.send.mockResolvedValue(landed(hash));
    const call = { functionName: "kick", args: [] } as never;
    const traceExecuted = vi.fn(async () => call);
    const result = await write({ traceExecuted });
    expect(traceExecuted).toHaveBeenCalledTimes(1);
    expect(traceExecuted).toHaveBeenCalledWith(hash, {
      target: `0x${"cc".repeat(20)}`,
      abi: ABI,
      functionName: "kick",
    });
    expect(result).toMatchObject({ success: true, executedCall: call });
  });

  it("included: a trace that finds nothing leaves executedCall out, still a success", async () => {
    h.send.mockResolvedValue(landed(`0x${"ab".repeat(32)}`));
    const traceExecuted = vi.fn(async () => undefined);
    const result = await write({ traceExecuted });
    expect(traceExecuted).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect((result as { executedCall?: unknown }).executedCall).toBeUndefined();
  });

  it("a mined revert fails the step with the hash, as a normal send does", async () => {
    const hash = `0x${"cd".repeat(32)}`;
    h.send.mockResolvedValue({
      kind: "included",
      gasLimit: BigInt(60_000),
      mined: {
        hash,
        blockNumber: 12,
        succeeded: false,
        gasUnits: BigInt(30_000),
        feeWei: BigInt(1),
      },
      report: REPORT,
    });
    const result = await write();
    expect(result).toMatchObject({
      success: false,
      included: true,
      transactionHash: hash,
      broadcastAttempted: true,
    });
    expect(!result.success && result.error).toContain("reverted on-chain");
  });

  it("no builder accepted: an external error that failOnError=false may soften", async () => {
    h.send.mockResolvedValue({ kind: "no-builder-accepted", report: REPORT });
    const result = await write();
    expect(result).toMatchObject({
      success: false,
      errorClass: ExecutionErrorType.EXTERNAL,
      route: "bundle",
      included: false,
      broadcastAttempted: true,
      ...REPORT,
    });
    expect(!result.success && result.error).toContain(
      "not expected to be included"
    );
    expect(!result.success && result.error).toContain("builders output");
    const softened = applyFailOnError(result, false);
    expect(softened).toMatchObject({
      success: true,
      route: "bundle",
      included: false,
      builders: REPORT.builders,
    });
    expect(softened).not.toHaveProperty("notIncludedReason");
  });

  it("used elsewhere is a user error naming a send from outside KeeperHub", async () => {
    h.send.mockResolvedValue({ kind: "used-elsewhere", report: REPORT });
    const result = await write();
    expect(result).toMatchObject({
      success: false,
      errorClass: ExecutionErrorType.USER,
      broadcastAttempted: true,
    });
    expect(!result.success && result.error).toContain("outside KeeperHub");
    expect(!result.success && result.error).not.toContain("no other workflow");
    expect(result).not.toHaveProperty("transactionHash");
  });

  it("an error before sending is pre-broadcast with no class; one after sending is not-checked", async () => {
    h.send.mockRejectedValueOnce(new Error("estimate failed"));
    const before = await write();
    expect(before).toMatchObject({ success: false, broadcastAttempted: false });
    expect(before).not.toHaveProperty("errorClass");

    h.send.mockImplementationOnce(
      async (input: { progress: { sent: boolean; report?: unknown } }) => {
        input.progress.sent = true;
        input.progress.report = REPORT;
        throw new Error("socket hang up");
      }
    );
    const after = await write();
    expect(after).toEqual({
      success: true,
      route: "bundle",
      included: false,
      notIncludedReason: "not-checked",
      ...REPORT,
    });
    // It was sent: its value stays charged.
    expect(bundleReservationEnd(after)).toBe("settle");
    expect(logSystemError).toHaveBeenCalled();
  });

  it("a signing failure says so and is not logged as a network error", async () => {
    h.send.mockRejectedValueOnce(new BundleSigningError("turnkey timeout"));
    const result = await write();
    expect(result).toMatchObject({ success: false, broadcastAttempted: false });
    expect(!result.success && result.error).toContain(
      "Signing the bundle failed"
    );
    expect(logSystemError).toHaveBeenCalledWith(
      "external_service",
      expect.any(String),
      expect.anything(),
      expect.anything()
    );
  });

  it("maps a timing error's Simulate at advice to one bundle message", async () => {
    h.send.mockRejectedValueOnce(
      new Error(
        'Next-block simulation: the RPC\'s latest block is 99s old. On a fork or test node, set "Simulate at" back to "Latest block".'
      )
    );
    const result = await write();
    expect(!result.success && result.error).toContain(
      "target blocks' times could not be predicted"
    );
    expect(!result.success && result.error).not.toContain("Simulate at");
  });

  it("a pre-send refusal from the send keeps its class and sends nothing", async () => {
    h.send.mockResolvedValue({
      kind: "refused",
      error: "A bundle needs a priority fee (tip) above 0",
      errorClass: ExecutionErrorType.USER,
      report: {},
    });
    expect(await write()).toEqual({
      success: false,
      error: "A bundle needs a priority fee (tip) above 0",
      errorClass: ExecutionErrorType.USER,
      broadcastAttempted: false,
    });
  });

  it("encodes the call for the send and passes the step's node", async () => {
    h.send.mockResolvedValue({
      kind: "not-included",
      reason: "not-picked",
      report: REPORT,
    });
    await write();
    const sent = h.send.mock.calls[0][0] as {
      call: { data: string };
      node: unknown;
      blocks: number;
      workflowId: string;
    };
    expect(sent.call.data).toBe(
      new ethers.Interface(ABI).encodeFunctionData("kick", [])
    );
    expect(sent.node).toEqual({ id: "write-1", name: "Kick" });
    expect(sent.blocks).toBe(3);
    expect(sent.workflowId).toBe("wf-1");
  });

  it("passes the block that triggered the run to the send", async () => {
    h.send.mockResolvedValue({
      kind: "not-included",
      reason: "not-picked",
      report: REPORT,
    });
    const triggerBlock = { chainId: 1, number: 9 };
    await write({ triggerBlock });
    expect(h.send.mock.calls[0][0]).toMatchObject({ triggerBlock });
  });
});

describe("bundleReservationEnd (value cap)", () => {
  const notIncluded = (reason: string): WriteContractResult => ({
    success: true,
    route: "bundle",
    included: false,
    notIncludedReason: reason,
    targetBlocks: [11, 12],
  });

  it("releases a skip, a failure before sending and a mined revert", () => {
    expect(
      bundleReservationEnd({ success: true, route: "skipped-in-flight" })
    ).toBe("release");
    expect(
      bundleReservationEnd({ success: false, route: "bundle", included: false })
    ).toBe("release");
    expect(
      bundleReservationEnd({ success: false, broadcastAttempted: false })
    ).toBe("release");
    expect(
      bundleReservationEnd({
        success: false,
        route: "bundle",
        included: true,
        broadcastAttempted: true,
      })
    ).toBe("release");
  });

  it("holds a send no builder accepted: each builder still read the signed bytes", () => {
    expect(
      bundleReservationEnd({
        success: false,
        route: "bundle",
        included: false,
        broadcastAttempted: true,
      })
    ).toBe("hold");
  });

  it("holds a decided miss: its signed transactions can still be mined", () => {
    expect(bundleReservationEnd(notIncluded("not-picked"))).toBe("hold");
    expect(bundleReservationEnd(notIncluded("no-longer-needed"))).toBe("hold");
  });

  it("keeps a replay's own charge: the crashed attempt's reservation lapses", () => {
    expect(
      bundleReservationEnd({
        success: true,
        route: "bundle",
        included: false,
        notIncludedReason: "not-checked",
      })
    ).toBe("settle");
    expect(
      bundleReservationEnd({ success: true, route: "bundle", included: true })
    ).toBe("settle");
  });

  it("settles an undecided bundle, a landing and any other write", () => {
    expect(bundleReservationEnd(notIncluded("not-checked"))).toBe("settle");
    const landed: WriteContractResult = {
      success: true,
      route: "bundle",
      included: true,
      targetBlocks: [11],
    };
    expect(bundleReservationEnd(landed)).toBe("settle");
    expect(
      bundleReservationEnd({ success: true, route: "public", included: true })
    ).toBe("settle");
  });
});

describe("bundle step vs the run's time limit", () => {
  const NEED_MS = LONGEST_BUNDLE_HOLD_MS + BUNDLE_RUN_MARGIN_MS;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses before taking the wallet's lock when the run has less time left than a hold", async () => {
    vi.stubEnv(RUN_DEADLINE_AT_ENV, String(Date.now() + NEED_MS - 5000));
    const result = await write();
    expect(result).toMatchObject({
      success: false,
      errorClass: ExecutionErrorType.USER,
      broadcastAttempted: false,
    });
    expect(!result.success && result.error).toContain("before its time limit");
    expect(h.sessions).toBe(0);
    expect(h.sessionOptions).toBeUndefined();
    expect(h.send).not.toHaveBeenCalled();
  });

  it("bounds the lock wait by the time left, and passes the deadline to the send", async () => {
    const deadline = Date.now() + NEED_MS + 60_000;
    vi.stubEnv(RUN_DEADLINE_AT_ENV, String(deadline));
    h.send.mockResolvedValue(landed("0xab"));
    await write();
    expect(h.sessionOptions).toEqual({ waitUntil: deadline - NEED_MS });
    expect(h.send.mock.calls[0][0]).toMatchObject({ runDeadline: deadline });
  });

  it("a lock wait that ran into the limit says the wallet was busy, nothing sent", async () => {
    vi.stubEnv(RUN_DEADLINE_AT_ENV, String(Date.now() + NEED_MS + 1000));
    h.sessionError = new NonceLockWaitEndedError("still in use");
    const result = await write();
    expect(result).toMatchObject({
      success: false,
      errorClass: ExecutionErrorType.USER,
      broadcastAttempted: false,
    });
    expect(!result.success && result.error).toContain(
      "The wallet was busy with another send on this network"
    );
    expect(h.send).not.toHaveBeenCalled();
  });

  it("skips the landed call's trace when too little time is left to write the run", async () => {
    vi.stubEnv(RUN_DEADLINE_AT_ENV, String(Date.now() + NEED_MS + 1000));
    h.send.mockImplementation(async () => {
      // The bundle took most of the run: only the margin and a second are left.
      vi.stubEnv(
        RUN_DEADLINE_AT_ENV,
        String(Date.now() + BUNDLE_RUN_MARGIN_MS + 1000)
      );
      return landed(`0x${"ab".repeat(32)}`);
    });
    const traceExecuted = vi.fn(async () => ({}) as never);
    const result = await write({ traceExecuted });
    expect(traceExecuted).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: true, included: true });
    expect((result as { executedCall?: unknown }).executedCall).toBeUndefined();
  });

  it("stops waiting for a slow trace at the time left less the margin, still a success", async () => {
    vi.stubEnv(RUN_DEADLINE_AT_ENV, String(Date.now() + NEED_MS + 1000));
    h.send.mockImplementation(async () => {
      vi.stubEnv(
        RUN_DEADLINE_AT_ENV,
        String(Date.now() + BUNDLE_RUN_MARGIN_MS + 2500)
      );
      return landed(`0x${"ab".repeat(32)}`);
    });
    const traceExecuted = vi.fn(() => new Promise<undefined>(() => undefined));
    const started = Date.now();
    const result = await write({ traceExecuted });
    expect(traceExecuted).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result).toMatchObject({ success: true, included: true });
    expect((result as { executedCall?: unknown }).executedCall).toBeUndefined();
  });

  it("waits without a limit when the run's deadline is unknown", async () => {
    h.send.mockResolvedValue(landed("0xab"));
    await write();
    expect(h.sessionOptions).toEqual({});
    expect(h.send.mock.calls[0][0]).toMatchObject({ runDeadline: undefined });
  });
});

describe("writeAsBundle with Not before", () => {
  const LATEST = 1000;
  const LATEST_TIME = 1_800_000_000;
  // Latest 1000; its parent 999 one slot earlier. Ethereum: 12 s slots.
  const chainManager = (fail = false) =>
    ({
      executeWithFailover: async (
        operation: (provider: unknown) => Promise<unknown>
      ) =>
        await operation({
          getBlockNumber: async () => LATEST,
          getTransactionReceipt: async () => replayReceipt,
          getBlock: async (tag: unknown) => {
            if (fail) {
              throw new Error("rpc down");
            }
            return tag === "latest"
              ? { number: LATEST, timestamp: LATEST_TIME, parentHash: "0xp" }
              : { number: LATEST - 1, timestamp: LATEST_TIME - 12 };
          },
        }),
    }) as never;

  async function aheadRoute(notBefore: unknown): Promise<BundleRoute> {
    const prepared = await prepare({ config: { notBefore } });
    if (!prepared.ok) {
      throw new Error("expected a route");
    }
    return prepared.route;
  }

  it("ends waiting before the gas check and the wallet lock: nothing signed, value released", async () => {
    // U = 999 + ceil(72 / 12) = 1005, more than Send ahead 2 + 1 blocks away.
    h.affordable = false;
    const result = await write({
      route: await aheadRoute(LATEST_TIME + 60),
      rpcManager: chainManager(),
    });
    expect(result).toEqual({
      success: true,
      route: "waiting",
      included: false,
      notBefore: LATEST_TIME + 60,
      firstAllowedBlock: 1005,
      latestBlock: LATEST,
      sendAheadBlocks: 2,
    });
    expect(h.sessions).toBe(0);
    expect(h.send).not.toHaveBeenCalled();
    expect(signals(result)).toEqual({
      bundleSent: false,
      otherWork: false,
      skippedInFlight: false,
      notIncluded: false,
      waiting: true,
    });
    expect(bundleReservationEnd(result)).toBe("release");
  });

  it("keeps waiting through a base-fee spike: the cap is checked only when it is about to send", async () => {
    h.capError = "Max fee 1 gwei is below the next block's base fee of 2 gwei";
    const result = await write({
      route: await aheadRoute(LATEST_TIME + 60),
      rpcManager: chainManager(),
      gas: { maxFeeOverride: BigInt(1e9) },
    });
    expect(result).toMatchObject({ success: true, route: "waiting" });
    expect(h.capChecks).toBe(0);
  });

  it("checks replay and in flight first: a replay whose Not before moved returns its result", async () => {
    h.inFlight.mockResolvedValue({
      kind: "replay",
      nonce: 7,
      missed: "not-picked",
    });
    const replayed = await write({
      route: await aheadRoute(LATEST_TIME + 6000),
      rpcManager: chainManager(),
    });
    expect(replayed).toMatchObject({
      route: "bundle",
      included: false,
      notIncludedReason: "not-picked",
    });
    h.inFlight.mockResolvedValue({ kind: "other", untilBlock: 15 });
    const skipped = await write({
      route: await aheadRoute(LATEST_TIME + 6000),
      rpcManager: chainManager(),
    });
    expect(skipped).toMatchObject({ route: "skipped-in-flight" });
  });

  it("goes to the wallet lock when U is close enough, handing Not before to the send", async () => {
    h.send.mockResolvedValue({
      kind: "included",
      gasLimit: BigInt(60_000),
      mined: {
        hash: "0xab",
        blockNumber: 1003,
        succeeded: true,
        gasUnits: BigInt(1),
        feeWei: BigInt(1),
      },
      report: { ...REPORT, notBefore: LATEST_TIME + 36 },
    });
    const result = await write({
      route: await aheadRoute(LATEST_TIME + 36),
      rpcManager: chainManager(),
    });
    expect(h.sessions).toBe(1);
    expect(h.send.mock.calls[0][0]).toMatchObject({
      sendAhead: { notBefore: LATEST_TIME + 36, blocks: 2 },
    });
    expect(result).toMatchObject({
      success: true,
      notBefore: LATEST_TIME + 36,
    });
  });

  it("ends waiting when U, worked out again under the lock, is still too far", async () => {
    const report = {
      notBefore: LATEST_TIME + 36,
      firstAllowedBlock: 1004,
      latestBlock: 1000,
      sendAheadBlocks: 2,
    };
    h.send.mockResolvedValue({ kind: "waiting", report });
    const result = await write({
      route: await aheadRoute(LATEST_TIME + 36),
      rpcManager: chainManager(),
    });
    expect(result).toEqual({
      success: true,
      route: "waiting",
      included: false,
      ...report,
    });
  });

  describe("a Max Fee the worst-case base fee projection passes over", () => {
    const gwei = (value: number): bigint => BigInt(Math.round(value * 1e9));
    // Half-full blocks: the base fee stays flat at `baseFee`, which eth_feeHistory gives as the next one.
    const feeChain = (baseFee: bigint) =>
      ({
        executeWithFailover: async (
          operation: (provider: unknown) => Promise<unknown>
        ) =>
          await operation({
            send: async (method: string) =>
              method === "eth_feeHistory"
                ? {
                    baseFeePerGas: [
                      ethers.toBeHex(baseFee),
                      ethers.toBeHex(baseFee),
                    ],
                  }
                : null,
            getBlock: async (tag: unknown) =>
              tag === "latest"
                ? {
                    number: LATEST,
                    timestamp: LATEST_TIME,
                    parentHash: "0xp",
                    baseFeePerGas: baseFee,
                    gasUsed: BigInt(15_000_000),
                    gasLimit: BigInt(30_000_000),
                  }
                : { number: LATEST - 1, timestamp: LATEST_TIME - 12 },
          }),
      }) as never;

    async function capRoute(notBefore: number): Promise<BundleRoute> {
      const prepared = await prepare({
        config: { notBefore, sendAheadBlocks: 3, bundleBlocks: 2 },
      });
      if (!prepared.ok) {
        throw new Error("expected a route");
      }
      return prepared.route;
    }

    beforeEach(() => {
      h.send.mockImplementation(async (...args: unknown[]) =>
        h.realSend?.(...args)
      );
    });

    it("waits when every target from U is fee-skipped: nothing signed, value released", async () => {
      // U = 999 + 60 / 12 = 1004 = latest + 4; 10 gwei x (9/8)^3 > 12.5 gwei there.
      const result = await write({
        route: await capRoute(LATEST_TIME - 12 + 60),
        rpcManager: feeChain(gwei(10)),
        gas: { maxFeeOverride: gwei(12.5) },
      });
      expect(result).toEqual({
        success: true,
        route: "waiting",
        included: false,
        bundleTargetsSkipped: [
          { block: 1004, reason: "max-fee-below-projected-base-fee" },
          { block: 1005, reason: "max-fee-below-projected-base-fee" },
        ],
        notBefore: LATEST_TIME + 48,
        firstAllowedBlock: 1004,
        latestBlock: LATEST,
        sendAheadBlocks: 3,
      });
      expect(h.sessions).toBe(1);
      expect(h.signs).toBe(0);
      expect(bundleReservationEnd(result)).toBe("release");
      expect(waitingStepSentence(result)).toContain("Max Fee held back");
    });

    it("waits, not fails, on a cap below the next base fee when the targets start past the next block", async () => {
      h.realCapCheck = true;
      // U = latest + 4: the pre-lock check leaves the cap to the in-session projection.
      const result = await write({
        route: await capRoute(LATEST_TIME - 12 + 60),
        rpcManager: feeChain(gwei(10)),
        gas: { maxFeeOverride: gwei(9.9) },
      });
      expect(result).toMatchObject({
        success: true,
        route: "waiting",
        firstAllowedBlock: 1004,
        bundleTargetsSkipped: [
          { block: 1004, reason: "max-fee-below-projected-base-fee" },
          { block: 1005, reason: "max-fee-below-projected-base-fee" },
        ],
      });
      expect(h.capChecks).toBe(0);
      expect(h.signs).toBe(0);
      expect(bundleReservationEnd(result)).toBe("release");
    });

    it("still fails that cap before the lock when the first target is the next block", async () => {
      h.realCapCheck = true;
      // U = 999 + 24 / 12 = 1001 = latest + 1.
      const result = await write({
        route: await capRoute(LATEST_TIME + 12),
        rpcManager: feeChain(gwei(10)),
        gas: { maxFeeOverride: gwei(9.9) },
      });
      expect(result).toEqual({
        success: false,
        error:
          "Max fee 9.9 gwei is below the next block's base fee of 10.0 gwei, so the transaction could not be included. Raise the max fee or leave it empty.",
        errorClass: ExecutionErrorType.EXTERNAL,
      });
      expect(h.capChecks).toBe(1);
      expect(h.sessions).toBe(0);
      expect(h.signs).toBe(0);
      expect(bundleReservationEnd(result)).toBe("release");
    });

    it("waits at latest + 2 when the projection one block on passes over the cap", async () => {
      h.realCapCheck = true;
      // U = 999 + 36 / 12 = 1002 = latest + 2; 10 gwei x 9/8 = 11.25 gwei there.
      const result = await write({
        route: await capRoute(LATEST_TIME + 24),
        rpcManager: feeChain(gwei(10)),
        gas: { maxFeeOverride: gwei(11) },
      });
      expect(result).toMatchObject({
        success: true,
        route: "waiting",
        firstAllowedBlock: 1002,
        latestBlock: LATEST,
      });
      // Sending ahead from latest + 2 leaves the cap to the session.
      expect(h.capChecks).toBe(0);
      expect(h.sessions).toBe(1);
      expect(h.signs).toBe(0);
      expect(bundleReservationEnd(result)).toBe("release");
    });

    it("still refuses at latest + 1, where the base fee is exact, as a network failure", async () => {
      // U = 999 + 24 / 12 = 1001 = latest + 1; its base fee 13 gwei is above the cap.
      const result = await write({
        route: await capRoute(LATEST_TIME + 12),
        rpcManager: feeChain(gwei(13)),
        gas: { maxFeeOverride: gwei(12.5) },
      });
      expect(result).toMatchObject({
        success: false,
        errorClass: ExecutionErrorType.EXTERNAL,
        broadcastAttempted: false,
        error:
          "Max fee 12.5 gwei is below the base fee the target blocks may reach (13 gwei), so nothing was sent. Raise the max fee or leave it empty.",
      });
      expect(h.signs).toBe(0);
      expect(bundleReservationEnd(result)).toBe("release");
      expect(applyFailOnError(result, false)).toMatchObject({
        success: true,
        error: expect.stringContaining("Max fee 12.5 gwei"),
      });
    });
  });

  it("fails before the lock when the latest block cannot be read", async () => {
    const result = await write({
      route: await aheadRoute(LATEST_TIME + 60),
      rpcManager: chainManager(true),
    });
    expect(result).toMatchObject({
      success: false,
      errorClass: ExecutionErrorType.EXTERNAL,
      broadcastAttempted: false,
      error: expect.stringContaining("check Not before"),
    });
    expect(h.sessions).toBe(0);
  });

  it("says the RPC lags the block trigger when it never reaches the trigger block", async () => {
    const { TriggerBlockNotReachedError } = await import(
      "@/lib/web3/next-block-simulation"
    );
    const lagging = {
      executeWithFailover: async () => {
        throw new TriggerBlockNotReachedError("behind");
      },
    } as never;
    const result = await write({
      route: await aheadRoute(LATEST_TIME + 60),
      rpcManager: lagging,
      triggerBlock: { chainId: 1, number: 2000 },
    });
    expect(result).toMatchObject({
      success: false,
      errorClass: ExecutionErrorType.EXTERNAL,
      error: expect.stringContaining(
        "has not reached the block that triggered"
      ),
    });
  });

  // A run-time Not before refusal is data on the route; the step fails with it after the in-flight check.
  async function refusedRoute(config: Record<string, unknown>) {
    const prepared = await prepare({ config });
    if (!prepared.ok) {
      throw new Error("expected a route");
    }
    expect(prepared.route.settings.sendAhead).toBeUndefined();
    return prepared.route;
  }

  const unsent = (error: unknown) => ({
    success: false,
    errorClass: ExecutionErrorType.USER,
    broadcastAttempted: false,
    error,
  });

  it("refuses a run-time Not before that looks like milliseconds", async () => {
    const result = await write({
      route: await refusedRoute({ notBefore: "1796126400000" }),
      rpcManager: chainManager(),
    });
    expect(result).toEqual(
      unsent(expect.stringContaining("Use seconds: 1796126400."))
    );
  });

  it("fails a templated Not before that the run filled in empty, nothing sent", async () => {
    // The executor marks a Not before saved as a template; it rendered "".
    const result = await write({
      route: await refusedRoute({
        notBefore: "",
        _notBeforeFromTemplate: true,
      }),
      rpcManager: chainManager(),
    });
    expect(result).toEqual(
      unsent(
        "Not before (notBefore) resolved to an empty value, so nothing was sent."
      )
    );
    expect(h.sessions).toBe(0);
    expect(h.send).not.toHaveBeenCalled();
    // Left empty in the editor: no Not before, sends as without it.
    const plain = await prepare({ config: { notBefore: "" } });
    expect(plain.ok && plain.route.settings).not.toHaveProperty(
      "notBeforeRefusal"
    );
  });

  it.each([
    [
      "0",
      true,
      "Not before (notBefore) resolved to 0, which usually means the time is not set yet, so nothing was sent.",
    ],
    [
      0,
      false,
      "Not before (notBefore) resolved to 0, which usually means the time is not set yet, so nothing was sent.",
    ],
    [
      "3600",
      true,
      "Not before (notBefore) resolved to 3600, which looks like a duration or block number, not a unix time, so nothing was sent.",
    ],
    [
      19_000_000,
      false,
      "Not before (notBefore) resolved to 19000000, which looks like a duration or block number, not a unix time, so nothing was sent.",
    ],
    [
      "999999999",
      true,
      "Not before (notBefore) resolved to 999999999, which looks like a duration or block number, not a unix time, so nothing was sent.",
    ],
    [
      "10000000000",
      true,
      "Not before (notBefore) resolved to 10000000000, which is past the year 2286 and is not a unix time (an amount, or a 'never' value such as the largest uint256), so nothing was sent.",
    ],
    [
      10_000_000_000,
      false,
      "Not before (notBefore) resolved to 10000000000, which is past the year 2286 and is not a unix time (an amount, or a 'never' value such as the largest uint256), so nothing was sent.",
    ],
  ])(
    "fails a run-time Not before of %j (template: %s), nothing sent",
    async (notBefore, fromTemplate, error) => {
      const result = await write({
        route: await refusedRoute({
          notBefore,
          ...(fromTemplate && { _notBeforeFromTemplate: true }),
        }),
        rpcManager: chainManager(),
      });
      expect(result).toEqual(unsent(error));
      expect(h.sessions).toBe(0);
      expect(h.send).not.toHaveBeenCalled();
    }
  );

  it("names a huge resolved Not before as it came, not in exponent form", async () => {
    const huge =
      "115792089237316195423570985008687907853269984665640564039457584007913129639935";
    const result = await write({
      route: await refusedRoute({
        notBefore: huge,
        _notBeforeFromTemplate: true,
      }),
      rpcManager: chainManager(),
    });
    expect(result).toMatchObject({
      success: false,
      error: expect.stringMatching(
        /^Not before \(notBefore\) resolved to 1157920892373161954235709850086879078532\.\.\., which is past the year 2286/
      ),
    });
  });

  it("takes both run-time boundaries", async () => {
    for (const notBefore of ["1000000000", "9999999999"]) {
      const prepared = await prepare({
        config: { notBefore, _notBeforeFromTemplate: true },
      });
      expect(prepared.ok && prepared.route.settings.sendAhead).toEqual({
        notBefore: Number(notBefore),
        blocks: 2,
      });
    }
  });

  it.each([
    ["templated 0", { notBefore: "0", _notBeforeFromTemplate: true }],
    ["templated empty", { notBefore: "", _notBeforeFromTemplate: true }],
  ])(
    "a replay of a landed step with a %s Not before returns the landed result",
    async (_name, config) => {
      // The contract cleared its unlock time after the bundle landed.
      replayReceipt = {
        blockNumber: 50,
        status: 1,
        gasUsed: BigInt(40_000),
        gasPrice: BigInt(11),
      };
      h.inFlight.mockResolvedValue({
        kind: "replay",
        nonce: 7,
        landedHash: "0xab",
      });
      const result = await write({
        route: await refusedRoute(config),
        rpcManager: chainManager(),
      });
      expect(result).toMatchObject({
        success: true,
        route: "bundle",
        included: true,
        transactionHash: "0xab",
      });
      expect(h.send).not.toHaveBeenCalled();
    }
  );

  it("another run's bundle in flight with a templated 0 Not before ends skipped in flight", async () => {
    h.inFlight.mockResolvedValue({ kind: "other", untilBlock: 15 });
    const result = await write({
      route: await refusedRoute({
        notBefore: "0",
        _notBeforeFromTemplate: true,
      }),
      rpcManager: chainManager(),
    });
    expect(result).toMatchObject({
      success: true,
      route: "skipped-in-flight",
      inFlightUntilBlock: 15,
    });
  });

  it("refuses Not before on a network without fixed slots, before reading any block", async () => {
    const prepared = await prepareBundleRoute({
      organizationId: "org-1",
      chainId: 42_161,
      context: CONTEXT,
      config: { notBefore: 1_796_126_400 },
    });
    expect(!prepared.ok && prepared.failure).toMatchObject({
      errorClass: ExecutionErrorType.USER,
      error: expect.stringMatching(
        /^Not before is not supported on this network\. Nothing was sent\./
      ),
    });
    // A run-time Not before that is refused still meets the network check first.
    for (const notBefore of ["0", ""]) {
      const templated = await prepareBundleRoute({
        organizationId: "org-1",
        chainId: 42_161,
        context: CONTEXT,
        config: { notBefore, _notBeforeFromTemplate: true },
      });
      expect(!templated.ok && templated.failure).toMatchObject({
        errorClass: ExecutionErrorType.USER,
        error: expect.stringMatching(
          /^Not before is not supported on this network\. Nothing was sent\./
        ),
      });
    }
    // Without Not before the same network still bundles.
    const plain = await prepareBundleRoute({
      organizationId: "org-1",
      chainId: 42_161,
      context: CONTEXT,
      config: {},
    });
    expect(plain.ok).toBe(true);
  });
});
