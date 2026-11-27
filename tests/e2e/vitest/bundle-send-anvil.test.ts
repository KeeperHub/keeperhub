/**
 * Send as Bundle end to end against anvil and two in-process fake builders.
 *
 * The Write Contract step runs for real (step logging, nonce session, bundle
 * client, inclusion watcher, finalize); only the org context, the signer
 * (an anvil key in place of Turnkey) and the Web3 connection are stubbed.
 * The fake builders check X-Flashbots-Signature; the miner drives anvil one
 * block at a time and includes a bundle only at its target block, only when
 * its transaction does not revert there; anvil's own receipt is the fee check.
 * It takes the first valid bundle in builder order, not the highest tip, so
 * these cases do not cover a builder auction.
 *
 * Needs Postgres (DATABASE_URL, migrated) and anvil on 127.0.0.1:8546; the
 * SSRF guard must be in shadow mode (SAFE_FETCH_SHADOW=true) to reach the
 * fake builders on loopback. Anvil's interval mining is turned off for the
 * run and restored afterwards.
 */
import "dotenv/config";
import { and, eq } from "drizzle-orm";
import { ethers } from "ethers";
import postgres from "postgres";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  anvilRpc,
  type FakeBuilder,
  type Miner,
  type RpcProxy,
  startFakeBuilder,
  startMiner,
  startRpcProxy,
} from "./helpers/fake-builder";

const env = vi.hoisted(() => {
  const searcherKey = `0x${"5e".repeat(32)}`;
  process.env.BUNDLE_SEND_ROLLOUT = "all";
  process.env.BUNDLE_SEARCHER_PRIVATE_KEY = searcherKey;
  return {
    searcherKey,
    orgId: "",
    userId: "",
    signerKind: "eoa" as "eoa" | "safe",
    walletKey: "",
  };
});

vi.mock("server-only", () => ({}));
vi.unmock("@/lib/db");

vi.mock("@/lib/web3/resolve-org-context", () => ({
  resolveOrganizationContext: async () => ({
    success: true,
    organizationId: env.orgId,
    userId: env.userId,
  }),
}));
vi.mock("@/lib/web3/wallet-helpers", async (importOriginal) => {
  const { ethers: e } = await import("ethers");
  return {
    ...(await importOriginal<typeof import("@/lib/web3/wallet-helpers")>()),
    getOrganizationWalletAddress: async () =>
      new e.Wallet(env.walletKey).address,
    initializeWalletSigner: async (_org: string, rpcUrl: string) =>
      new e.Wallet(
        env.walletKey,
        new e.JsonRpcProvider(rpcUrl, 31_337, { staticNetwork: true })
      ),
  };
});
vi.mock("@/lib/safe/signer-resolver", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/safe/signer-resolver")>();
  return {
    ...actual,
    resolveSignerForNode: async () =>
      env.signerKind === "eoa"
        ? {
            kind: "eoa",
            ownerAddress: new ethers.Wallet(env.walletKey).address,
          }
        : {
            kind: "safe",
            ownerAddress: new ethers.Wallet(env.walletKey).address,
            safeAddress: `0x${"5a".repeat(20)}`,
            safeWalletId: "safe-1",
          },
  };
});

const ANVIL_URL = process.env.ANVIL_URL ?? "http://127.0.0.1:8546";
const CHAIN_ID = 31_337;
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const PREFIX = `bse_${Date.now().toString(36)}_`;
const WORKFLOW_ID = `${PREFIX}wf`;
const RICH_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

// A contract with kick() (counts in slot 1; reverts while slot 0 is set or
// before block number slot 2) and close() (sets slot 0).
const ABI = ["function kick()", "function close()"];
function gateInitCode(): string {
  const close = ethers.id("close()").slice(2, 10);
  const runtime = [
    // selector == close() ? jump 0x2c
    `60003560e01c63${close}14602c57`,
    // slot 0 set ? jump 0x27 (revert)
    "600054602757",
    // slot 2 > block.number ? jump 0x27 (revert)
    "4360025411602757",
    // slot 1 += 1; stop
    "60015460010160015500",
    // 0x27: revert(0, 0)
    "5b600080fd",
    // 0x2c: slot 0 = 1; stop
    "5b600160005500",
  ].join("");
  return `0x603380600b6000396000f3${runtime}`;
}

