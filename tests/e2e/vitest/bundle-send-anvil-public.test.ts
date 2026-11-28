/**
 * Bundle and public, and Bundle with "Send publicly if still needed", end to
 * end against anvil and two in-process fake builders (helpers/fake-builder).
 * The public copy goes to anvil's pool through the chain's RPC; the miner
 * mines the pool too, so a copy lands from it as on a real chain.
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
// The fake miner keeps 12 s slots, as Ethereum does; anvil itself only guarantees 1 s.
vi.mock("@/lib/web3/beacon-slots", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/web3/beacon-slots")>();
  return {
    ...actual,
    minBlockGapSeconds: (chainId: number) =>
      chainId === 31_337 ? 12 : actual.minBlockGapSeconds(chainId),
  };
});

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
const PREFIX = `bsp_${Date.now().toString(36)}_`;
const WORKFLOW_ID = `${PREFIX}wf`;
// Another workflow on the same wallet, for the stuck copy.
const STREAK_WORKFLOW_ID = `${PREFIX}wf-other`;
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
type Db = typeof import("@/lib/db").db;
type StepResult = Awaited<ReturnType<Step["writeContractStep"]>>;

let db: Db;
let schema: Schema;
let ext: Ext;
let step: Step;
let logging: Logging;
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

async function newRun(workflowId = WORKFLOW_ID): Promise<string> {
  seq += 1;
  const id = `${PREFIX}run${seq}`;
  await db.insert(schema.workflowExecutions).values({
    id,
    workflowId,
    userId: env.userId,
    status: "running",
  });
  return id;
}

async function runStep(
  executionId: string,
  config: Record<string, unknown> = {},
  workflowId = WORKFLOW_ID
): Promise<StepResult> {
  return await step.writeContractStep({
    network: String(CHAIN_ID),
    contractAddress: gate,
    abi: new ethers.Interface(ABI).formatJson(),
    abiFunction: "kick",
    functionArgs: "[]",
    sendMode: "bundle-and-public",
    priorityFeeGwei: "1",
    ...config,
    _context: {
      executionId,
      nodeId: "kick-1",
      nodeName: "Kick",
      nodeType: "web3/write-contract",
      organizationId: env.orgId,
      workflowId,
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

describe.skipIf(SKIP)(
  "Bundle and public, and the public fallback (anvil, fake builders)",
  () => {
    beforeAll(async () => {
      vi.resetModules();
      ({ db } = await import("@/lib/db"));
      schema = await import("@/lib/db/schema");
      ext = await import("@/lib/db/schema-extensions");
      step = await import("@/plugins/web3/steps/write-contract");
      logging = await import("@/lib/workflow/executor/logging");
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
        builderRpcUrls: builders.map((b) => ({
          label: b.name,
          url: b.url,
          methods: ["bundle" as const],
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
      for (const id of [WORKFLOW_ID, STREAK_WORKFLOW_ID]) {
        await db.insert(schema.workflows).values({
          id,
          name: id,
          userId: env.userId,
          organizationId: env.orgId,
          nodes: [],
          edges: [],
        });
      }

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
      miner.secondsBefore = undefined;
      miner.baseFee = undefined;
      miner.minePool = true;
      miner.tickMs = 300;
      // The builders take every bundle and include none: only a public copy can land.
      for (const builder of builders) {
        builder.mode = "decline";
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

    // kick() reverts while block.timestamp < slot 3; slot 1 counts the calls.
    const CLOCK_RUNTIME = "6003544210601257600154600101600155005b600080fd";
    let clock: string;

    type Head = { number: number; timestamp: number };

    async function head(): Promise<Head> {
      const block = await rpc<{ number: string; timestamp: string }>(
        "eth_getBlockByNumber",
        ["latest", false]
      );
      return {
        number: Number(block.number),
        timestamp: Number(block.timestamp),
      };
    }

    async function timeOf(block: number): Promise<number> {
      const found = await rpc<{ timestamp: string }>("eth_getBlockByNumber", [
        ethers.toQuantity(block),
        false,
      ]);
      return Number(found.timestamp);
    }

    const clockKicks = async (): Promise<number> =>
      Number(await rpc<string>("eth_getStorageAt", [clock, "0x1", "latest"]));

    async function unlockAt(notBefore: number): Promise<void> {
      await rpc("anvil_setStorageAt", [
        clock,
        "0x3",
        ethers.toBeHex(notBefore, 32),
      ]);
    }

    const publicSends = (): number =>
      proxy.requests.filter((r) => r.method === "eth_sendRawTransaction")
        .length;

    // Paces the miner on the step: polls `ready` up to 5 s (the gate polls once a second, the miner ticks faster).
    // A timeout is reported through miner.errors, which afterEach checks.
    async function waitUntil(
      block: number,
      ready: () => Promise<boolean> | boolean
    ): Promise<void> {
      const end = Date.now() + 5000;
      while (!(await ready())) {
        if (Date.now() >= end) {
          miner.errors.push(`waitUntil timed out at block ${block}`);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    const poolPending = async (): Promise<number> =>
      Number((await rpc<{ pending: string }>("txpool_status")).pending);

    // The signed bytes the builders got for `target`.
    const rawFor = (target: number): string =>
      builders[0].received.find((r) => r.target === target)?.raw ?? "";

    async function reconcile(): Promise<void> {
      const { reconcileUnconfirmedExecutions } = await import(
        "@/lib/execute/reconcile-executions"
      );
      await reconcileUnconfirmedExecutions(new Date(), 500, 30_000);
    }

    // A pending bundle row at `nonce` whose public copy `hash` went out, from another run.
    async function publicRowOf(
      workflowId: string,
      nonce: number,
      hash: string
    ): Promise<string> {
      const executionId = await newRun(workflowId);
      await db.insert(ext.pendingTransactions).values({
        walletAddress: wallet.address.toLowerCase(),
        chainId: CHAIN_ID,
        nonce,
        txHash: hash,
        executionId,
        workflowId,
        status: "pending",
        lastTargetBlock: 1,
        submittedAt: new Date(Date.now() - 5 * 60_000),
        bundleRuns: [
          {
            executionId,
            hashes: [hash],
            signedAt: Date.now(),
            public: { hash, kind: "with-bundle", at: Date.now() },
          },
        ],
      });
      return executionId;
    }

    beforeAll(async () => {
      const deployed = await sendAndMine({
        data: `0x601780600b6000396000f3${CLOCK_RUNTIME}`,
        maxFeePerGas: ethers.parseUnits("50", "gwei"),
        maxPriorityFeePerGas: ethers.parseUnits("1", "gwei"),
      });
      clock = deployed.contractAddress ?? "";
      // 12 s blocks, so the next-block check measures 12 s slots.
      await miner.mine(6);
      const simulation = await import("@/lib/web3/next-block-simulation");
      simulation.clearSlotSecondsCache();
    }, 60_000);

    it("case 1: with every builder declining, lands at the first allowed block from the pool, never before Not before", async () => {
      const start = await head();
      // From the head's parent: the first allowed block U is start + 3, close enough to send.
      const notBefore = start.timestamp + 36;
      await unlockAt(notBefore);
      const allowed = start.number + 3;
      const before = await clockKicks();
      const sendsBefore = publicSends();
      let sentBeforeGate = -1;
      miner.beforeBlock = async (block) => {
        // Before U - 1 exists, no public copy may have gone out.
        if (block === allowed - 1) {
          sentBeforeGate = publicSends() - sendsBefore;
        }
        // U is mined only once the copy is out (and in the pool).
        if (block === allowed) {
          await waitUntil(
            block,
            async () => publicSends() > sendsBefore && (await poolPending()) > 0
          );
        }
      };
      const executionId = await newRun();
      const result = await runStep(executionId, {
        contractAddress: clock,
        notBefore: String(notBefore),
        sendAheadBlocks: 2,
      });
      expect(result).toMatchObject({
        success: true,
        route: "bundle-and-public",
        included: true,
        includedBlock: allowed,
        firstAllowedBlock: allowed,
        publicCopy: { accepted: true },
      });
      expect(sentBeforeGate).toBe(0);
      expect(result.success && result.transactionHash).toBe(
        ethers.keccak256(rawFor(allowed))
      );
      expect(await timeOf(allowed)).toBeGreaterThanOrEqual(notBefore);
      expect(await clockKicks()).toBe(before + 1);
      expect((await finalize(executionId))?.status).toBe("success");
      expectNoSecrets(result);
    }, 120_000);

    it("case 2: another transaction makes the call first in that block: the copy reverts, Error, gas paid", async () => {
      const start = await head();
      const target = start.number + 1;
      const provider = new ethers.JsonRpcProvider(ANVIL_URL, CHAIN_ID, {
        staticNetwork: true,
      });
      const rich = new ethers.Wallet(RICH_KEY, provider);
      const sendsBefore = publicSends();
      miner.beforeBlock = async (block) => {
        if (block === target) {
          // Only once this run's copy is in the pool, so both are in that block.
          await waitUntil(
            block,
            async () => publicSends() > sendsBefore && (await poolPending()) > 0
          );
          // A higher tip: mined before the public copy in the same block.
          await rich.sendTransaction({
            to: gate,
            data: new ethers.Interface(ABI).encodeFunctionData("close"),
            maxFeePerGas: ethers.parseUnits("100", "gwei"),
            maxPriorityFeePerGas: ethers.parseUnits("50", "gwei"),
          });
        }
      };
      const paidBefore = await balance();
      const executionId = await newRun();
      const result = await runStep(executionId);
      provider.destroy();
      expect(result).toMatchObject({
        success: false,
        route: "bundle-and-public",
        included: true,
        includedBlock: target,
        broadcastAttempted: true,
      });
      // The generic paid revert (the call still works after its block) is covered by unit tests only.
      expect(!result.success && result.error).toContain(
        "Most likely another transaction made the call first"
      );
      const failed = result as { gasUsed?: string; gasUsedUnits?: string };
      expect(BigInt(failed.gasUsed ?? "0")).toBeGreaterThan(BigInt(0));
      expect(BigInt(failed.gasUsedUnits ?? "0")).toBeGreaterThan(BigInt(0));
      expect(paidBefore - (await balance())).toBe(
        BigInt(failed.gasUsed ?? "0")
      );
      await logging.logWorkflowCompleteDb({
        executionId,
        status: "error",
        error: result.success ? "" : result.error,
        startTime: Date.now() - 1000,
      });
      const [row] = await db
        .select()
        .from(schema.workflowExecutions)
        .where(eq(schema.workflowExecutions.id, executionId));
      expect(row?.status).toBe("error");
    }, 120_000);

    it("case 3: the fallback sends the last target's bytes publicly once no builder picked it, and lands", async () => {
      const start = await head();
      const last = start.number + 3;
      const before = await kicks();
      const executionId = await newRun();
      const result = await runStep(executionId, {
        sendMode: "bundle",
        bundleFallback: "public",
      });
      expect(result).toMatchObject({
        success: true,
        route: "bundle",
        included: true,
        fallbackSent: true,
        publicCopy: { accepted: true },
      });
      expect(result.success && result.transactionHash).toBe(
        ethers.keccak256(rawFor(last))
      );
      expect(result.success && result.includedBlock).toBeGreaterThan(last);
      expect(await kicks()).toBe(before + 1);
      expect((await finalize(executionId))?.status).toBe("success");
    }, 120_000);

    it("case 4: the fallback is not sent when the call is no longer needed: no gas, Not landed", async () => {
      const start = await head();
      const last = start.number + 3;
      miner.beforeBlock = async (block) => {
        if (block === last + 1) {
          // Someone made the call after the targets: it now reverts.
          await rpc("anvil_setStorageAt", [gate, "0x0", ethers.toBeHex(1, 32)]);
        }
      };
      const paidBefore = await balance();
      const nonce = await minedNonce();
      const executionId = await newRun();
      const sendsBefore = publicSends();
      const result = await runStep(executionId, {
        sendMode: "bundle",
        bundleFallback: "public",
      });
      expect(result).toMatchObject({
        success: true,
        route: "bundle",
        included: false,
        notIncludedReason: "no-longer-needed",
        fallbackSent: false,
        fallbackNotSentReason: "no-longer-needed",
      });
      expect(publicSends()).toBe(sendsBefore);
      expect(await balance()).toBe(paidBefore);
      expect((await rowAt(nonce))?.status).toBe("dropped");
      expect((await finalize(executionId))?.status).toBe("not_landed");
    }, 120_000);

    it("case 5: a copy the base fee keeps out is unconfirmed; once mined, the reconciler settles it Success", async () => {
      miner.baseFee = ethers.parseUnits("1", "gwei");
      await miner.mine(1);
      const start = await head();
      const sendsBefore = publicSends();
      miner.beforeBlock = async (block) => {
        if (block === start.number + 1) {
          // Raised only once this run's copy is pooled: before, anvil would refuse it (fee cap too low).
          await waitUntil(
            block,
            async () => publicSends() > sendsBefore && (await poolPending()) > 0
          );
          // Above the 5 gwei cap the copy was signed with: it is not mined.
          miner.baseFee = ethers.parseUnits("20", "gwei");
        }
      };
      const executionId = await newRun();
      const result = await runStep(executionId, { maxFeeGwei: "5" });
      expect(result).toMatchObject({
        success: true,
        route: "bundle-and-public",
        included: false,
        pending: true,
      });
      expect(result).not.toHaveProperty("notIncludedReason");
      const hash = result.success ? result.transactionHash : undefined;
      expect(hash).toBe(ethers.keccak256(rawFor(start.number + 1)));
      expect((await finalize(executionId))?.status).toBe("unconfirmed");

      miner.beforeBlock = undefined;
      miner.baseFee = ethers.parseUnits("1", "gwei");
      // Anvil evicts a tx whose fee cap is below the base fee, while geth keeps it: send the copy again.
      await rpc("anvil_setNextBlockBaseFeePerGas", [
        ethers.toQuantity(miner.baseFee),
      ]);
      await rpc("eth_sendRawTransaction", [rawFor(start.number + 1)]);
      await expect
        .poll(
          async () =>
            (await rpc<unknown>("eth_getTransactionReceipt", [hash])) !== null,
          {
            timeout: 20_000,
          }
        )
        .toBe(true);
      await db
        .update(schema.workflowExecutions)
        .set({ startedAt: new Date(Date.now() - 5 * 60_000) })
        .where(eq(schema.workflowExecutions.id, executionId));
      await reconcile();
      const [row] = await db
        .select()
        .from(schema.workflowExecutions)
        .where(eq(schema.workflowExecutions.id, executionId));
      expect(row?.status).toBe("success");
    }, 300_000);

    it("case 6: after a missed slot, the copy goes out only once the gate opens, and lands no earlier", async () => {
      const start = await head();
      const notBefore = start.timestamp + 36;
      await unlockAt(notBefore);
      const allowed = start.number + 3;
      // The slot before the first allowed block is missed.
      miner.secondsBefore = (block) => (block === allowed - 1 ? 24 : 12);
      const sendsBefore = publicSends();
      let sentBeforeGate = -1;
      miner.beforeBlock = async (block) => {
        if (block === allowed - 1) {
          sentBeforeGate = publicSends() - sendsBefore;
        }
        if (block === allowed) {
          await waitUntil(
            block,
            async () => publicSends() > sendsBefore && (await poolPending()) > 0
          );
        }
      };
      const result = await runStep(await newRun(), {
        contractAddress: clock,
        notBefore: String(notBefore),
        sendAheadBlocks: 2,
      });
      expect(sentBeforeGate).toBe(0);
      expect(result).toMatchObject({
        success: true,
        included: true,
        includedBlock: allowed,
      });
      expect(await timeOf(allowed)).toBeGreaterThanOrEqual(notBefore);
    }, 120_000);

    // A tip increase changes only the later targets' bytes, never T1's (the copy), so it is left to unit tests.
    it("case 8: a builder includes the first target while the copy sits in the pool: exactly one lands", async () => {
      builders[0].mode = "accept";
      const start = await head();
      const target = start.number + 1;
      const sendsBefore = publicSends();
      miner.beforeBlock = async (block) => {
        // The copy is pooled before the builder includes the same bytes at T1.
        if (block === target) {
          await waitUntil(
            block,
            async () => publicSends() > sendsBefore && (await poolPending()) > 0
          );
        }
      };
      const nonce = await minedNonce();
      const before = await kicks();
      const paidBefore = await balance();
      const executionId = await newRun();
      const result = await runStep(executionId);
      expect(result).toMatchObject({
        success: true,
        route: "bundle-and-public",
        included: true,
        includedBlock: target,
        publicCopy: { accepted: true },
      });
      const hash = result.success ? result.transactionHash : undefined;
      expect(hash).toBe(ethers.keccak256(rawFor(target)));
      expect(result.success && result.publicCopy?.hash).toBe(hash);
      // One transaction at the nonce, one call, one fee.
      await miner.mine(2);
      expect(await minedNonce()).toBe(nonce + 1);
      expect(await kicks()).toBe(before + 1);
      const paid = paidBefore - (await balance());
      expect(paid).toBe(BigInt(result.success ? (result.gasUsed ?? "0") : "0"));
      expect((await finalize(executionId))?.status).toBe("success");
    }, 120_000);

    it("case 7: a second run behind a pending public copy of its workflow is skipped in flight", async () => {
      const nonce = await minedNonce();
      await publicRowOf(WORKFLOW_ID, nonce, `0x${"7a".repeat(32)}`);
      const executionId = await newRun();
      const result = await runStep(executionId);
      expect(result).toEqual({
        success: true,
        route: "skipped-in-flight",
        included: false,
        inFlightHash: `0x${"7a".repeat(32)}`,
      });
      expect(builders.every((b) => b.received.length === 0)).toBe(true);
      expect((await finalize(executionId))?.status).toBe("skipped");
      await db
        .delete(ext.pendingTransactions)
        .where(
          eq(
            ext.pendingTransactions.walletAddress,
            wallet.address.toLowerCase()
          )
        );
    }, 60_000);

    it("a stuck copy: another workflow's bundle step names it, and the sweep releases the nonce after three misses", async () => {
      const nonce = await minedNonce();
      const stuck = `0x${"5c".repeat(32)}`;
      await publicRowOf(STREAK_WORKFLOW_ID, nonce, stuck);
      const refused = await runStep(await newRun());
      expect(refused).toMatchObject({
        success: false,
        broadcastAttempted: false,
      });
      expect(!refused.success && refused.error).toContain(
        `A public copy of an earlier bundle from this wallet (transaction ${stuck}, nonce ${nonce})`
      );
      const { sweepLateBundles } = await import(
        "@/lib/web3/bundles/late-landing-sweep"
      );
      for (let sweep = 0; sweep < 3; sweep += 1) {
        expect((await rowAt(nonce))?.status).toBe("pending");
        await sweepLateBundles(new Date(), Date.now() + 10_000);
      }
      expect((await rowAt(nonce))?.status).toBe("dropped");
      // The nonce is free again: the next bundle step sends at it.
      builders[0].mode = "accept";
      const sent = await runStep(await newRun());
      expect(sent).toMatchObject({ success: true, included: true });
    }, 150_000);
  }
);
