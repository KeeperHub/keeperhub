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
vi.mock("@/lib/web3/bundles/send-bundle", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/web3/bundles/send-bundle")>()),
  sendBundleInSession: (...args: unknown[]) => h.send(...args),
}));
vi.mock("@/lib/web3/gas-preflight", () => ({
  preflightGasBalance: async () =>
    h.affordable
      ? { affordable: true }
      : { affordable: false, message: "Insufficient funds for gas" },
}));
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
    return await fn({ currentNonce: 1 });
  },
}));
vi.mock("@/lib/web3/wallet-helpers", () => ({
  initializeWalletSigner: async () => ({ provider: {} }),
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
import { bundleReservationEnd } from "@/lib/workflow/executor/run-outcome-keys";
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
      skippedInFlight: true,
      notIncluded: false,
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
      skippedInFlight: false,
      notIncluded: true,
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
      skippedInFlight: false,
      notIncluded: true,
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
      skippedInFlight: false,
      notIncluded: false,
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