async function anvilUp(): Promise<boolean> {
  try {
    const id = await anvilRpc<string>(ANVIL_URL, "eth_chainId");
    return Number(id) === CHAIN_ID;
  } catch {
    return false;
  }
}

const SKIP =
  !DATABASE_URL ||
  process.env.SKIP_INFRA_TESTS === "true" ||
  process.env.SAFE_FETCH_SHADOW !== "true" ||
  !(await anvilUp());

type Step = typeof import("@/plugins/web3/steps/write-contract");
type Logging = typeof import("@/lib/workflow/executor/logging");
type Schema = typeof import("@/lib/db/schema");
type Ext = typeof import("@/lib/db/schema-extensions");
type Nonces = typeof import("@/lib/web3/nonce-manager");
type Providers = typeof import("@/lib/rpc/provider-factory");
type Db = typeof import("@/lib/db").db;
type Alerts = typeof import("@/lib/notifications/failure-alerts/streak");
type AlertRuns =
  typeof import("@/lib/notifications/failure-alerts/streak-runs");
type StepResult = Awaited<ReturnType<Step["writeContractStep"]>>;

let db: Db;
let schema: Schema;
let ext: Ext;
let step: Step;
let logging: Logging;
let nonces: Nonces;
let providers: Providers;
let alerts: Alerts;
let alertRuns: AlertRuns;
let builders: FakeBuilder[];
let miner: Miner;
let gate: string;
let wallet: ethers.Wallet;
let insertedChain = false;
let proxy: RpcProxy;
let saved: { interval: number; automine: boolean };
let seq = 0;
// Every log line the code under test wrote, for the secrets check.
const logLines: string[] = [];

const searcher = new ethers.Wallet(env.searcherKey);

async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
  return await anvilRpc<T>(ANVIL_URL, method, params);
}

async function balance(): Promise<bigint> {
  return BigInt(
    await rpc<string>("eth_getBalance", [wallet.address, "latest"])
  );
}

async function kicks(): Promise<number> {
  return Number(await rpc<string>("eth_getStorageAt", [gate, "0x1", "latest"]));
}

async function newRun(): Promise<string> {
  seq += 1;
  const id = `${PREFIX}run${seq}`;
  await db.insert(schema.workflowExecutions).values({
    id,
    workflowId: WORKFLOW_ID,
    userId: env.userId,
    status: "running",
  });
  return id;
}

async function runStep(
  executionId: string,
  config: Record<string, unknown> = {}
): Promise<StepResult> {
  return await step.writeContractStep({
    network: String(CHAIN_ID),
    contractAddress: gate,
    abi: new ethers.Interface(ABI).formatJson(),
    abiFunction: "kick",
    functionArgs: "[]",
    sendMode: "bundle",
    priorityFeeGwei: "1",
    ...config,
    _context: {
      executionId,
      nodeId: "kick-1",
      nodeName: "Kick",
      nodeType: "web3/write-contract",
      organizationId: env.orgId,
      workflowId: WORKFLOW_ID,
    },
  } as Parameters<Step["writeContractStep"]>[0]);
}

async function finalize(executionId: string) {
  await logging.logWorkflowCompleteDb({
    executionId,
    status: "success",
    startTime: Date.now() - 1000,
  });
  const [row] = await db
    .select()
    .from(schema.workflowExecutions)
    .where(eq(schema.workflowExecutions.id, executionId));
  return row;
}

async function rowAt(nonce: number) {
  const [row] = await db
    .select()
    .from(ext.pendingTransactions)
    .where(
      and(
        // The nonce manager keys rows by the lowercase address.
        eq(ext.pendingTransactions.walletAddress, wallet.address.toLowerCase()),
        eq(ext.pendingTransactions.chainId, CHAIN_ID),
        eq(ext.pendingTransactions.nonce, nonce)
      )
    );
  return row;
}

async function minedNonce(): Promise<number> {
  return Number(
    await rpc<string>("eth_getTransactionCount", [wallet.address, "latest"])
  );
}

// Every builder in one mode.
function setModes(...modes: FakeBuilder["mode"][]): void {
  for (const [index, builder] of builders.entries()) {
    builder.mode = modes[index] ?? modes[0];
  }
}

// Everything the step may never show: builder URLs, the searcher key and address.
function expectNoSecrets(value: unknown): void {
  const text = JSON.stringify(value).toLowerCase();
  for (const builder of builders) {
    expect(text).not.toContain(builder.url.toLowerCase());
  }
  expect(text).not.toContain(env.searcherKey.slice(2));
  expect(text).not.toContain(searcher.address.slice(2).toLowerCase());
}

async function cleanup(): Promise<void> {
  const client = postgres(DATABASE_URL, { max: 1 });
  try {
    if (wallet) {
      const address = wallet.address.toLowerCase();
      await client`DELETE FROM pending_transactions WHERE wallet_address = ${address}`;
      await client`DELETE FROM wallet_locks WHERE wallet_address = ${address}`;
    }
    await client`DELETE FROM workflow_execution_logs WHERE execution_id LIKE ${`${PREFIX}%`}`;
    await client`DELETE FROM workflow_executions WHERE workflow_id LIKE ${`${PREFIX}%`}`;
    await client`DELETE FROM workflows WHERE id LIKE ${`${PREFIX}%`}`;
    await client`DELETE FROM organization WHERE id LIKE ${`${PREFIX}%`}`;
    await client`DELETE FROM users WHERE id LIKE ${`${PREFIX}%`}`;
    if (insertedChain) {
      await client`DELETE FROM chains WHERE chain_id = ${CHAIN_ID}`;
    }
  } finally {
    await client.end();
  }
}

// Sends a transaction from anvil's rich account and mines it.
async function sendAndMine(
  tx: ethers.TransactionRequest
): Promise<ethers.TransactionReceipt> {
  const provider = new ethers.JsonRpcProvider(ANVIL_URL, CHAIN_ID, {
    staticNetwork: true,
  });
  const rich = new ethers.Wallet(RICH_KEY, provider);
  const sent = await rich.sendTransaction(tx);
  await miner.mine(1);
  const receipt = await provider.getTransactionReceipt(sent.hash);
  provider.destroy();
  if (!receipt) {
    throw new Error("not mined");
  }
  return receipt;
}

describe.skipIf(SKIP)("Send as Bundle (anvil, fake builders)", () => {
  beforeAll(async () => {
    vi.resetModules();
    ({ db } = await import("@/lib/db"));
    schema = await import("@/lib/db/schema");
    ext = await import("@/lib/db/schema-extensions");
    step = await import("@/plugins/web3/steps/write-contract");
    logging = await import("@/lib/workflow/executor/logging");
    nonces = await import("@/lib/web3/nonce-manager");
    providers = await import("@/lib/rpc/provider-factory");
    alerts = await import("@/lib/notifications/failure-alerts/streak");
    alertRuns = await import("@/lib/notifications/failure-alerts/streak-runs");
    const { rawConsole } = await import("@/lib/log/core");
    for (const level of ["debug", "info", "warn", "error"] as const) {
      vi.spyOn(rawConsole, level).mockImplementation((...args: unknown[]) => {
        logLines.push(args.map(String).join(" "));
      });
    }

    saved = {
      interval: await rpc<number>("anvil_getIntervalMining"),
      automine: await rpc<boolean>("anvil_getAutomine"),
    };
    await rpc("evm_setIntervalMining", [0]);
    await rpc("evm_setAutomine", [false]);

    env.walletKey = ethers.Wallet.createRandom().privateKey;
    wallet = new ethers.Wallet(env.walletKey);
    env.userId = `${PREFIX}user`;
    env.orgId = `${PREFIX}org`;
    await cleanup();

    builders = [
      await startFakeBuilder("fake-a", searcher.address),
      await startFakeBuilder("fake-b", searcher.address),
    ];
    miner = startMiner(ANVIL_URL, builders);
    proxy = await startRpcProxy(ANVIL_URL);

    const [existing] = await db
      .select({ id: schema.chains.id })
      .from(schema.chains)
      .where(eq(schema.chains.chainId, CHAIN_ID));
    if (existing) {
      throw new Error(
        "This test owns chain 31337's row; remove the existing one first"
      );
    }
    await db.insert(schema.chains).values({
      chainId: CHAIN_ID,
      name: "Anvil bundle test",
      symbol: "ETH",
      defaultPrimaryRpc: proxy.url,
      isTestnet: true,
      bundleBuilders: builders.map((b) => ({
        name: b.name,
        url: b.url,
        supportsMinTimestamp: false,
      })),
    });
    insertedChain = true;

    await db.insert(schema.users).values({
      id: env.userId,
      name: "bundle e2e",
      email: `${PREFIX}@bundle.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(schema.organization).values({
      id: env.orgId,
      name: "Bundle e2e",
      slug: env.orgId.replaceAll("_", "-"),
      createdAt: new Date(),
    });
    await db.insert(schema.workflows).values({
      id: WORKFLOW_ID,
      name: WORKFLOW_ID,
      userId: env.userId,
      organizationId: env.orgId,
      nodes: [],
      edges: [],
    });

    await rpc("anvil_setBalance", [
      wallet.address,
      ethers.toQuantity(ethers.parseEther("10")),
    ]);
    const deployed = await sendAndMine({
      data: gateInitCode(),
      maxFeePerGas: ethers.parseUnits("50", "gwei"),
      maxPriorityFeePerGas: ethers.parseUnits("1", "gwei"),
    });
    gate = deployed.contractAddress ?? "";
    expect(await rpc<string>("eth_getCode", [gate, "latest"])).not.toBe("0x");
  }, 60_000);

  afterAll(async () => {
    await miner?.stop();
    for (const builder of builders ?? []) {
      await builder.close();
    }
    await proxy?.close();
    if (saved) {
      await rpc("evm_setAutomine", [saved.automine]);
      await rpc("evm_setIntervalMining", [saved.interval]);
    }
    await cleanup();
  }, 30_000);

  beforeEach(async () => {
    env.signerKind = "eoa";
    miner.includeIf = () => true;
    miner.beforeBlock = undefined;
    miner.tickMs = 300;
    for (const builder of builders) {
      builder.mode = "accept";
      builder.received = [];
    }
    miner.rejected = [];
    await rpc("anvil_setStorageAt", [gate, "0x0", ethers.ZeroHash]);
    await rpc("anvil_setStorageAt", [gate, "0x2", ethers.ZeroHash]);
  });

  afterEach(() => {
    // The miner never swallows an error driving anvil.
    expect(miner.errors).toEqual([]);
  });

  it("refuses a Safe connection before anything is signed or sent", async () => {
    env.signerKind = "safe";
    const executionId = await newRun();
    const nonce = await minedNonce();
    const result = await runStep(executionId);
    expect(result).toMatchObject({
      success: false,
      errorClass: "user",
      broadcastAttempted: false,
    });
    expect(!result.success && result.error).toContain("Safe or Roles");
    expect(builders.every((b) => b.received.length === 0)).toBe(true);
    expect(await rowAt(nonce)).toBeUndefined();
  }, 30_000);

  it("fails with an external error when no builder accepts, and frees the nonce", async () => {
    for (const builder of builders) {
      builder.mode = "refuse";
    }
    const executionId = await newRun();
    const nonce = await minedNonce();
    const result = await runStep(executionId);
    expect(result).toMatchObject({
      success: false,
      errorClass: "external",
      route: "bundle",
      included: false,
      broadcastAttempted: true,
      builders: [
        { name: "fake-a", accepted: false },
        { name: "fake-b", accepted: false },
      ],
    });
    expect(result).not.toHaveProperty("transactionHash");
    expect((await rowAt(nonce))?.status).toBe("dropped");
    expectNoSecrets(result);

    // It is a failure the alert streak counts.
    await logging.logWorkflowCompleteDb({
      executionId,
      status: "error",
      error: result.success ? "" : result.error,
      errorClass: result.success ? undefined : result.errorClass,
      startTime: Date.now() - 1000,
    });
    const summary = alerts.summarizeStreak(
      await alertRuns.loadStreakRuns(WORKFLOW_ID, 10),
      null,
      10
    );
    expect(summary.lastFailedRunId).toBe(executionId);
    expect(summary.failures).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it("lands at the first target block, confirms the nonce and settles the run as success", async () => {
    const executionId = await newRun();
    const nonce = await minedNonce();
    const before = await kicks();
    const result = await runStep(executionId);
    expect(result).toMatchObject({
      success: true,
      route: "bundle",
      included: true,
      chainId: CHAIN_ID,
      targetTipsGwei: ["1", "1", "1"],
      builders: [
        { name: "fake-a", accepted: true },
        { name: "fake-b", accepted: true },
      ],
    });
    if (!result.success) {
      return;
    }
    expect(result.includedBlock).toBe(result.targetBlocks?.[0]);
    expect(miner.included.at(-1)).toEqual({
      block: result.includedBlock,
      hash: result.transactionHash,
    });
    expect(builders.every((b) => b.badSignatures === 0)).toBe(true);
    expect(await kicks()).toBe(before + 1);
    expect(await rowAt(nonce)).toMatchObject({
      status: "confirmed",
      txHash: result.transactionHash,
    });
    expectNoSecrets(result);

    const run = await finalize(executionId);
    expect(run?.status).toBe("success");
    expect(run?.error).toBeNull();
    expect(run?.transactionHashes?.map((entry) => entry.hash)).toEqual([
      result.transactionHash,
    ]);
  }, 60_000);

  it("raises the tip 20% per target and pays 1.44x at the third", async () => {
    await rpc("anvil_setNextBlockBaseFeePerGas", [
      ethers.toQuantity(ethers.parseUnits("2", "gwei")),
    ]);
    await miner.mine(1);
    miner.includeIf = (target, first) => target === first + 2;
    const executionId = await newRun();
    const result = await runStep(executionId, {
      bundleTipIncreasePercent: 20,
    });
    expect(result).toMatchObject({
      success: true,
      included: true,
      targetTipsGwei: ["1", "1.2", "1.44"],
    });
    if (!result.success) {
      return;
    }
    expect(result.includedBlock).toBe(result.targetBlocks?.[2]);
    const tips = builders[0].received
      .sort((a, b) => a.target - b.target)
      .map(
        (bundle) => ethers.Transaction.from(bundle.raw).maxPriorityFeePerGas
      );
    const gwei = (v: string) => ethers.parseUnits(v, "gwei");
    expect(tips).toEqual([gwei("1"), gwei("1.2"), gwei("1.44")]);
    // On chain: the effective price over the block's base fee is the third tip.
    const receipt = await rpc<{
      effectiveGasPrice: string;
      blockNumber: string;
    }>("eth_getTransactionReceipt", [result.transactionHash]);
    const block = await rpc<{ baseFeePerGas: string }>("eth_getBlockByNumber", [
      receipt.blockNumber,
      false,
    ]);
    expect(
      BigInt(receipt.effectiveGasPrice) - BigInt(block.baseFeePerGas)
    ).toBe(gwei("1.44"));
  }, 60_000);

  it("not picked: success with no hash, the nonce reused next, the run not landed", async () => {
    for (const builder of builders) {
      builder.mode = "decline";
    }
    const executionId = await newRun();
    const nonce = await minedNonce();
    const before = await balance();
    const result = await runStep(executionId);
    expect(result).toMatchObject({
      success: true,
      route: "bundle",
      included: false,
      notIncludedReason: "not-picked",
    });
    expect(result).not.toHaveProperty("transactionHash");
    expect(await balance()).toBe(before);
    expect((await rowAt(nonce))?.status).toBe("dropped");
    expectNoSecrets(result);

    const run = await finalize(executionId);
    expect(run?.status).toBe("not_landed");
    expect(run?.error).toContain("Not landed: a bundle in this run");
    expect(run?.transactionHashes).toEqual([]);

    // The next run signs at the same nonce.
    for (const builder of builders) {
      builder.mode = "accept";
      builder.received = [];
    }
    const next = await runStep(await newRun());
    expect(next).toMatchObject({ success: true, included: true });
    expect(next.success && (await rowAt(nonce))?.txHash).toBe(
      next.success ? next.transactionHash : undefined
    );
  }, 90_000);

  it("no longer needed: state changed under the bundle, it never lands and costs zero gas", async () => {
    miner.beforeBlock = async () => {
      // Another party closes the gate before the first target is built.
      await rpc("anvil_setStorageAt", [gate, "0x0", ethers.toBeHex(1, 32)]);
    };
    const executionId = await newRun();
    const before = await balance();
    const includedBefore = miner.included.length;
    const result = await runStep(executionId);
    expect(result).toMatchObject({
      success: true,
      included: false,
      notIncludedReason: "no-longer-needed",
    });
    expect(result).not.toHaveProperty("transactionHash");
    expect(miner.included).toHaveLength(includedBefore);
    expect(await balance()).toBe(before);
    expect((await finalize(executionId))?.status).toBe("not_landed");
  }, 60_000);

  it("skips a second run while the first run's bundle may still land, without the lock", async () => {
    for (const builder of builders) {
      builder.mode = "decline";
    }
    miner.tickMs = 1500;
    const first = runStep(await newRun());
    await vi.waitFor(
      () => {
        expect(builders[0].received.length).toBe(3);
      },
      { timeout: 20_000, interval: 50 }
    );
    const secondId = await newRun();
    const second = await runStep(secondId);
    expect(second).toMatchObject({
      success: true,
      route: "skipped-in-flight",
      included: false,
      inFlightUntilBlock: expect.any(Number),
    });
    expect(builders[0].received).toHaveLength(3);

    const run = await finalize(secondId);
    expect(run?.status).toBe("skipped");
    expect(run?.error).toContain("Any other steps still ran");
    expect(await first).toMatchObject({ success: true, included: false });
  }, 90_000);

  it("re-settles a not landed run when its bundle is mined later", async () => {
    for (const builder of builders) {
      builder.mode = "decline";
    }
    const executionId = await newRun();
    const nonce = await minedNonce();
    const result = await runStep(executionId);
    expect(result).toMatchObject({ success: true, included: false });
    expect((await finalize(executionId))?.status).toBe("not_landed");

    // A builder includes the signed transaction after all, past its targets.
    const late = builders[0].received[0];
    await rpc("eth_sendRawTransaction", [late.raw]);
    await miner.mine(5);
    expect(await minedNonce()).toBe(nonce + 1);

    // The wallet's next session finds it and settles the run.
    const rpcManager = await providers.getRpcProvider({ chainId: CHAIN_ID });
    const manager = nonces.getNonceManager();
    const { session } = await manager.startSession(
      wallet.address,
      CHAIN_ID,
      `${PREFIX}next`,
      rpcManager
    );
    await manager.endSession(session);

    const [run] = await db
      .select()
      .from(schema.workflowExecutions)
      .where(eq(schema.workflowExecutions.id, executionId));
    expect(run?.status).toBe("success");
    expect(run?.error).toBeNull();
    expect(run?.transactionHashes).toEqual([
      expect.objectContaining({
        hash: late.hash,
        nodeId: "kick-1",
        receiptStatus: "success",
      }),
    ]);
    expect(await rowAt(nonce)).toMatchObject({
      status: "confirmed",
      txHash: late.hash,
    });
  }, 90_000);

  it("keeps watching on unknown answers (late, null result) and lands; the builders report says unclear", async () => {
    setModes("timeout", "null");
    const result = await runStep(await newRun());
    expect(result).toMatchObject({
      success: true,
      included: true,
      builders: [
        { name: "fake-a", accepted: null, error: "no answer in time" },
        { name: "fake-b", accepted: null, error: "no result" },
      ],
    });
  }, 60_000);

  it("a garbage answer beside a 400 JSON-RPC refusal is not 'no builder accepted': it watches and ends not picked", async () => {
    setModes("garbage", "rpc-error-400");
    miner.includeIf = () => false;
    const result = await runStep(await newRun());
    expect(result).toMatchObject({
      success: true,
      included: false,
      notIncludedReason: "not-picked",
      builders: [
        { name: "fake-a", accepted: null, error: "unreadable answer" },
        { name: "fake-b", accepted: false },
      ],
    });
  }, 60_000);

  it("a 500 answer is unclear, not a refusal", async () => {
    setModes("http500", "decline");
    const result = await runStep(await newRun());
    expect(result).toMatchObject({
      success: true,
      builders: [
        { name: "fake-a", accepted: null, error: "HTTP 500" },
        { name: "fake-b", accepted: true },
      ],
    });
  }, 60_000);

  it("refuses a wallet that cannot hold gas limit x max fee before signing, though the cheap preflight passes", async () => {
    const executionId = await newRun();
    const nonce = await minedNonce();
    await rpc("anvil_setBalance", [
      wallet.address,
      ethers.toQuantity(ethers.parseEther("0.001")),
    ]);
    try {
      const result = await runStep(executionId, { priorityFeeGwei: "1000" });
      expect(result).toMatchObject({
        success: false,
        broadcastAttempted: false,
      });
      expect(!result.success && result.error).toContain("Insufficient ETH");
      expect(builders.every((b) => b.received.length === 0)).toBe(true);
      expect(await rowAt(nonce)).toBeUndefined();
    } finally {
      await rpc("anvil_setBalance", [
        wallet.address,
        ethers.toQuantity(ethers.parseEther("10")),
      ]);
    }
  }, 30_000);

  it("refuses to sign behind a transaction of the wallet still waiting to be mined", async () => {
    const provider = new ethers.JsonRpcProvider(ANVIL_URL, CHAIN_ID, {
      staticNetwork: true,
    });
    const own = new ethers.Wallet(env.walletKey, provider);
    const stuck = await own.sendTransaction({
      to: own.address,
      value: BigInt(1),
      maxFeePerGas: ethers.parseUnits("50", "gwei"),
      maxPriorityFeePerGas: ethers.parseUnits("1", "gwei"),
    });
    try {
      const result = await runStep(await newRun());
      expect(result).toMatchObject({
        success: false,
        errorClass: "external",
        broadcastAttempted: false,
      });
      expect(!result.success && result.error).toContain(
        "still waiting to be mined"
      );
      expect(builders.every((b) => b.received.length === 0)).toBe(true);
    } finally {
      await miner.mine(1);
      expect(await provider.getTransactionReceipt(stuck.hash)).not.toBeNull();
      provider.destroy();
    }
  }, 30_000);

  it("checks for a bundle in flight again under the lock, before signing", async () => {
    const rpcManager = await providers.getRpcProvider({ chainId: CHAIN_ID });
    const manager = nonces.getNonceManager();
    const holder = await manager.startSession(
      wallet.address,
      CHAIN_ID,
      `${PREFIX}holder`,
      rpcManager
    );
    const nonce = await minedNonce();
    const latest = Number(await rpc<string>("eth_blockNumber"));
    const step = runStep(await newRun());
    // The step passes the check before the lock, then waits for it.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const other = `${PREFIX}other`;
    const otherHash = `0x${"ab".repeat(32)}`;
    // Another run's bundle, recorded while the step waited; latest = its last target + 1.
    await db.insert(ext.pendingTransactions).values({
      walletAddress: wallet.address.toLowerCase(),
      chainId: CHAIN_ID,
      nonce,
      txHash: otherHash,
      executionId: other,
      workflowId: WORKFLOW_ID,
      status: "pending",
      lastTargetBlock: latest - 1,
      bundleRuns: [
        {
          executionId: other,
          hashes: [otherHash],
          signedAt: Date.now(),
          node: { id: "kick-1", name: "Kick" },
        },
      ],
    });
    try {
      await manager.endSession(holder.session);
      const result = await step;
      expect(result).toMatchObject({
        success: true,
        route: "skipped-in-flight",
        inFlightUntilBlock: latest + 1,
      });
      expect(builders.every((b) => b.received.length === 0)).toBe(true);
    } finally {
      await db
        .delete(ext.pendingTransactions)
        .where(eq(ext.pendingTransactions.txHash, otherHash));
    }
  }, 60_000);

  it("with a fixed Gas Limit, signs that limit and never estimates gas above it", async () => {
    proxy.requests.length = 0;
    const result = await runStep(await newRun(), {
      gasLimitMultiplier: JSON.stringify({
        mode: "maxGasLimit",
        value: "90000",
      }),
    });
    expect(result).toMatchObject({ success: true, included: true });
    // The target-block check runs eth_estimateGas capped at the fixed limit, as a revert check.
    const estimates = proxy.requests.filter(
      (request) =>
        request.method === "eth_estimateGas" &&
        (request.params[0] as { to?: string }).to?.toLowerCase() ===
          gate.toLowerCase()
    );
    expect(estimates.length).toBeGreaterThan(0);
    for (const request of estimates) {
      expect((request.params[0] as { gas?: string }).gas).toBe(
        ethers.toQuantity(90_000)
      );
    }
    const sent = builders[0].received.map(
      (bundle) => ethers.Transaction.from(bundle.raw).gasLimit
    );
    expect(new Set(sent)).toEqual(new Set([BigInt(90_000)]));
  }, 60_000);

  it("skips a target the call cannot pass yet and lands at target 2 once the chain unlocks it", async () => {
    const latest = Number(await rpc<string>("eth_blockNumber"));
    // kick() reverts before block latest + 2.
    await rpc("anvil_setStorageAt", [
      gate,
      "0x2",
      ethers.toBeHex(latest + 2, 32),
    ]);
    const result = await runStep(await newRun());
    expect(result).toMatchObject({
      success: true,
      included: true,
      targetBlocks: [latest + 2, latest + 3],
      bundleTargetsSkipped: [
        { block: latest + 1, reason: "simulation-failed" },
      ],
      includedBlock: latest + 2,
    });
  }, 60_000);

  it("its not landed runs in a row make the bundles-not-landing streak the alert opens on", async () => {
    setModes("decline");
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const executionId = await newRun();
      const result = await runStep(executionId);
      expect(result).toMatchObject({ included: false });
      expect((await finalize(executionId))?.status).toBe("not_landed");
      ids.push(executionId);
    }
    const runs = await alertRuns.loadStreakRuns(WORKFLOW_ID, 10, {
      notLanded: true,
    });
    expect(alerts.summarizeNotLanding(runs, null, 3)).toMatchObject({
      count: 3,
      lastRunId: ids[2],
    });
    // The failure streak never sees them.
    const failures = await alertRuns.loadStreakRuns(WORKFLOW_ID, 10);
    expect(failures.map((run) => run.id)).not.toContain(ids[0]);
  }, 120_000);

  it("fails as used elsewhere once it finds the wallet's other transaction mined at the bundle's nonce", async () => {
    setModes("decline");
    const nonce = await minedNonce();
    const own = new ethers.Wallet(env.walletKey);
    let sent = false;
    miner.beforeBlock = async () => {
      if (sent) {
        return;
      }
      sent = true;
      // A send from outside KeeperHub takes the nonce before the first target.
      const raw = await own.signTransaction({
        to: own.address,
        value: 0,
        nonce,
        gasLimit: 21_000,
        maxFeePerGas: ethers.parseUnits("100", "gwei"),
        maxPriorityFeePerGas: ethers.parseUnits("2", "gwei"),
        chainId: CHAIN_ID,
        type: 2,
      });
      await rpc("eth_sendRawTransaction", [raw]);
    };
    const result = await runStep(await newRun());
    expect(result).toMatchObject({
      success: false,
      errorClass: "user",
      route: "bundle",
      included: false,
    });
    expect(result.success ? "" : result.error).toContain("outside KeeperHub");
    expect(await minedNonce()).toBe(nonce + 1);
  }, 90_000);

  it("never logs a builder URL, the searcher key or its address", () => {
    expect(
      logLines.some((line) => line.includes("[Bundle] Builder answered"))
    ).toBe(true);
    expectNoSecrets(logLines);
  });
});
