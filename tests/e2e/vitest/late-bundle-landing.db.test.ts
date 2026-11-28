import "dotenv/config";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { WorkflowExecutionStatus } from "../../../lib/errors/execution-status";

vi.mock("server-only", () => ({}));
// tests/setup.ts stubs @/lib/db; these tests must read Postgres.
vi.unmock("@/lib/db");
// The real logger, spied on so a warning can be pinned.
vi.mock("@/lib/logging", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/logging")>();
  return { ...actual, logWarn: vi.fn(actual.logWarn) };
});

type Receipt = {
  hash: string;
  status: number;
  blockNumber: number;
  gasUsed: bigint;
  gasPrice: bigint;
} | null;

type ChainView = {
  // The pending count; `minedCount` is the mined one, when it differs.
  transactionCount: number;
  minedCount?: number;
  // The mined count at a block, when it depends on the block.
  countAt?: (block: number) => number;
  latestBlock: number;
  mined?: Record<string, number>;
};

// The count at a block tag: the pending count, or the mined count at a block.
const countOf = (view: ChainView, tag?: string | number): number =>
  typeof tag === "number"
    ? (view.countAt?.(tag) ?? view.minedCount ?? view.transactionCount)
    : view.transactionCount;

// Every mined test transaction used 21000 gas at 2 wei.
const GAS_UNITS = BigInt(21_000);
const GAS_PRICE = BigInt(2);
const FEE_WEI = 42_000;

// The sweep's chain: one view behind getRpcProvider, counting receipt reads.
const sweepChain = vi.hoisted(() => {
  const state = {
    view: { transactionCount: 0, latestBlock: 0 } as {
      transactionCount: number;
      countAt?: (block: number) => number;
      latestBlock: number;
      mined?: Record<string, number>;
    },
    receiptReads: 0,
    nonceReads: 0,
    countTags: [] as unknown[],
    // Runs once inside the next receipt read: a write racing the sweep.
    onReceipt: undefined as undefined | (() => Promise<void>),
    // The first node fails receipt reads, so failover answers them elsewhere.
    receiptsElsewhere: false,
    node: {} as Record<string, unknown>,
    otherNode: {} as Record<string, unknown>,
    // What each endpoint says of a public copy: known, unknown, or an error.
    seen: { primary: false, fallback: false, extra: false } as Record<
      "primary" | "fallback" | "extra",
      boolean | "error"
    >,
    extras: ["https://extra.example"] as string[],
    // The manager failed over to its fallback; or the chain has none.
    failedOver: false,
    noFallback: false,
    // getTransaction reads of a public copy, per endpoint.
    copyReads: { primary: 0, fallback: 0 },
  };
  const seenOn =
    (endpoint: "primary" | "fallback") =>
    async (h: string): Promise<{ hash: string } | null> => {
      state.copyReads[endpoint] += 1;
      const answer = state.seen[endpoint];
      if (answer === "error") {
        throw new Error("node down");
      }
      return answer ? { hash: h } : null;
    };
  const receipt = async (h: string) => {
    state.receiptReads += 1;
    const race = state.onReceipt;
    state.onReceipt = undefined;
    await race?.();
    const status = state.view.mined?.[h];
    return status === undefined
      ? null
      : {
          hash: h,
          status,
          blockNumber: 500,
          gasUsed: BigInt(21_000),
          gasPrice: BigInt(2),
        };
  };
  state.node = {
    getTransactionCount: async (_address: string, tag?: string | number) => {
      state.nonceReads += 1;
      state.countTags.push(tag);
      return typeof tag === "number" && state.view.countAt
        ? state.view.countAt(tag)
        : state.view.transactionCount;
    },
    getBlockNumber: async () => state.view.latestBlock,
    getTransactionReceipt: async (h: string) => {
      if (state.receiptsElsewhere) {
        throw new Error("node down");
      }
      return receipt(h);
    },
  };
  state.otherNode = { getTransactionReceipt: receipt };
  Object.assign(state, {
    primaryNode: { getTransaction: seenOn("primary") },
    fallbackNode: { getTransaction: seenOn("fallback") },
  });
  return state as typeof state & {
    primaryNode: unknown;
    fallbackNode: unknown;
  };
});
vi.mock("@/lib/rpc/provider-factory", () => ({
  getRpcProvider: async () => ({
    executeWithFailover: async (
      operation: (provider: unknown) => Promise<unknown>
    ) => {
      try {
        return await operation(sweepChain.node);
      } catch {
        return operation(sweepChain.otherNode);
      }
    },
    // Failed over, the current provider is the fallback.
    getProvider: () =>
      sweepChain.failedOver ? sweepChain.fallbackNode : sweepChain.primaryNode,
    getFallbackProvider: () =>
      sweepChain.noFallback ? null : sweepChain.fallbackNode,
    isCurrentlyUsingFallback: () => sweepChain.failedOver,
    getBroadcastRpcUrls: () => sweepChain.extras,
  }),
}));
vi.mock("@/lib/web3/extra-broadcast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/web3/extra-broadcast")>()),
  extraRpcHasTransaction: async () => {
    const answer = sweepChain.seen.extra;
    return answer === "error" ? undefined : answer;
  },
}));

const SKIP =
  !process.env.DATABASE_URL || process.env.SKIP_INFRA_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const PREFIX = `lbl_${Date.now().toString(36)}_`;
const USER_ID = `${PREFIX}user`;
const ORG_ID = `${PREFIX}org`;
const WORKFLOW_ID = `${PREFIX}wf`;
const WALLET = `0x${"ab".repeat(20)}`;
const CHAIN_ID = 1;
const HOUR_MS = 60 * 60 * 1000;

type Db = typeof import("@/lib/db").db;
type Schema = typeof import("@/lib/db/schema");
type Extensions = typeof import("@/lib/db/schema-extensions");
type Nonces = typeof import("@/lib/web3/nonce-manager");
type Late = typeof import("@/lib/web3/bundles/late-landing-sweep");
type InFlightModule = typeof import("@/lib/web3/bundles/in-flight");
let db: Db;
let schema: Schema;
let ext: Extensions;
let nonces: Nonces;
let late: Late;
let inFlight: InFlightModule;
let seq = 0;

const hash = (c: string): string => `0x${c.repeat(64)}`;
const hashOf = (n: number): string => `0x${n.toString(16).padStart(64, "0")}`;

async function cleanup(): Promise<void> {
  const client = postgres(DATABASE_URL, { max: 1 });
  try {
    await client`DELETE FROM pending_transactions WHERE wallet_address = ${WALLET}`;
    await client`DELETE FROM wallet_locks WHERE wallet_address = ${WALLET}`;
    await client`DELETE FROM workflow_execution_logs WHERE execution_id LIKE ${`${PREFIX}%`}`;
    await client`DELETE FROM workflow_executions WHERE workflow_id LIKE ${`${PREFIX}%`}`;
    await client`DELETE FROM workflows WHERE id LIKE ${`${PREFIX}%`}`;
    await client`DELETE FROM org_value_reservations WHERE organization_id LIKE ${`${PREFIX}%`}`;
    await client`DELETE FROM organization_spend_caps WHERE organization_id LIKE ${`${PREFIX}%`}`;
    await client`DELETE FROM organization WHERE id LIKE ${`${PREFIX}%`}`;
    await client`DELETE FROM users WHERE id LIKE ${`${PREFIX}%`}`;
  } finally {
    await client.end();
  }
}

async function run(status: WorkflowExecutionStatus): Promise<string> {
  seq += 1;
  const id = `${PREFIX}run${seq}`;
  await db.insert(schema.workflowExecutions).values({
    id,
    workflowId: WORKFLOW_ID,
    userId: USER_ID,
    status,
    completedAt: new Date(),
  });
  return id;
}

async function executionOf(executionId: string) {
  const [row] = await db
    .select()
    .from(schema.workflowExecutions)
    .where(eq(schema.workflowExecutions.id, executionId));
  return row;
}

async function statusOf(executionId: string): Promise<string | undefined> {
  return (await executionOf(executionId))?.status;
}

async function rowAt(nonce: number) {
  const [row] = await db
    .select()
    .from(ext.pendingTransactions)
    .where(
      and(
        eq(ext.pendingTransactions.walletAddress, WALLET),
        eq(ext.pendingTransactions.chainId, CHAIN_ID),
        eq(ext.pendingTransactions.nonce, nonce)
      )
    );
  return row;
}

async function setRow(
  nonce: number,
  fields: Partial<typeof ext.pendingTransactions.$inferInsert>
): Promise<void> {
  await db
    .update(ext.pendingTransactions)
    .set(fields)
    .where(
      and(
        eq(ext.pendingTransactions.walletAddress, WALLET),
        eq(ext.pendingTransactions.chainId, CHAIN_ID),
        eq(ext.pendingTransactions.nonce, nonce)
      )
    );
}

async function setRun(
  executionId: string,
  fields: Partial<typeof schema.workflowExecutions.$inferInsert>
): Promise<void> {
  await db
    .update(schema.workflowExecutions)
    .set(fields)
    .where(eq(schema.workflowExecutions.id, executionId));
}

async function sweep() {
  return await late.sweepLateBundles(new Date(), Date.now() + 10_000);
}

/** A session whose receipt reads each take 6 s of a fake clock. */
async function slowSession(executionId: string, view: ChainView) {
  const realNow = Date.now.bind(Date);
  let skew = 0;
  const clock = vi
    .spyOn(Date, "now")
    .mockImplementation(() => realNow() + skew);
  const chain = provider(view);
  const read = chain.getTransactionReceipt;
  chain.getTransactionReceipt = (h: string) => {
    skew += 6000;
    return read(h);
  };
  const manager = new nonces.NonceManager();
  try {
    const { session } = await manager.startSession(
      WALLET,
      CHAIN_ID,
      executionId,
      chain as never
    );
    await manager.endSession(session);
  } finally {
    clock.mockRestore();
  }
  return chain.calls;
}

function provider(view: ChainView, failReceiptRead?: number) {
  const calls = { receipts: 0, getTransaction: 0 };
  return {
    calls,
    getTransactionCount: async (_address: string, tag?: string | number) =>
      countOf(view, tag),
    getBlockNumber: async () => view.latestBlock,
    getTransactionReceipt: async (h: string): Promise<Receipt> => {
      calls.receipts += 1;
      if (calls.receipts === failReceiptRead) {
        throw new Error("receipt read failed");
      }
      const status = view.mined?.[h];
      return status === undefined
        ? null
        : {
            hash: h,
            status,
            blockNumber: 500,
            gasUsed: GAS_UNITS,
            gasPrice: GAS_PRICE,
          };
    },
    getTransaction: async () => {
      calls.getTransaction += 1;
      return null;
    },
  };
}

/** A failover manager whose first read (the nonce) is answered by one node and the rest by another. */
function failoverAfterNonce(view: ChainView) {
  const nonceNode = provider(view);
  const otherNode = provider(view);
  let reads = 0;
  return {
    otherNode,
    rpc: {
      executeWithFailover: (operation: (p: unknown) => Promise<unknown>) => {
        reads += 1;
        return operation(reads === 1 ? nonceNode : otherNode);
      },
    },
  };
}

/** A bundle the run recorded at `nonce`, then gave up on (not landed). */
async function droppedBundle(
  executionId: string,
  nonce: number,
  hashes: string[],
  node?: { id: string; name: string }
): Promise<void> {
  const manager = new nonces.NonceManager();
  const { session } = await manager.startSession(
    WALLET,
    CHAIN_ID,
    executionId,
    provider({ transactionCount: nonce, latestBlock: 100 }) as never
  );
  await manager.recordBundle(session, nonce, {
    hashes,
    lastTargetBlock: 102,
    ...(node && { node }),
  });
  await manager.markNonceDropped(session, nonce);
  await manager.endSession(session);
}

async function startSession(
  executionId: string,
  view: ChainView,
  failReceiptRead?: number
) {
  const manager = new nonces.NonceManager();
  const chain = provider(view, failReceiptRead);
  const started = await manager.startSession(
    WALLET,
    CHAIN_ID,
    executionId,
    chain as never
  );
  return { manager, chain, ...started };
}

async function settleAt(
  view: ChainView,
  failReceiptRead?: number
): Promise<void> {
  seq += 1;
  const { manager, session } = await startSession(
    `${PREFIX}next${seq}`,
    view,
    failReceiptRead
  );
  await manager.endSession(session);
}

async function logStep(
  executionId: string,
  nodeId: string,
  outputRaw: object,
  extra: {
    nodeType?: string;
    status?: "success" | "error";
    output?: object;
  } = {}
) {
  await db.insert(schema.workflowExecutionLogs).values({
    executionId,
    nodeId,
    nodeName: "Write Contract",
    nodeType: extra.nodeType ?? "web3/write-contract",
    status: extra.status ?? "success",
    outputRaw,
    ...(extra.output && { output: extra.output }),
  });
}

const NOT_INCLUDED = { route: "bundle", notIncludedReason: "not-picked" };

/** A Write Contract step whose bundle was not included, and its dropped row at `nonce`. */
async function missedStep(
  executionId: string,
  nonce: number,
  hashes: string[],
  nodeId = "write-1"
): Promise<void> {
  await droppedBundle(executionId, nonce, hashes, {
    id: nodeId,
    name: "Write Contract",
  });
  await logStep(executionId, nodeId, NOT_INCLUDED);
}

describe.skipIf(SKIP)("late landing of a not landed bundle", () => {
  beforeAll(async () => {
    await cleanup();
    vi.resetModules();
    ({ db } = await import("@/lib/db"));
    schema = await import("@/lib/db/schema");
    ext = await import("@/lib/db/schema-extensions");
    nonces = await import("@/lib/web3/nonce-manager");
    late = await import("@/lib/web3/bundles/late-landing-sweep");
    inFlight = await import("@/lib/web3/bundles/in-flight");
    await db.insert(schema.users).values({
      id: USER_ID,
      name: "late bundle owner",
      email: `${PREFIX}@late.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(schema.organization).values({
      id: ORG_ID,
      name: "Late",
      slug: ORG_ID.replaceAll("_", "-"),
      createdAt: new Date(),
    });
    await db.insert(schema.workflows).values({
      id: WORKFLOW_ID,
      name: WORKFLOW_ID,
      userId: USER_ID,
      organizationId: ORG_ID,
      nodes: [],
      edges: [],
    });
  }, 60_000);

  beforeEach(async () => {
    sweepChain.view = { transactionCount: 0, latestBlock: 0 };
    sweepChain.receiptReads = 0;
    sweepChain.nonceReads = 0;
    sweepChain.countTags = [];
    sweepChain.onReceipt = undefined;
    sweepChain.receiptsElsewhere = false;
    sweepChain.seen = { primary: false, fallback: false, extra: false };
    sweepChain.extras = ["https://extra.example"];
    sweepChain.failedOver = false;
    sweepChain.noFallback = false;
    sweepChain.copyReads = { primary: 0, fallback: 0 };
    await db
      .delete(ext.pendingTransactions)
      .where(eq(ext.pendingTransactions.walletAddress, WALLET));
  });

  afterAll(async () => {
    await cleanup();
  });

  describe("session start", () => {
    it("confirms a dropped bundle mined later, re-settles its run and names the hash on it", async () => {
      const bundleRun = await run("not_landed");
      await missedStep(bundleRun, 7, [hash("1"), hash("2")]);

      await settleAt({
        transactionCount: 8,
        latestBlock: 600,
        mined: { [hash("2")]: 1 },
      });

      expect(await rowAt(7)).toMatchObject({
        status: "confirmed",
        txHash: hash("2"),
      });
      const execution = await executionOf(bundleRun);
      expect(execution?.status).toBe("success");
      expect(execution?.transactionHashes).toEqual([
        expect.objectContaining({
          hash: hash("2"),
          nodeId: "write-1",
          nodeName: "Write Contract",
          chainId: CHAIN_ID,
          verified: true,
          receiptStatus: "success",
          blockNumber: 500,
          gasUsed: "21000",
        }),
      ]);
      expect(execution?.gasUsedWei).toBe(String(FEE_WEI));
    });

    it("confirms a bundle left pending as not-checked straight from pending, and re-settles its run", async () => {
      const bundleRun = await run("not_landed");
      // The step could not decide: the row stays pending, never dropped.
      const manager = new nonces.NonceManager();
      const { session } = await manager.startSession(
        WALLET,
        CHAIN_ID,
        bundleRun,
        provider({ transactionCount: 7, latestBlock: 100 }) as never
      );
      await manager.recordBundle(session, 7, {
        hashes: [hash("1"), hash("2")],
        lastTargetBlock: 102,
        node: { id: "write-1", name: "Write Contract" },
      });
      await manager.endSession(session);
      await logStep(bundleRun, "write-1", {
        route: "bundle",
        notIncludedReason: "not-checked",
      });
      expect((await rowAt(7))?.status).toBe("pending");

      await settleAt({
        transactionCount: 8,
        latestBlock: 600,
        mined: { [hash("1")]: 1 },
      });

      expect(await rowAt(7)).toMatchObject({
        status: "confirmed",
        txHash: hash("1"),
      });
      const execution = await executionOf(bundleRun);
      expect(execution?.status).toBe("success");
      expect(execution?.error).toBeNull();
    });

    it("marks a dropped bundle replaced when the nonce's own endpoint finds no hash; the run stays not landed", async () => {
      const bundleRun = await run("not_landed");
      await droppedBundle(bundleRun, 7, [hash("1")]);
      await setRow(7, { submittedAt: new Date(Date.now() - 11 * 60_000) });

      await settleAt({ transactionCount: 8, latestBlock: 600 });

      expect((await rowAt(7))?.status).toBe("replaced");
      expect(await statusOf(bundleRun)).toBe("not_landed");
    });

    it("leaves a dropped bundle dropped when its nonce passed only in the last few blocks", async () => {
      const bundleRun = await run("not_landed");
      await missedStep(bundleRun, 7, [hash("1")]);

      // Mined at the head; a node a block behind answers the receipt read with none.
      await settleAt({
        transactionCount: 8,
        countAt: (block) => (block >= 598 ? 8 : 7),
        latestBlock: 600,
      });

      expect((await rowAt(7))?.status).toBe("dropped");
      expect(await statusOf(bundleRun)).toBe("not_landed");
    });

    it("leaves a dropped bundle dropped when another endpoint answered the receipt reads", async () => {
      const bundleRun = await run("not_landed");
      await droppedBundle(bundleRun, 7, [hash("1")]);

      const { rpc } = failoverAfterNonce({
        transactionCount: 8,
        latestBlock: 600,
      });
      const manager = new nonces.NonceManager();
      const { session } = await manager.startSession(
        WALLET,
        CHAIN_ID,
        `${PREFIX}lagging`,
        rpc as never
      );
      await manager.endSession(session);

      expect((await rowAt(7))?.status).toBe("dropped");
      expect(await statusOf(bundleRun)).toBe("not_landed");
    });

    it("ends the run as error when the late landing reverted", async () => {
      const bundleRun = await run("not_landed");
      await droppedBundle(bundleRun, 7, [hash("1")]);

      await settleAt({
        transactionCount: 8,
        latestBlock: 600,
        mined: { [hash("1")]: 0 },
      });

      expect((await rowAt(7))?.status).toBe("confirmed");
      const execution = await executionOf(bundleRun);
      expect(execution).toMatchObject({
        status: "error",
        errorType: "user",
        errorCategory: "transaction",
      });
      expect(execution?.error).toContain("mined later and reverted");
      expect(execution?.error).toContain(hash("1"));
    });

    it("drops a closed-window bundle row without a mempool read, even when a fallback endpoint answered", async () => {
      const bundleRun = await run("running");
      const manager = new nonces.NonceManager();
      const first = await manager.startSession(
        WALLET,
        CHAIN_ID,
        bundleRun,
        provider({ transactionCount: 7, latestBlock: 100 }) as never
      );
      await manager.recordBundle(first.session, 7, {
        hashes: [hash("1"), hash("2")],
        lastTargetBlock: 102,
      });
      await manager.endSession(first.session);

      const { rpc, otherNode } = failoverAfterNonce({
        transactionCount: 7,
        latestBlock: 110,
      });
      const next = await manager.startSession(
        WALLET,
        CHAIN_ID,
        `${PREFIX}after_window`,
        rpc as never
      );

      expect((await rowAt(7))?.status).toBe("dropped");
      expect(otherNode.calls.getTransaction).toBe(0);
      expect(next.session.currentNonce).toBe(7);
      await manager.endSession(next.session);
    });
  });

  describe("history across reuse", () => {
    it("keeps the bundle's hashes on reuse; its late landing re-settles the bundle run, not the new one", async () => {
      const bundleRun = await run("not_landed");
      await missedStep(bundleRun, 7, [hash("1"), hash("2")]);

      const nextRun = await run("running");
      const next = await startSession(nextRun, {
        transactionCount: 7,
        latestBlock: 600,
      });
      expect(next.session.currentNonce).toBe(7);
      await next.manager.recordTransaction(next.session, 7, hash("9"));
      expect(await rowAt(7)).toMatchObject({
        txHash: hash("9"),
        lastTargetBlock: null,
        bundleRuns: [
          {
            executionId: bundleRun,
            hashes: [hash("1"), hash("2")],
            signedAt: expect.any(Number),
            node: { id: "write-1", name: "Write Contract" },
          },
        ],
        executionId: nextRun,
      });
      await next.manager.endSession(next.session);

      await settleAt({
        transactionCount: 8,
        latestBlock: 700,
        mined: { [hash("1")]: 1 },
      });

      expect(await rowAt(7)).toMatchObject({
        status: "confirmed",
        txHash: hash("1"),
      });
      expect(await statusOf(bundleRun)).toBe("success");
      expect(await statusOf(nextRun)).toBe("running");
    });

    it("prunes entries older than a day by their own age, however recently the row was reused", async () => {
      const bundleRun = await run("not_landed");
      await droppedBundle(bundleRun, 7, [hash("1")]);
      const row = await rowAt(7);
      await db
        .update(ext.pendingTransactions)
        .set({
          bundleRuns: (row?.bundleRuns ?? []).map((entry) => ({
            ...entry,
            signedAt: Date.now() - 25 * HOUR_MS,
          })),
        })
        .where(eq(ext.pendingTransactions.walletAddress, WALLET));

      const next = await startSession(`${PREFIX}fresh`, {
        transactionCount: 7,
        latestBlock: 600,
      });
      await next.manager.recordTransaction(next.session, 7, hash("9"));
      expect(await rowAt(7)).toMatchObject({ bundleRuns: [] });
      await next.manager.endSession(next.session);
    });

    it("caps the history when one nonce is reused 50 times; a recent entry still re-settles", async () => {
      const runs: string[] = [];
      for (let i = 0; i < 50; i += 1) {
        const id = await run("not_landed");
        runs.push(id);
        await missedStep(id, 7, [hashOf(i * 2 + 1), hashOf(i * 2 + 2)]);
      }

      const row = await rowAt(7);
      expect(row?.bundleRuns).toHaveLength(20);
      expect(row?.bundleRuns.at(0)?.executionId).toBe(runs[30]);
      expect(row?.bundleRuns.at(-1)?.executionId).toBe(runs[49]);

      // Nothing mined at 7 yet: only the current bundle's hashes are read.
      const idle = await startSession(`${PREFIX}idle`, {
        transactionCount: 7,
        latestBlock: 600,
      });
      expect(idle.chain.calls.receipts).toBe(0);
      await idle.manager.endSession(idle.session);

      const recent = runs[45] ?? "";
      const after = await startSession(`${PREFIX}landed`, {
        transactionCount: 8,
        latestBlock: 700,
        mined: { [hashOf(45 * 2 + 2)]: 1 },
      });
      // Newest first: runs 49..45, two hashes each, the mined one last.
      expect(after.chain.calls.receipts).toBeLessThanOrEqual(1 + 5 * 2);
      await after.manager.endSession(after.session);

      expect(await statusOf(recent)).toBe("success");
      expect(await statusOf(runs[44] ?? "")).toBe("not_landed");
    });

    it("reads only the current bundle's hashes when its window closes", async () => {
      const old = await run("not_landed");
      await droppedBundle(old, 7, [hash("1"), hash("2")]);
      const current = await run("running");
      const manager = new nonces.NonceManager();
      const first = await manager.startSession(
        WALLET,
        CHAIN_ID,
        current,
        provider({ transactionCount: 7, latestBlock: 100 }) as never
      );
      await manager.recordBundle(first.session, 7, {
        hashes: [hash("3"), hash("4")],
        lastTargetBlock: 102,
      });
      await manager.endSession(first.session);

      const next = await startSession(`${PREFIX}closed`, {
        transactionCount: 7,
        latestBlock: 110,
      });
      expect(next.chain.calls.receipts).toBe(2);
      expect((await rowAt(7))?.status).toBe("dropped");
      await next.manager.endSession(next.session);
    });
  });

  describe("re-settle rules", () => {
    it("two bundle writes: the first landing late leaves the run not landed while the second has not", async () => {
      const bundleRun = await run("not_landed");
      // Nonce 8 first: a session at chain nonce 8 would settle the row at 7.
      await missedStep(bundleRun, 8, [hash("2")], "write-2");
      await missedStep(bundleRun, 7, [hash("1")]);
      await setRow(8, { submittedAt: new Date(Date.now() - 11 * 60_000) });

      // Something else took nonce 8; 7 is the late landing.
      await settleAt({
        transactionCount: 9,
        latestBlock: 600,
        mined: { [hash("1")]: 1 },
      });

      expect((await rowAt(7))?.status).toBe("confirmed");
      expect((await rowAt(8))?.status).toBe("replaced");
      const execution = await executionOf(bundleRun);
      expect(execution?.status).toBe("not_landed");
      // The late step's hash and fee are written; the reason no longer says no gas was paid.
      expect(execution?.transactionHashes).toEqual([
        expect.objectContaining({
          hash: hash("1"),
          nodeId: "write-1",
          receiptStatus: "success",
        }),
      ]);
      expect(execution?.gasUsedWei).toBe(String(FEE_WEI));
      expect(execution?.error).toContain("mined later and paid gas");
      expect(execution?.error).not.toContain("No gas is paid");

      // Settling again adds no hash or fee twice.
      const { settleRun } = await import("@/lib/web3/bundles/late-landing");
      await settleRun(bundleRun, async () => null);
      const again = await executionOf(bundleRun);
      expect(again?.transactionHashes).toHaveLength(1);
      expect(again?.gasUsedWei).toBe(String(FEE_WEI));
    });

    it("two bundle writes: the run becomes a success once both landed", async () => {
      const bundleRun = await run("not_landed");
      // Nonce 8 first: a session at chain nonce 8 would settle the row at 7.
      await missedStep(bundleRun, 8, [hash("2")], "write-2");
      await missedStep(bundleRun, 7, [hash("1")]);

      await settleAt({
        transactionCount: 9,
        latestBlock: 600,
        mined: { [hash("1")]: 1, [hash("2")]: 1 },
      });

      const execution = await executionOf(bundleRun);
      expect(execution?.status).toBe("success");
      expect(
        execution?.transactionHashes.map((entry) => entry.hash).sort()
      ).toEqual([hash("1"), hash("2")]);
      expect(execution?.gasUsedWei).toBe(String(2 * FEE_WEI));
    });

    it("two bundle writes, one landed and one reverted: error, both hashes with their receipts, both fees", async () => {
      const bundleRun = await run("not_landed");
      await missedStep(bundleRun, 8, [hash("2")], "write-2");
      await missedStep(bundleRun, 7, [hash("1")]);

      await settleAt({
        transactionCount: 9,
        latestBlock: 600,
        mined: { [hash("1")]: 1, [hash("2")]: 0 },
      });

      const execution = await executionOf(bundleRun);
      expect(execution?.status).toBe("error");
      expect(execution?.error).toContain(hash("2"));
      expect(
        Object.fromEntries(
          (execution?.transactionHashes ?? []).map((entry) => [
            entry.nodeId,
            entry.receiptStatus,
          ])
        )
      ).toEqual({ "write-1": "success", "write-2": "reverted" });
      expect(execution?.gasUsedWei).toBe(String(2 * FEE_WEI));
    });

    it("a late revert after another step already landed late writes both, with both fees", async () => {
      const bundleRun = await run("not_landed");
      await missedStep(bundleRun, 8, [hash("2")], "write-2");
      await missedStep(bundleRun, 7, [hash("1")]);

      // Nonce 7 lands first; the run waits for nonce 8.
      await settleAt({
        transactionCount: 8,
        latestBlock: 600,
        mined: { [hash("1")]: 1 },
      });
      expect(await statusOf(bundleRun)).toBe("not_landed");

      await settleAt({
        transactionCount: 9,
        latestBlock: 601,
        mined: { [hash("1")]: 1, [hash("2")]: 0 },
      });

      const execution = await executionOf(bundleRun);
      expect(execution?.status).toBe("error");
      expect(
        Object.fromEntries(
          (execution?.transactionHashes ?? []).map((entry) => [
            entry.nodeId,
            entry.receiptStatus,
          ])
        )
      ).toEqual({ "write-1": "success", "write-2": "reverted" });
      expect(execution?.gasUsedWei).toBe(String(2 * FEE_WEI));
    });

    it.each([
      [1, "success"],
      [0, "reverted"],
    ] as const)(
      "a landing after a late revert ended the run is added (receipt %s), once; the run stays error",
      async (receipt, receiptStatus) => {
        const bundleRun = await run("not_landed");
        await missedStep(bundleRun, 8, [hash("2")], "write-2");
        await missedStep(bundleRun, 7, [hash("1")]);

        // Nonce 7 reverts first and ends the run; nonce 8 lands after.
        await settleAt({
          transactionCount: 8,
          latestBlock: 600,
          mined: { [hash("1")]: 0 },
        });
        expect(await statusOf(bundleRun)).toBe("error");
        expect(await executionOf(bundleRun)).toMatchObject({
          gasUsedWei: String(FEE_WEI),
        });

        const view = {
          transactionCount: 9,
          latestBlock: 601,
          mined: { [hash("1")]: 0, [hash("2")]: receipt },
        };
        await settleAt(view);
        sweepChain.view = view;
        const again = await sweep();

        expect(again.runsChecked).toBe(0);
        const execution = await executionOf(bundleRun);
        expect(execution?.status).toBe("error");
        expect(execution?.error).toContain(hash("1"));
        expect(
          Object.fromEntries(
            (execution?.transactionHashes ?? []).map((entry) => [
              entry.nodeId,
              entry.receiptStatus,
            ])
          )
        ).toEqual({ "write-1": "reverted", "write-2": receiptStatus });
        expect(execution?.gasUsedWei).toBe(String(2 * FEE_WEI));
      }
    );

    it("the sweep adds a landing confirmed after a late revert ended the run, once", async () => {
      const bundleRun = await run("not_landed");
      await missedStep(bundleRun, 8, [hash("2")], "write-2");
      await missedStep(bundleRun, 7, [hash("1")]);
      await settleAt({
        transactionCount: 8,
        latestBlock: 600,
        mined: { [hash("1")]: 0 },
      });
      expect(await statusOf(bundleRun)).toBe("error");

      // Confirmed by a session whose settle did not finish.
      await setRow(8, { status: "confirmed", confirmedAt: new Date() });
      sweepChain.view = {
        transactionCount: 9,
        latestBlock: 600,
        mined: { [hash("1")]: 0, [hash("2")]: 1 },
      };
      const first = await sweep();
      const second = await sweep();

      expect(first.runsChecked).toBe(1);
      expect(second.runsChecked).toBe(0);
      const execution = await executionOf(bundleRun);
      expect(execution?.status).toBe("error");
      expect(
        execution?.transactionHashes.map((entry) => entry.hash).sort()
      ).toEqual([hash("1"), hash("2")]);
      expect(execution?.gasUsedWei).toBe(String(2 * FEE_WEI));
    });

    it("a plain error run takes no late landing", async () => {
      const bundleRun = await run("error");
      await missedStep(bundleRun, 7, [hash("1")]);
      await setRow(7, { status: "confirmed", confirmedAt: new Date() });
      sweepChain.view = {
        transactionCount: 8,
        latestBlock: 600,
        mined: { [hash("1")]: 1 },
      };

      const result = await sweep();

      expect(result.runsChecked).toBe(0);
      const execution = await executionOf(bundleRun);
      expect(execution?.transactionHashes ?? []).toEqual([]);
      expect(execution?.gasUsedWei).toBeNull();
    });

    it("a run with a step skipped behind a bundle in flight stays not landed", async () => {
      const bundleRun = await run("not_landed");
      await missedStep(bundleRun, 7, [hash("1")]);
      await logStep(bundleRun, "write-2", { route: "skipped-in-flight" });

      await settleAt({
        transactionCount: 8,
        latestBlock: 600,
        mined: { [hash("1")]: 1 },
      });

      expect((await rowAt(7))?.status).toBe("confirmed");
      expect(await statusOf(bundleRun)).toBe("not_landed");
    });

    it("a run with more not-included steps than bundle rows stays not landed", async () => {
      const bundleRun = await run("not_landed");
      await missedStep(bundleRun, 7, [hash("1")]);
      await logStep(bundleRun, "write-2", NOT_INCLUDED);

      await settleAt({
        transactionCount: 8,
        latestBlock: 600,
        mined: { [hash("1")]: 1 },
      });

      expect(await statusOf(bundleRun)).toBe("not_landed");
    });
  });

  describe("replay of a step that sent its bundle", () => {
    const record = async (executionId: string, nodeId: string) => {
      const manager = new nonces.NonceManager();
      const { session } = await manager.startSession(
        WALLET,
        CHAIN_ID,
        executionId,
        provider({ transactionCount: 7, latestBlock: 100 }) as never
      );
      await manager.recordBundle(session, 7, {
        hashes: [hash("1"), hash("2")],
        lastTargetBlock: 102,
        workflowId: WORKFLOW_ID,
        node: { id: nodeId, name: "Write Contract", iterationIndex: 0 },
      });
      await manager.endSession(session);
    };
    const check = (
      executionId: string,
      nodeId: string,
      iterationIndex = 0,
      sessionNonce?: number
    ) =>
      inFlight.bundleInFlight({
        workflowId: WORKFLOW_ID,
        chainId: CHAIN_ID,
        walletAddress: WALLET.toUpperCase().replace("0X", "0x"),
        step: { executionId, nodeId, iterationIndex },
        readLatestBlock: async () => 500,
        sessionNonce,
      });
    // A crash replay comes minutes after its run started.
    const startedLongAgo = async (executionId: string) => {
      await setRun(executionId, {
        startedAt: new Date(Date.now() - 30 * 60_000),
      });
    };
    // The replay's session: reconcile runs, then the step checks with its nonce.
    const replaySession = async (executionId: string, view: ChainView) => {
      const manager = new nonces.NonceManager();
      const { session } = await manager.startSession(
        WALLET,
        CHAIN_ID,
        executionId,
        provider(view, 1) as never
      );
      await manager.endSession(session);
      return session.currentNonce;
    };

    it("finds its pending row after the window (a crash replay), and its landing once confirmed", async () => {
      const bundleRun = await run("running");
      await startedLongAgo(bundleRun);
      await record(bundleRun, "write-1");
      await setRow(7, { submittedAt: new Date(Date.now() - 10 * 60_000) });
      expect(await check(bundleRun, "write-1")).toEqual({
        kind: "replay",
        nonce: 7,
      });
      expect(await check(bundleRun, "write-1", 1)).toEqual({ kind: "none" });
      expect(await check(bundleRun, "write-2")).toEqual({ kind: "none" });

      await setRow(7, { status: "confirmed", txHash: hash("2") });
      expect(await check(bundleRun, "write-1")).toEqual({
        kind: "replay",
        nonce: 7,
        landedHash: hash("2"),
      });
      // Another run of the workflow is not held by a landed row.
      expect(await check(await run("running"), "write-1")).toEqual({
        kind: "none",
      });
    });

    it("signs again after its row was dropped while the nonce is unused: it reuses that nonce", async () => {
      const bundleRun = await run("running");
      await startedLongAgo(bundleRun);
      await record(bundleRun, "write-1");
      await setRow(7, { status: "dropped" });
      const nonce = await replaySession(bundleRun, {
        transactionCount: 7,
        latestBlock: 500,
      });
      expect(nonce).toBe(7);
      expect(await check(bundleRun, "write-1", 0, nonce)).toEqual({
        kind: "none",
      });
    });

    it("signs nothing for a dropped row whose nonce is used but not proved mined or replaced", async () => {
      const bundleRun = await run("running");
      await startedLongAgo(bundleRun);
      await record(bundleRun, "write-1");
      await setRow(7, { status: "dropped" });
      // Our bundle was mined at 7, but the session's receipt read fails.
      const nonce = await replaySession(bundleRun, {
        transactionCount: 8,
        latestBlock: 500,
        mined: { [hash("2")]: 1 },
      });
      expect(nonce).toBe(8);
      expect((await rowAt(7))?.status).toBe("dropped");
      expect(await check(bundleRun, "write-1", 0, nonce)).toEqual({
        kind: "replay",
        nonce: 7,
      });
      // Before the lock the session nonce is unknown: the check under it decides.
      expect(await check(bundleRun, "write-1")).toEqual({ kind: "none" });
    });

    it("a crash replay signs nothing when its fresh row's receipt lags: one scan never marks it replaced", async () => {
      const bundleRun = await run("running");
      await startedLongAgo(bundleRun);
      await record(bundleRun, "write-1");
      // The bundle landed at 7; another session's backend has no receipt for it yet.
      const other = new nonces.NonceManager();
      const { session: otherSession } = await other.startSession(
        WALLET,
        CHAIN_ID,
        `${PREFIX}lagging-reconcile`,
        provider({ transactionCount: 8, latestBlock: 600 }) as never
      );
      await other.endSession(otherSession);
      expect((await rowAt(7))?.status).toBe("dropped");

      const nonce = await replaySession(bundleRun, {
        transactionCount: 8,
        latestBlock: 600,
      });
      expect((await rowAt(7))?.status).toBe("dropped");
      expect(await check(bundleRun, "write-1", 0, nonce)).toEqual({
        kind: "replay",
        nonce: 7,
      });
    });

    it("signs again once another KeeperHub send took the dropped nonce: the row is that send's now", async () => {
      const bundleRun = await run("running");
      await startedLongAgo(bundleRun);
      await record(bundleRun, "write-1");
      await setRow(7, { status: "dropped" });
      // Another run's normal send reuses nonce 7 and is mined.
      const manager = new nonces.NonceManager();
      const { session } = await manager.startSession(
        WALLET,
        CHAIN_ID,
        await run("running"),
        provider({ transactionCount: 7, latestBlock: 500 }) as never
      );
      await manager.recordTransaction(session, 7, hash("9"));
      await manager.confirmTransaction(hash("9"));
      await manager.endSession(session);
      expect((await rowAt(7))?.status).toBe("confirmed");
      // Our bundle can no longer land at 7: the replay signs again.
      expect(await check(bundleRun, "write-1", 0, 8)).toEqual({ kind: "none" });
      expect(await check(bundleRun, "write-1")).toEqual({ kind: "none" });
    });

    it("returns a decided miss to its replay: the drop marks the step's entry", async () => {
      const bundleRun = await run("running");
      await startedLongAgo(bundleRun);
      const manager = new nonces.NonceManager();
      const { session } = await manager.startSession(
        WALLET,
        CHAIN_ID,
        bundleRun,
        provider({ transactionCount: 7, latestBlock: 100 }) as never
      );
      await manager.recordBundle(session, 7, {
        hashes: [hash("1")],
        lastTargetBlock: 102,
        workflowId: WORKFLOW_ID,
        node: { id: "write-1", name: "Write Contract", iterationIndex: 0 },
      });
      await manager.markNonceDropped(session, 7, "not-picked");
      await manager.endSession(session);
      const row = await rowAt(7);
      expect(row?.status).toBe("dropped");
      expect(row?.bundleRuns.at(-1)?.missed).toBe("not-picked");
      for (const sessionNonce of [undefined, 7, 8]) {
        expect(await check(bundleRun, "write-1", 0, sessionNonce)).toEqual({
          kind: "replay",
          nonce: 7,
          missed: "not-picked",
        });
      }
      // Another step is not this one's replay.
      expect(await check(bundleRun, "write-2", 0, 8)).toEqual({ kind: "none" });
    });

    it("tells a step every hash it signed at the nonce, its earlier send kept in the history", async () => {
      const bundleRun = await run("running");
      await startedLongAgo(bundleRun);
      await record(bundleRun, "write-1");
      await setRow(7, { status: "dropped" });
      const manager = new nonces.NonceManager();
      const { session } = await manager.startSession(
        WALLET,
        CHAIN_ID,
        bundleRun,
        provider({ transactionCount: 7, latestBlock: 500 }) as never
      );
      const node = { id: "write-1", name: "Write Contract", iterationIndex: 0 };
      const step = await manager.recordBundle(session, 7, {
        hashes: [hash("3")],
        lastTargetBlock: 502,
        workflowId: WORKFLOW_ID,
        node,
      });
      // A plain send leaves no row marked: only a bundle's entry carries the miss.
      await manager.markNonceDropped(session, 7);
      await manager.endSession(session);
      expect([...step].sort()).toEqual(
        [hash("1"), hash("2"), hash("3")].sort()
      );
      expect((await rowAt(7))?.bundleRuns.at(-1)?.missed).toBeUndefined();
    });

    it("signs again for a row proved replaced", async () => {
      const bundleRun = await run("running");
      await startedLongAgo(bundleRun);
      await record(bundleRun, "write-1");
      await setRow(7, { status: "replaced" });
      expect(await check(bundleRun, "write-1", 0, 8)).toEqual({ kind: "none" });
    });

    it("reads only rows sent since the run started", async () => {
      const bundleRun = await run("running");
      await record(bundleRun, "write-1");
      await setRow(7, { submittedAt: new Date(Date.now() - 10 * 60_000) });
      expect(await check(bundleRun, "write-1")).toEqual({ kind: "none" });
      await startedLongAgo(bundleRun);
      expect(await check(bundleRun, "write-1")).toEqual({
        kind: "replay",
        nonce: 7,
      });
    });
  });

  describe("sweep", () => {
    it("re-settles an idle wallet's dropped bundle mined later, one read per hash", async () => {
      const bundleRun = await run("not_landed");
      await missedStep(bundleRun, 7, [hash("1"), hash("2")]);
      sweepChain.view = {
        transactionCount: 8,
        latestBlock: 600,
        mined: { [hash("2")]: 1 },
      };

      const sweep = await late.sweepLateBundles(
        new Date(),
        Date.now() + 10_000
      );

      expect(sweep).toEqual({
        examined: 1,
        landed: 1,
        replaced: 0,
        runsChecked: 0,
      });
      expect(sweepChain.receiptReads).toBe(2);
      expect(await rowAt(7)).toMatchObject({
        status: "confirmed",
        txHash: hash("2"),
      });
      expect(await statusOf(bundleRun)).toBe("success");
    });

    // A not-checked step's row, recorded `ageMs` ago and never dropped.
    const notCheckedRow = async (ageMs: number): Promise<string> => {
      const bundleRun = await run("not_landed");
      const manager = new nonces.NonceManager();
      const { session } = await manager.startSession(
        WALLET,
        CHAIN_ID,
        bundleRun,
        provider({ transactionCount: 7, latestBlock: 100 }) as never
      );
      await manager.recordBundle(session, 7, {
        hashes: [hash("1"), hash("2")],
        lastTargetBlock: 102,
        node: { id: "write-1", name: "Write Contract" },
      });
      await manager.endSession(session);
      await logStep(bundleRun, "write-1", {
        route: "bundle",
        notIncludedReason: "not-checked",
      });
      await setRow(7, { submittedAt: new Date(Date.now() - ageMs) });
      return bundleRun;
    };
    // Window (6 x 12 s + 60 s) plus a second.
    const CLOSED_MS = 133_000;

    it("settles a not-checked run whose bundle landed with no later session on the wallet", async () => {
      const bundleRun = await notCheckedRow(CLOSED_MS);
      sweepChain.view = {
        transactionCount: 8,
        latestBlock: 600,
        mined: { [hash("2")]: 1 },
      };
      await sweep();
      expect(await rowAt(7)).toMatchObject({
        status: "confirmed",
        txHash: hash("2"),
      });
      expect(await statusOf(bundleRun)).toBe("success");
    });

    it("drops a closed-window pending row nothing was mined at, as reconcile would", async () => {
      const bundleRun = await notCheckedRow(CLOSED_MS);
      sweepChain.view = { transactionCount: 7, latestBlock: 600 };
      await sweep();
      expect((await rowAt(7))?.status).toBe("dropped");
      expect(await statusOf(bundleRun)).toBe("not_landed");
    });

    it("lets a live holder's confirm win over the sweep's drop by time", async () => {
      const bundleRun = await run("running");
      const manager = new nonces.NonceManager();
      const { session } = await manager.startSession(
        WALLET,
        CHAIN_ID,
        bundleRun,
        provider({ transactionCount: 7, latestBlock: 100 }) as never
      );
      try {
        await manager.recordBundle(session, 7, {
          hashes: [hash("1"), hash("2")],
          lastTargetBlock: 102,
          workflowId: WORKFLOW_ID,
          node: { id: "write-1", name: "Write Contract" },
        });
        await setRow(7, { submittedAt: new Date(Date.now() - CLOSED_MS) });
        sweepChain.view = { transactionCount: 7, latestBlock: 600 };
        await sweep();
        expect((await rowAt(7))?.status).toBe("dropped");
        // The holder's last poll then sees its bundle mined.
        await manager.confirmNonce(session, 7, hash("2"));
      } finally {
        await manager.endSession(session);
      }
      expect(await rowAt(7)).toMatchObject({
        status: "confirmed",
        txHash: hash("2"),
      });
    });

    it("leaves a pending row whose window is still open to its session", async () => {
      await notCheckedRow(10_000);
      sweepChain.view = {
        transactionCount: 8,
        latestBlock: 600,
        mined: { [hash("2")]: 1 },
      };
      await sweep();
      expect((await rowAt(7))?.status).toBe("pending");
    });

    it("reads no receipt while nothing is mined at the nonce", async () => {
      const bundleRun = await run("not_landed");
      await droppedBundle(bundleRun, 7, [hash("1"), hash("2")]);
      sweepChain.view = { transactionCount: 7, latestBlock: 600 };

      const sweep = await late.sweepLateBundles(
        new Date(),
        Date.now() + 10_000
      );

      expect(sweep).toEqual({
        examined: 1,
        landed: 0,
        replaced: 0,
        runsChecked: 0,
      });
      expect(sweepChain.nonceReads).toBe(1);
      expect(sweepChain.receiptReads).toBe(0);
      expect((await rowAt(7))?.status).toBe("dropped");
    });

    it("stops at the deadline", async () => {
      const bundleRun = await run("not_landed");
      await droppedBundle(bundleRun, 7, [hash("1")]);
      sweepChain.view = { transactionCount: 8, latestBlock: 600 };

      const sweep = await late.sweepLateBundles(new Date(), Date.now() - 1);

      expect(sweep.examined).toBe(0);
      expect(sweepChain.nonceReads).toBe(0);
    });

    it("re-settles only from not_landed, and skips rows older than a day", async () => {
      // Nonce 8 first: a session at chain nonce 8 would settle the row at 7.
      const old = await run("not_landed");
      await droppedBundle(old, 8, [hash("4")]);
      const errored = await run("error");
      await droppedBundle(errored, 7, [hash("3")]);
      await db
        .update(ext.pendingTransactions)
        .set({ submittedAt: new Date(Date.now() - 25 * HOUR_MS) })
        .where(
          and(
            eq(ext.pendingTransactions.walletAddress, WALLET),
            eq(ext.pendingTransactions.nonce, 8)
          )
        );
      sweepChain.view = {
        transactionCount: 9,
        latestBlock: 600,
        mined: { [hash("3")]: 1, [hash("4")]: 1 },
      };

      await late.sweepLateBundles(new Date(), Date.now() + 10_000);

      expect((await rowAt(7))?.status).toBe("confirmed");
      expect(await statusOf(errored)).toBe("error");
      expect((await rowAt(8))?.status).toBe("dropped");
      expect(await statusOf(old)).toBe("not_landed");
    });
  });

  describe("leaked transaction in the mempool", () => {
    it("leaves a dropped bundle dropped while the mined count has not passed it, then re-settles when mined", async () => {
      const bundleRun = await run("not_landed");
      await missedStep(bundleRun, 7, [hash("1")]);

      // Pending count 8 (the leaked tx), latest 7: nothing mined at 7 yet.
      await settleAt({ transactionCount: 8, minedCount: 7, latestBlock: 600 });
      expect((await rowAt(7))?.status).toBe("dropped");
      expect(await statusOf(bundleRun)).toBe("not_landed");

      await settleAt({
        transactionCount: 8,
        latestBlock: 601,
        mined: { [hash("1")]: 1 },
      });
      expect((await rowAt(7))?.status).toBe("confirmed");
      expect(await statusOf(bundleRun)).toBe("success");
    });

    it("marks a pending bundle row below the pending count dropped, not replaced", async () => {
      const bundleRun = await run("running");
      const manager = new nonces.NonceManager();
      const first = await manager.startSession(
        WALLET,
        CHAIN_ID,
        bundleRun,
        provider({ transactionCount: 7, latestBlock: 100 }) as never
      );
      await manager.recordBundle(first.session, 7, {
        hashes: [hash("1")],
        lastTargetBlock: 102,
      });
      await manager.endSession(first.session);

      await settleAt({ transactionCount: 8, minedCount: 7, latestBlock: 600 });
      expect((await rowAt(7))?.status).toBe("dropped");
    });
  });

  describe("session receipt scan budget", () => {
    it("leaves a dropped row as it is when the scan runs out of time", async () => {
      const bundleRun = await run("not_landed");
      await missedStep(bundleRun, 7, [hash("1"), hash("2"), hash("3")]);

      const calls = await slowSession(`${PREFIX}slow1`, {
        transactionCount: 8,
        latestBlock: 600,
      });

      expect(calls.receipts).toBe(2);
      expect((await rowAt(7))?.status).toBe("dropped");
    });

    it("marks a pending row below the chain nonce dropped, never replaced, when the history scan runs out of time", async () => {
      // An earlier run's bundle at 7, then this run's own send at 7.
      await droppedBundle(await run("not_landed"), 7, [
        hash("1"),
        hash("2"),
        hash("3"),
      ]);
      const bundleRun = await run("running");
      const manager = new nonces.NonceManager();
      const first = await manager.startSession(
        WALLET,
        CHAIN_ID,
        bundleRun,
        provider({ transactionCount: 7, latestBlock: 100 }) as never
      );
      await manager.recordBundle(first.session, 7, {
        hashes: [hash("4")],
        lastTargetBlock: 102,
      });
      await manager.endSession(first.session);

      const calls = await slowSession(`${PREFIX}slow2`, {
        transactionCount: 8,
        latestBlock: 600,
      });

      // The current send in full, then one history read before the budget ends.
      expect(calls.receipts).toBe(2);
      expect((await rowAt(7))?.status).toBe("dropped");
    });

    it("reads a pending row's current send even after a dropped row used up the budget", async () => {
      // Pending first, with its window open, so the next setup session keeps it.
      const pendingRun = await run("running");
      const manager = new nonces.NonceManager();
      const first = await manager.startSession(
        WALLET,
        CHAIN_ID,
        pendingRun,
        provider({ transactionCount: 7, latestBlock: 100 }) as never
      );
      await manager.recordBundle(first.session, 7, {
        hashes: [hash("5")],
        lastTargetBlock: 102,
      });
      await manager.endSession(first.session);
      await droppedBundle(await run("not_landed"), 6, [
        hash("1"),
        hash("2"),
        hash("3"),
      ]);

      const calls = await slowSession(`${PREFIX}slow3`, {
        transactionCount: 8,
        latestBlock: 600,
        mined: { [hash("5")]: 1 },
      });

      // Two reads for the dropped row at 6, then 7's current send anyway.
      expect(calls.receipts).toBe(3);
      expect((await rowAt(6))?.status).toBe("dropped");
      expect(await rowAt(7)).toMatchObject({
        status: "confirmed",
        txHash: hash("5"),
      });
    });
  });

  describe("re-record at a pending nonce", () => {
    it("keeps the earlier hashes when the same run signs again at its pending nonce", async () => {
      const bundleRun = await run("running");
      const manager = new nonces.NonceManager();
      const { session } = await manager.startSession(
        WALLET,
        CHAIN_ID,
        bundleRun,
        provider({ transactionCount: 7, latestBlock: 100 }) as never
      );
      await manager.recordBundle(session, 7, {
        hashes: [hash("1")],
        lastTargetBlock: 102,
      });
      await manager.recordBundle(session, 7, {
        hashes: [hash("2")],
        lastTargetBlock: 104,
      });
      await manager.endSession(session);

      const row = await rowAt(7);
      expect(row?.bundleRuns.map((entry) => entry.hashes)).toEqual([
        [hash("1")],
        [hash("2")],
      ]);
      expect(row).toMatchObject({ txHash: hash("2"), lastTargetBlock: 104 });
    });

    it("lets another run's record replace a pending row's history, as before", async () => {
      const bundleRun = await run("running");
      const manager = new nonces.NonceManager();
      const first = await manager.startSession(
        WALLET,
        CHAIN_ID,
        bundleRun,
        provider({ transactionCount: 7, latestBlock: 100 }) as never
      );
      await manager.recordBundle(first.session, 7, {
        hashes: [hash("1")],
        lastTargetBlock: 102,
      });
      await manager.endSession(first.session);

      const next = await startSession(`${PREFIX}other`, {
        transactionCount: 7,
        latestBlock: 100,
      });
      await next.manager.recordTransaction(next.session, 7, hash("9"));
      await next.manager.endSession(next.session);

      expect((await rowAt(7))?.bundleRuns).toEqual([]);
    });
  });

  describe("exact match of missed steps", () => {
    it("stays not landed when a missed step's entry was pruned, even with a row that landed on time", async () => {
      const bundleRun = await run("not_landed");
      // Highest nonce first: a session at chain nonce N settles rows below N.
      await missedStep(bundleRun, 7, [hash("c")], "write-c");
      await missedStep(bundleRun, 6, [hash("b")], "write-b");
      // write-a landed on time at 5.
      await droppedBundle(bundleRun, 5, [hash("a")], {
        id: "write-a",
        name: "Write Contract",
      });
      await setRow(5, { status: "confirmed" });
      await logStep(bundleRun, "write-a", { transactionHash: hash("a") });
      // Later reuse pruned write-b's entry out of the row at 6.
      await setRow(6, { bundleRuns: [] });

      await settleAt({
        transactionCount: 8,
        latestBlock: 600,
        mined: { [hash("c")]: 1, [hash("a")]: 1 },
      });

      expect((await rowAt(7))?.status).toBe("confirmed");
      expect(await statusOf(bundleRun)).toBe("not_landed");
    });

    it("appends only the late hash and its fee next to one that landed on time", async () => {
      const bundleRun = await run("not_landed");
      await missedStep(bundleRun, 7, [hash("c")], "write-c");
      await droppedBundle(bundleRun, 6, [hash("a")], {
        id: "write-a",
        name: "Write Contract",
      });
      await setRow(6, { status: "confirmed" });
      await logStep(bundleRun, "write-a", { transactionHash: hash("a") });
      const onTime = {
        hash: hash("a"),
        nodeId: "write-a",
        nodeName: "Write Contract",
        chainId: CHAIN_ID,
        verified: true,
        receiptStatus: "success" as const,
      };
      await setRun(bundleRun, {
        transactionHashes: [onTime],
        gasUsedWei: "100",
      });

      await settleAt({
        transactionCount: 8,
        latestBlock: 600,
        mined: { [hash("c")]: 1, [hash("a")]: 1 },
      });

      const execution = await executionOf(bundleRun);
      expect(execution?.status).toBe("success");
      expect(execution?.transactionHashes.map((entry) => entry.hash)).toEqual([
        hash("a"),
        hash("c"),
      ]);
      expect(execution?.gasUsedWei).toBe(String(100 + FEE_WEI));
    });

    it("records a reverted late landing's hash as reverted and adds its fee", async () => {
      const bundleRun = await run("not_landed");
      await missedStep(bundleRun, 7, [hash("1")]);

      await settleAt({
        transactionCount: 8,
        latestBlock: 600,
        mined: { [hash("1")]: 0 },
      });

      const execution = await executionOf(bundleRun);
      expect(execution?.status).toBe("error");
      expect(execution?.transactionHashes).toEqual([
        expect.objectContaining({
          hash: hash("1"),
          nodeId: "write-1",
          receiptStatus: "reverted",
          verified: true,
        }),
      ]);
      expect(execution?.gasUsedWei).toBe(String(FEE_WEI));
    });

    it("appends no hash or fee twice when a run settles again", async () => {
      const bundleRun = await run("not_landed");
      await missedStep(bundleRun, 7, [hash("1")]);
      await settleAt({
        transactionCount: 8,
        latestBlock: 600,
        mined: { [hash("1")]: 1 },
      });
      expect(await statusOf(bundleRun)).toBe("success");

      await setRun(bundleRun, { status: "not_landed" });
      sweepChain.view = {
        transactionCount: 8,
        latestBlock: 600,
        mined: { [hash("1")]: 1 },
      };
      await sweep();

      const execution = await executionOf(bundleRun);
      expect(execution?.status).toBe("success");
      expect(execution?.transactionHashes).toHaveLength(1);
      expect(execution?.gasUsedWei).toBe(String(FEE_WEI));
    });
  });

  describe("confirmed rows of runs still not landed", () => {
    it.each(["running", "unconfirmed"] as const)(
      "re-settles a run whose bundle was confirmed while it was %s, once it ends not landed",
      async (status) => {
        const bundleRun = await run(status);
        await missedStep(bundleRun, 7, [hash("1")]);
        await settleAt({
          transactionCount: 8,
          latestBlock: 600,
          mined: { [hash("1")]: 1 },
        });
        expect((await rowAt(7))?.status).toBe("confirmed");
        expect(await statusOf(bundleRun)).toBe(status);

        // The run finalizes after its row was confirmed.
        await setRun(bundleRun, { status: "not_landed" });
        sweepChain.view = {
          transactionCount: 8,
          latestBlock: 600,
          mined: { [hash("1")]: 1 },
        };
        const result = await sweep();

        expect(result.runsChecked).toBe(1);
        expect(await statusOf(bundleRun)).toBe("success");
      }
    );

    it("settles on the next sweep when the settle threw after the confirm", async () => {
      const bundleRun = await run("not_landed");
      await missedStep(bundleRun, 8, [hash("2")], "write-2");
      await missedStep(bundleRun, 7, [hash("1")]);
      // 7 was confirmed by an earlier session whose settle never ran.
      await setRow(7, { status: "confirmed", confirmedAt: new Date() });

      // Reads: 8's scan, then the settle's read of 7's receipt fails.
      await settleAt(
        {
          transactionCount: 9,
          latestBlock: 600,
          mined: { [hash("1")]: 1, [hash("2")]: 1 },
        },
        2
      );
      expect((await rowAt(7))?.status).toBe("confirmed");
      expect((await rowAt(8))?.status).toBe("confirmed");
      expect(await statusOf(bundleRun)).toBe("not_landed");

      sweepChain.view = {
        transactionCount: 9,
        latestBlock: 600,
        mined: { [hash("1")]: 1, [hash("2")]: 1 },
      };
      await sweep();

      expect(await statusOf(bundleRun)).toBe("success");
    });

    it("selects rows by their owner, so 201 newer rows of each decoy kind cannot crowd out the real one", async () => {
      const bundleRun = await run("not_landed");
      await missedStep(bundleRun, 7, [hash("1")]);
      await setRow(7, {
        status: "confirmed",
        confirmedAt: new Date(Date.now() - 60_000),
      });
      // Decoys: a later send at a reused nonce (no owner), or another run's
      // bundle signed first (its owner is a success).
      const missed = await run("not_landed");
      const landed = await run("success");
      const signedAt = Date.now();
      await db.insert(ext.pendingTransactions).values(
        Array.from({ length: 402 }, (_, i) => {
          const own = hashOf(1000 + i);
          return {
            walletAddress: WALLET,
            chainId: CHAIN_ID,
            nonce: 100 + i,
            txHash: own,
            executionId: missed,
            status: "confirmed",
            confirmedAt: new Date(),
            bundleRuns:
              i % 2 === 0
                ? [
                    {
                      executionId: missed,
                      hashes: [hashOf(5000 + i)],
                      signedAt,
                    },
                  ]
                : [
                    { executionId: landed, hashes: [own], signedAt },
                    { executionId: missed, hashes: [own], signedAt },
                  ],
          };
        })
      );
      sweepChain.view = {
        transactionCount: 8,
        latestBlock: 600,
        mined: { [hash("1")]: 1 },
      };

      const result = await sweep();

      expect(result.runsChecked).toBe(1);
      expect(await statusOf(bundleRun)).toBe("success");
      expect(await statusOf(missed)).toBe("not_landed");
    });

    it("a run whose other missed step has no confirmed row: the landed one's receipt is read once, its hash and fee written", async () => {
      const bundleRun = await run("not_landed");
      await missedStep(bundleRun, 8, [hash("2")], "write-2");
      await missedStep(bundleRun, 7, [hash("1")]);
      await setRow(7, { status: "confirmed", confirmedAt: new Date() });
      sweepChain.view = {
        transactionCount: 0,
        latestBlock: 600,
        mined: { [hash("1")]: 1 },
      };

      const result = await sweep();

      expect(result.runsChecked).toBe(1);
      expect(sweepChain.receiptReads).toBe(1);
      const execution = await executionOf(bundleRun);
      expect(execution?.status).toBe("not_landed");
      expect(execution?.transactionHashes).toEqual([
        expect.objectContaining({ hash: hash("1"), nodeId: "write-1" }),
      ]);
      expect(execution?.gasUsedWei).toBe(String(FEE_WEI));

      // Listed now: the next sweep reads no receipt and adds nothing.
      sweepChain.receiptReads = 0;
      await sweep();
      expect(sweepChain.receiptReads).toBe(0);
      expect((await executionOf(bundleRun))?.gasUsedWei).toBe(String(FEE_WEI));
    });
  });

  describe("two settles of one run at once", () => {
    it.each([
      ["success", 1, "success"],
      ["a revert", 0, "error"],
    ] as const)(
      "a settle that wrote one landing between the sweep's read and its write: each hash and fee once (%s)",
      async (_label, secondStatus, endStatus) => {
        const { settleRun } = await import("@/lib/web3/bundles/late-landing");
        const bundleRun = await run("not_landed");
        await missedStep(bundleRun, 8, [hash("2")], "write-2");
        await missedStep(bundleRun, 7, [hash("1")]);
        await setRow(7, { status: "confirmed", confirmedAt: new Date() });
        await setRow(8, { status: "confirmed", confirmedAt: new Date() });
        sweepChain.view = {
          transactionCount: 9,
          latestBlock: 600,
          mined: { [hash("1")]: 1, [hash("2")]: secondStatus },
        };
        // While the sweep reads its first receipt, a session's settle sees only
        // step 1 landed (step 2's receipt unread) and writes it, still not landed.
        sweepChain.onReceipt = async () => {
          await settleRun(bundleRun, async (_chainId, h) =>
            h === hash("1")
              ? {
                  hash: h,
                  status: 1,
                  blockNumber: 500,
                  gasUsed: GAS_UNITS,
                  gasPrice: GAS_PRICE,
                }
              : null
          );
        };

        await sweep();

        const between = await executionOf(bundleRun);
        expect(between?.status).toBe("not_landed");
        expect(between?.transactionHashes.map((entry) => entry.hash)).toEqual([
          hash("1"),
        ]);
        expect(between?.gasUsedWei).toBe(String(FEE_WEI));

        // The next sweep settles from the list as it is now.
        await sweep();
        const after = await executionOf(bundleRun);
        expect(after?.status).toBe(endStatus);
        expect(
          after?.transactionHashes.map((entry) => entry.hash).sort()
        ).toEqual([hash("1"), hash("2")].sort());
        expect(after?.gasUsedWei).toBe(String(2 * FEE_WEI));
      }
    );
  });

  describe("sweep end state", () => {
    it("marks a dropped row replaced once its nonce passed long ago and one node holding the block has none of its hashes", async () => {
      const bundleRun = await run("not_landed");
      await missedStep(bundleRun, 7, [hash("1")]);
      await setRow(7, { submittedAt: new Date(Date.now() - 11 * 60_000) });
      sweepChain.view = { transactionCount: 8, latestBlock: 600 };

      const result = await sweep();

      expect(result.replaced).toBe(1);
      expect((await rowAt(7))?.status).toBe("replaced");
      expect(await statusOf(bundleRun)).toBe("not_landed");
    });

    it("leaves a recent row dropped", async () => {
      const bundleRun = await run("not_landed");
      await missedStep(bundleRun, 7, [hash("1")]);
      sweepChain.view = { transactionCount: 8, latestBlock: 600 };

      expect((await sweep()).replaced).toBe(0);
      expect((await rowAt(7))?.status).toBe("dropped");
    });

    it("reads the mined count a few blocks behind the head, and leaves the row when it passed only there", async () => {
      const bundleRun = await run("not_landed");
      await missedStep(bundleRun, 7, [hash("1")]);
      await setRow(7, { submittedAt: new Date(Date.now() - 11 * 60_000) });
      sweepChain.view = {
        transactionCount: 8,
        countAt: (block) => (block >= 598 ? 8 : 7),
        latestBlock: 600,
      };

      expect((await sweep()).replaced).toBe(0);
      expect(sweepChain.countTags).toEqual([597]);
      expect(sweepChain.receiptReads).toBe(0);
      expect((await rowAt(7))?.status).toBe("dropped");
    });

    it("does not mark replaced a row a session sent again at the nonce during the scan", async () => {
      const bundleRun = await run("not_landed");
      await missedStep(bundleRun, 7, [hash("1")]);
      await setRow(7, { submittedAt: new Date(Date.now() - 11 * 60_000) });
      sweepChain.view = { transactionCount: 8, latestBlock: 600 };
      sweepChain.onReceipt = () =>
        setRow(7, { txHash: hash("9"), submittedAt: new Date() });

      expect((await sweep()).replaced).toBe(0);
      expect(await rowAt(7)).toMatchObject({
        status: "dropped",
        txHash: hash("9"),
      });
    });

    it("does not confirm a row a session sent again at the nonce during the scan", async () => {
      const bundleRun = await run("not_landed");
      await missedStep(bundleRun, 7, [hash("1")]);
      sweepChain.view = {
        transactionCount: 8,
        latestBlock: 600,
        mined: { [hash("1")]: 1 },
      };
      sweepChain.onReceipt = () => setRow(7, { txHash: hash("9") });

      expect((await sweep()).landed).toBe(0);
      expect(await rowAt(7)).toMatchObject({
        status: "dropped",
        txHash: hash("9"),
      });
      expect(await statusOf(bundleRun)).toBe("not_landed");
    });

    it("leaves an old row dropped when another node answered its receipt reads", async () => {
      const bundleRun = await run("not_landed");
      await missedStep(bundleRun, 7, [hash("1")]);
      await setRow(7, { submittedAt: new Date(Date.now() - 11 * 60_000) });
      sweepChain.view = { transactionCount: 8, latestBlock: 600 };
      sweepChain.receiptsElsewhere = true;

      expect((await sweep()).replaced).toBe(0);
      expect((await rowAt(7))?.status).toBe("dropped");
    });
  });

  describe("value held by a decided miss", () => {
    const CAP_WEI = "1000";
    // Past the 15-minute in-flight window: only the nonce rule keeps it counting.
    const STALE_MS = 16 * 60_000;
    type Ledger = typeof import("@/lib/execute/value-ledger");
    let ledger: Ledger;
    let backdatedTo = new Date();

    beforeAll(async () => {
      ledger = await import("@/lib/execute/value-ledger");
      await db
        .insert(ext.organizationSpendCaps)
        .values({ organizationId: ORG_ID, dailyValueCapWei: CAP_WEI })
        .onConflictDoUpdate({
          target: ext.organizationSpendCaps.organizationId,
          set: { dailyValueCapWei: CAP_WEI },
        });
    });

    beforeEach(async () => {
      await db
        .delete(ext.orgValueReservations)
        .where(eq(ext.orgValueReservations.organizationId, ORG_ID));
      backdatedTo = new Date(Date.now() - STALE_MS);
    });

    /** Every reservation of the org created at backdatedTo, past the in-flight window. */
    async function backdateAll(): Promise<void> {
      await db
        .update(ext.orgValueReservations)
        .set({ createdAt: backdatedTo })
        .where(eq(ext.orgValueReservations.organizationId, ORG_ID));
    }

    // Reads the cap as on the backdated rows' UTC day, so the rule is pinned at any hour.
    async function onBackdatedDay<T>(read: () => Promise<T>): Promise<T> {
      vi.useFakeTimers({
        toFake: ["Date"],
        now: backdatedTo.getTime() + 1000,
      });
      try {
        return await read();
      } finally {
        vi.useRealTimers();
      }
    }

    const usedToday = (): Promise<bigint> =>
      onBackdatedDay(() => ledger.sumOrgValueTodayWei(db, ORG_ID));

    const reserve = (valueWei: string) =>
      onBackdatedDay(() =>
        ledger.reserveOrgValue({ organizationId: ORG_ID, valueWei })
      );

    async function statusOfReservation(id: string): Promise<string> {
      const [row] = await db
        .select()
        .from(ext.orgValueReservations)
        .where(eq(ext.orgValueReservations.id, id));
      return row?.status ?? "missing";
    }

    /** Record a bundle at `nonce` for the reservation, as the step does, then drop it as decided. */
    async function recordMiss(
      executionId: string,
      options: {
        reservationId?: string;
        nonce?: number;
        hashes?: string[];
        missed?: "not-picked" | "no-builder-accepted";
      } = {}
    ): Promise<void> {
      const nonce = options.nonce ?? 7;
      const manager = new nonces.NonceManager();
      const { session } = await manager.startSession(
        WALLET,
        CHAIN_ID,
        executionId,
        provider({ transactionCount: nonce, latestBlock: 100 }) as never
      );
      await manager.recordBundle(session, nonce, {
        hashes: options.hashes ?? [hash("1")],
        lastTargetBlock: 102,
        node: { id: "write-1", name: "Write Contract" },
        ...(options.reservationId && {
          valueReservationId: options.reservationId,
        }),
      });
      await manager.markNonceDropped(
        session,
        nonce,
        options.missed ?? "not-picked"
      );
      await manager.endSession(session);
    }

    /** A bundle step whose miss is decided, as Write Contract ends it. */
    async function missAtCap(
      executionId: string,
      options: { valueWei?: string; nonce?: number; hashes?: string[] } = {}
    ): Promise<string> {
      let reservationId: string | undefined;
      const { bundleReservationEnd } = await import(
        "@/lib/workflow/executor/run-outcome-keys"
      );
      await ledger.withValueCap(
        {
          organizationId: ORG_ID,
          valueWei: options.valueWei ?? CAP_WEI,
          ref: executionId,
        },
        async (id) => {
          reservationId = id;
          await recordMiss(executionId, { ...options, reservationId: id });
          return { success: true, ...NOT_INCLUDED, included: false };
        },
        bundleReservationEnd
      );
      if (!reservationId) {
        throw new Error("no reservation was made");
      }
      await backdateAll();
      return reservationId;
    }

    it("keeps the reservation of a not-picked bundle at the cap; a second send is refused with the wallet, network and how the hold ends", async () => {
      const bundleRun = await run("not_landed");
      const id = await missAtCap(bundleRun);

      expect(await statusOfReservation(id)).toBe("held");
      const [row] = await db
        .select()
        .from(ext.orgValueReservations)
        .where(eq(ext.orgValueReservations.id, id));
      expect(row).toMatchObject({
        bundleChainId: CHAIN_ID,
        bundleWalletAddress: WALLET,
        bundleNonce: 7,
      });
      expect(await usedToday()).toBe(BigInt(CAP_WEI));

      const second = await reserve("1");
      expect(second.allowed).toBe(false);
      const reason = second.allowed ? "" : second.reason;
      expect(reason).toMatch(/^Daily spending cap exceeded: /);
      expect(reason).toContain(
        "held by Send as Bundle steps whose signed transactions have not been mined"
      );
      expect(reason).toContain(`from wallet ${WALLET} on `);
      expect(reason).toContain(
        "(for example a Normal transaction with no value, sent once the bundle step has finished) or the UTC day ends, whichever comes first"
      );
    });

    it("counts two misses at one nonce once, as the larger: only one can be mined", async () => {
      await missAtCap(await run("not_landed"), {
        valueWei: "300",
        hashes: [hash("1")],
      });
      await missAtCap(await run("not_landed"), {
        valueWei: "500",
        hashes: [hash("2")],
      });

      expect(await usedToday()).toBe(BigInt(500));
      // The same value again at the reused nonce still fits under the cap.
      expect((await reserve("500")).allowed).toBe(true);
    });

    it("counts a recorded bundle whose runner died (still reserved, past 15 min) while its row is dropped", async () => {
      const bundleRun = await run("running");
      const reserved = await ledger.reserveOrgValue({
        organizationId: ORG_ID,
        valueWei: CAP_WEI,
        ref: bundleRun,
      });
      if (!reserved.allowed) {
        throw new Error("expected a reservation");
      }
      // The pod died after recording: nothing ended the reservation.
      await recordMiss(bundleRun, { reservationId: reserved.reservationId });
      await backdateAll();

      expect(await statusOfReservation(reserved.reservationId)).toBe(
        "reserved"
      );
      expect((await rowAt(7))?.status).toBe("dropped");
      expect(await usedToday()).toBe(BigInt(CAP_WEI));

      // Once another transaction used the nonce it stops counting.
      await setRow(7, { status: "replaced" });
      expect(await usedToday()).toBe(BigInt(0));
    });

    it("still lets an unrecorded stale reservation lapse after 15 minutes", async () => {
      await ledger.reserveOrgValue({ organizationId: ORG_ID, valueWei: "400" });
      await backdateAll();
      expect(await usedToday()).toBe(BigInt(0));
    });

    it("a crash replay of a decided miss neither double-counts nor loses the value, landed late or not", async () => {
      const bundleRun = await run("running");
      const first = await ledger.reserveOrgValue({
        organizationId: ORG_ID,
        valueWei: "400",
        ref: bundleRun,
      });
      if (!first.allowed) {
        throw new Error("expected a reservation");
      }
      await recordMiss(bundleRun, { reservationId: first.reservationId });

      // The replay (with room under the cap): its own reservation joins the row's nonce, then holds.
      const { bundleReservationEnd } = await import(
        "@/lib/workflow/executor/run-outcome-keys"
      );
      let replayId: string | undefined;
      await ledger.withValueCap(
        { organizationId: ORG_ID, valueWei: "400", ref: bundleRun },
        async (id) => {
          replayId = id;
          const found = await inFlight.bundleInFlight({
            workflowId: WORKFLOW_ID,
            chainId: CHAIN_ID,
            walletAddress: WALLET,
            step: { executionId: bundleRun, nodeId: "write-1" },
            readLatestBlock: async () => 100,
          });
          if (found.kind !== "replay" || !id) {
            throw new Error("expected a replay");
          }
          await nonces.linkBundleReservation(id, {
            chainId: CHAIN_ID,
            walletAddress: WALLET,
            nonce: found.nonce,
          });
          return { success: true, ...NOT_INCLUDED, included: false };
        },
        bundleReservationEnd
      );
      await backdateAll();
      expect(replayId && (await statusOfReservation(replayId))).toBe("held");
      expect(await usedToday()).toBe(BigInt(400));

      // The crashed attempt had been released (a throw): the replay's still counts.
      await db
        .update(ext.orgValueReservations)
        .set({ status: "released" })
        .where(eq(ext.orgValueReservations.id, first.reservationId));
      expect(await usedToday()).toBe(BigInt(400));

      // Landed late with the run's hash: counted once.
      await setRow(7, { status: "confirmed", txHash: hash("1") });
      expect(await usedToday()).toBe(BigInt(400));
    });

    it("holds a bundle no builder accepted: each builder still read its signed bytes", async () => {
      const bundleRun = await run("error");
      const { bundleReservationEnd } = await import(
        "@/lib/workflow/executor/run-outcome-keys"
      );
      let reservationId: string | undefined;
      await ledger.withValueCap(
        { organizationId: ORG_ID, valueWei: CAP_WEI, ref: bundleRun },
        async (id) => {
          reservationId = id;
          await recordMiss(bundleRun, {
            reservationId: id,
            missed: "no-builder-accepted",
          });
          return {
            success: false,
            route: "bundle",
            included: false,
            broadcastAttempted: true,
          };
        },
        bundleReservationEnd
      );
      await backdateAll();
      expect(reservationId && (await statusOfReservation(reservationId))).toBe(
        "held"
      );
      expect(await usedToday()).toBe(BigInt(CAP_WEI));
    });

    it("frees the value once another transaction used the nonce (row replaced)", async () => {
      const bundleRun = await run("not_landed");
      await missAtCap(bundleRun);
      await setRow(7, { submittedAt: new Date(Date.now() - 11 * 60_000) });

      await settleAt({ transactionCount: 8, latestBlock: 600 });

      expect((await rowAt(7))?.status).toBe("replaced");
      expect(await usedToday()).toBe(BigInt(0));
      expect((await reserve(CAP_WEI)).allowed).toBe(true);
    });

    it("frees the value once another send at the nonce is confirmed", async () => {
      const bundleRun = await run("not_landed");
      await missAtCap(bundleRun);
      // Another send took the dropped nonce (the bundle history is kept), then was mined.
      await setRow(7, { status: "pending", txHash: hash("9") });
      expect(await usedToday()).toBe(BigInt(CAP_WEI));
      await setRow(7, { status: "confirmed" });

      expect(await usedToday()).toBe(BigInt(0));
    });

    it("counts a late landing once: the hold stays, nothing is charged again", async () => {
      const bundleRun = await run("not_landed");
      await missAtCap(bundleRun);
      await logStep(bundleRun, "write-1", NOT_INCLUDED);

      await settleAt({
        transactionCount: 8,
        latestBlock: 600,
        mined: { [hash("1")]: 1 },
      });

      expect(await statusOf(bundleRun)).toBe("success");
      expect((await rowAt(7))?.status).toBe("confirmed");
      expect(await usedToday()).toBe(BigInt(CAP_WEI));
      const rows = await db
        .select()
        .from(ext.orgValueReservations)
        .where(eq(ext.orgValueReservations.organizationId, ORG_ID));
      expect(rows).toHaveLength(1);
    });

    it("a retry that lands at the reused nonce counts alone: the earlier, larger miss there counts 0", async () => {
      await missAtCap(await run("not_landed"), { valueWei: "600" });
      const retryRun = await run("running");
      await ledger.withValueCap(
        { organizationId: ORG_ID, valueWei: "300", ref: retryRun },
        async (id) => {
          const manager = new nonces.NonceManager();
          const { session } = await manager.startSession(
            WALLET,
            CHAIN_ID,
            retryRun,
            provider({ transactionCount: 7, latestBlock: 100 }) as never
          );
          await manager.recordBundle(session, 7, {
            hashes: [hash("2")],
            lastTargetBlock: 102,
            node: { id: "write-1", name: "Write Contract" },
            ...(id && { valueReservationId: id }),
          });
          await manager.confirmNonce(session, 7, hash("2"));
          await manager.endSession(session);
          return { success: true, route: "bundle", included: true };
        }
      );
      await backdateAll();
      expect(await usedToday()).toBe(BigInt(300));
    });

    it("keeps the hold when later sends push its entry out of the row's history", async () => {
      await missAtCap(await run("not_landed"), { valueWei: "400" });
      for (let i = 0; i < 21; i += 1) {
        await droppedBundle(await run("not_landed"), 7, [hashOf(1000 + i)]);
      }
      const entries = (await rowAt(7))?.bundleRuns ?? [];
      expect(entries.some((entry) => entry.hashes.includes(hash("1")))).toBe(
        false
      );
      expect(await usedToday()).toBe(BigInt(400));
    });
  });

  describe("finish aggregate", () => {
    it("reads gas and the outcome of every pod's successful Write Contract steps in one query", async () => {
      const facts = await import("@/lib/workflow/executor/success-log-facts");
      const finished = await run("running");
      await logStep(finished, "write-1", NOT_INCLUDED, {
        output: { gasUsed: "100" },
      });
      await logStep(
        finished,
        "transfer-1",
        { transactionHash: hash("e") },
        { nodeType: "web3/transfer-funds", output: { gasUsed: "50" } }
      );
      await logStep(
        finished,
        "http-1",
        { route: "skipped-in-flight" },
        { nodeType: "http-request" }
      );
      await logStep(
        finished,
        "write-2",
        { route: "skipped-in-flight" },
        { status: "error" }
      );

      expect(await facts.loadFinishLogFacts(finished)).toEqual({
        gasUsedWei: "150",
        signals: {
          skippedInFlight: false,
          notIncluded: true,
          waiting: false,
          bundleSent: true,
        },
      });
    });
  });

  describe("public copies", () => {
    const H1 = hash("1");
    const H2 = hash("2");
    const H3 = hash("3");
    const OLD_MS = 5 * 60_000;

    /** A bundle `executionId` recorded at nonce 7 and sent publicly (the last target's bytes), `ageMs` ago. */
    async function publicRow(
      executionId: string,
      options: { ageMs?: number; copy?: string; via?: "user" | "platform" } = {}
    ) {
      const manager = new nonces.NonceManager();
      const { session } = await manager.startSession(
        WALLET,
        CHAIN_ID,
        executionId,
        provider({ transactionCount: 7, latestBlock: 100 }) as never
      );
      await manager.recordBundle(session, 7, {
        hashes: [H1, H2, H3],
        lastTargetBlock: 102,
        workflowId: WORKFLOW_ID,
        node: { id: "write-1", name: "Write Contract" },
      });
      const marked = await manager.markPublicCopy(session, 7, {
        hash: options.copy ?? H3,
        kind: "fallback",
        ...(options.via && { via: options.via }),
      });
      await manager.endSession(session);
      await setRow(7, {
        submittedAt: new Date(Date.now() - (options.ageMs ?? OLD_MS)),
      });
      return { manager, session, marked };
    }

    it("records the copy before it is sent: the row's hash, and its newest entry", async () => {
      const bundleRun = await run("running");
      const { marked } = await publicRow(bundleRun);
      expect(marked).toBe(true);
      const row = await rowAt(7);
      expect(row?.txHash).toBe(H3);
      expect(row?.status).toBe("pending");
      expect(row?.bundleRuns.at(-1)?.public).toEqual({
        hash: H3,
        kind: "fallback",
        at: expect.any(Number),
      });
      expect(
        await new nonces.NonceManager().pendingPublicCopyHash(
          WALLET.toUpperCase().replace("0X", "0x"),
          CHAIN_ID,
          7
        )
      ).toBe(H3);
    });

    it("records nothing on a row this session does not own, or one no longer pending", async () => {
      const bundleRun = await run("running");
      const { manager, session } = await publicRow(bundleRun);
      const stranger = { ...session, executionId: `${bundleRun}_other` };
      expect(
        await manager.markPublicCopy(stranger, 7, {
          hash: H1,
          kind: "with-bundle",
        })
      ).toBe(false);
      await setRow(7, { status: "dropped" });
      expect(
        await manager.markPublicCopy(session, 7, {
          hash: H1,
          kind: "with-bundle",
        })
      ).toBe(false);
      expect((await rowAt(7))?.txHash).toBe(H3);
    });

    it("a session keeps the row pending while its copy is pooled: the pending count includes it", async () => {
      const bundleRun = await run("unconfirmed");
      await publicRow(bundleRun);
      // The pool holds the copy: pending count 8, mined 7, long past the window.
      const { manager, session, validation } = await startSession(
        `${PREFIX}next_pub`,
        { transactionCount: 8, minedCount: 7, latestBlock: 600 }
      );
      expect((await rowAt(7))?.status).toBe("pending");
      expect(session.currentNonce).toBe(8);
      expect(validation.warnings.join(" ")).toContain("not mined yet");
      await manager.endSession(session);
    });

    it("the same row without its copy is dropped there, as before", async () => {
      const bundleRun = await run("not_landed");
      await publicRow(bundleRun);
      const owner = new nonces.NonceManager();
      await owner.markPublicCopyRefused(
        {
          walletAddress: WALLET,
          chainId: CHAIN_ID,
          executionId: bundleRun,
        } as never,
        7
      );
      expect((await rowAt(7))?.bundleRuns.at(-1)?.public?.accepted).toBe(false);
      const { manager, session } = await startSession(`${PREFIX}next_ref`, {
        transactionCount: 8,
        minedCount: 7,
        latestBlock: 600,
      });
      expect((await rowAt(7))?.status).toBe("dropped");
      await manager.endSession(session);
    });

    it("a session confirms the row once mined, by whichever of its hashes was", async () => {
      const bundleRun = await run("unconfirmed");
      await publicRow(bundleRun);
      const { manager, session } = await startSession(`${PREFIX}next_mined`, {
        transactionCount: 8,
        minedCount: 8,
        latestBlock: 600,
        mined: { [H3]: 1 },
      });
      expect(await rowAt(7)).toMatchObject({ status: "confirmed", txHash: H3 });
      await manager.endSession(session);
    });

    it("other runs of the workflow skip behind the copy until the wallet's mined count passes it", async () => {
      const bundleRun = await run("unconfirmed");
      await publicRow(bundleRun, { ageMs: 60 * 60_000 });
      const check = (mined: number) =>
        inFlight.bundleInFlight({
          workflowId: WORKFLOW_ID,
          chainId: CHAIN_ID,
          walletAddress: WALLET,
          step: { executionId: `${PREFIX}later`, nodeId: "write-1" },
          readLatestBlock: async () => 900,
          readMinedCount: async () => mined,
        });
      expect(await check(7)).toEqual({ kind: "other", publicHash: H3 });
      expect(await check(8)).toEqual({ kind: "none" });
      // Not past a day.
      await setRow(7, { submittedAt: new Date(Date.now() - 25 * HOUR_MS) });
      expect(await check(7)).toEqual({ kind: "none" });
    });

    it("a replay of its step returns the copy's hash, pending or dropped", async () => {
      const bundleRun = await run("running");
      await setRun(bundleRun, {
        startedAt: new Date(Date.now() - 30 * 60_000),
      });
      await publicRow(bundleRun);
      const check = () =>
        inFlight.bundleInFlight({
          workflowId: WORKFLOW_ID,
          chainId: CHAIN_ID,
          walletAddress: WALLET,
          step: { executionId: bundleRun, nodeId: "write-1" },
          readLatestBlock: async () => 900,
        });
      expect(await check()).toEqual({
        kind: "replay",
        nonce: 7,
        publicHash: H3,
      });
      await setRow(7, { status: "dropped" });
      expect(await check()).toEqual({
        kind: "replay",
        nonce: 7,
        publicHash: H3,
      });
    });

    const publicOf = async () => (await rowAt(7))?.bundleRuns.at(-1)?.public;

    it("the sweep leaves the row pending past its window and counts a miss when the primary and the fallback answer no; an extra's error is left out", async () => {
      const bundleRun = await run("unconfirmed");
      await publicRow(bundleRun);
      sweepChain.view = { transactionCount: 7, latestBlock: 600 };
      // A send-only extra that errors every time never holds the count back.
      sweepChain.seen = { primary: false, fallback: false, extra: "error" };
      for (let i = 1; i < late.PUBLIC_COPY_MISSES_TO_DROP; i += 1) {
        await sweep();
        expect((await publicOf())?.misses).toBe(i);
        expect((await rowAt(7))?.status).toBe("pending");
      }
      await sweep();
      expect(await rowAt(7)).toMatchObject({ status: "dropped" });
      expect((await publicOf())?.misses).toBe(late.PUBLIC_COPY_MISSES_TO_DROP);
    });

    it.each([
      ["the primary", { primary: true, fallback: false, extra: false }],
      ["the fallback", { primary: false, fallback: true, extra: false }],
      ["an extra", { primary: false, fallback: false, extra: true }],
    ] as const)("seen on %s, the count starts again", async (_name, seen) => {
      const bundleRun = await run("unconfirmed");
      await publicRow(bundleRun);
      sweepChain.view = { transactionCount: 7, latestBlock: 600 };
      await sweep();
      await sweep();
      expect((await publicOf())?.misses).toBe(2);
      sweepChain.seen = { ...seen };
      await sweep();
      expect((await publicOf())?.misses).toBe(0);
      expect((await rowAt(7))?.status).toBe("pending");
    });

    it.each([
      ["the primary", { primary: "error", fallback: false, extra: false }],
      ["the fallback", { primary: false, fallback: "error", extra: false }],
    ] as const)(
      "an error from %s is unclear: no miss, the unclear count goes up to its cap, one warning",
      async (_name, seen) => {
        const { logWarn } = await import("@/lib/logging");
        const unclearWarnings = () =>
          vi
            .mocked(logWarn)
            .mock.calls.filter(([message]) =>
              message.includes("Public copy unclear")
            ).length;
        const warnedBefore = unclearWarnings();
        const bundleRun = await run("unconfirmed");
        await publicRow(bundleRun);
        sweepChain.view = { transactionCount: 7, latestBlock: 600 };
        await sweep();
        expect((await publicOf())?.misses).toBe(1);
        sweepChain.seen = { ...seen };
        for (let i = 1; i <= 2; i += 1) {
          await sweep();
        }
        expect(unclearWarnings()).toBe(warnedBefore);
        for (let i = 3; i <= 5; i += 1) {
          await sweep();
        }
        // Stored no higher than the warning's count, and warned once.
        expect(await publicOf()).toMatchObject({ misses: 1, unclear: 3 });
        expect(unclearWarnings()).toBe(warnedBefore + 1);
        expect((await rowAt(7))?.status).toBe("pending");
        // A clear answer again resets it.
        sweepChain.seen = { primary: false, fallback: false, extra: false };
        await sweep();
        expect(await publicOf()).toMatchObject({ misses: 2, unclear: 0 });
      }
    );

    it("a drop ends the copy's unconfirmed run Not landed and takes its unread hash off the run", async () => {
      const bundleRun = await run("unconfirmed");
      await setRun(bundleRun, {
        transactionHashes: [
          {
            hash: H3,
            nodeId: "write-1",
            nodeName: "Write Contract",
            chainId: CHAIN_ID,
            receiptStatus: "not_found",
          },
          {
            hash: hash("9"),
            nodeId: "other",
            nodeName: "Other",
            chainId: CHAIN_ID,
            verified: true,
            receiptStatus: "success",
          },
        ],
      });
      await publicRow(bundleRun);
      sweepChain.view = { transactionCount: 7, latestBlock: 600 };
      for (let i = 0; i < late.PUBLIC_COPY_MISSES_TO_DROP; i += 1) {
        await sweep();
      }
      expect((await rowAt(7))?.status).toBe("dropped");
      const settled = await executionOf(bundleRun);
      expect(settled).toMatchObject({
        status: "not_landed",
        error: expect.stringContaining(
          "Its public copy was not found on any RPC for three checks"
        ),
      });
      expect(settled?.completedAt).toBeInstanceOf(Date);
      expect(settled?.transactionHashes?.map((entry) => entry.hash)).toEqual([
        hash("9"),
      ]);
    });

    it("a drop leaves a run held open by its own failure, or already settled, as it is", async () => {
      const failed = await run("unconfirmed");
      await setRun(failed, { errorType: "user" as never, error: "boom" });
      await publicRow(failed);
      sweepChain.view = { transactionCount: 7, latestBlock: 600 };
      for (let i = 0; i < late.PUBLIC_COPY_MISSES_TO_DROP; i += 1) {
        await sweep();
      }
      expect((await rowAt(7))?.status).toBe("dropped");
      expect(await statusOf(failed)).toBe("unconfirmed");
    });

    it("a copy dropped and then mined late re-settles its run through the late-landing path", async () => {
      const bundleRun = await run("unconfirmed");
      await logStep(bundleRun, "write-1", {
        success: true,
        route: "bundle",
        included: false,
        pending: true,
        transactionHash: H3,
      });
      await publicRow(bundleRun);
      sweepChain.view = { transactionCount: 7, latestBlock: 600 };
      for (let i = 0; i < late.PUBLIC_COPY_MISSES_TO_DROP; i += 1) {
        await sweep();
      }
      expect(await statusOf(bundleRun)).toBe("not_landed");
      sweepChain.view = {
        transactionCount: 8,
        countAt: () => 8,
        latestBlock: 700,
        mined: { [H3]: 1 },
      };
      await sweep();
      expect(await rowAt(7)).toMatchObject({ status: "confirmed", txHash: H3 });
      const settled = await executionOf(bundleRun);
      expect(settled?.status).toBe("success");
      expect(settled?.transactionHashes).toEqual([
        expect.objectContaining({ hash: H3, receiptStatus: "success" }),
      ]);
      expect(String(settled?.gasUsedWei)).toBe(String(FEE_WEI));
    });

    it("a copy sent through the user's own RPC never counts a miss and stays pending to the day's end", async () => {
      const bundleRun = await run("unconfirmed");
      await publicRow(bundleRun, { via: "user" });
      expect((await publicOf())?.via).toBe("user");
      sweepChain.view = { transactionCount: 7, latestBlock: 600 };
      for (let i = 0; i < late.PUBLIC_COPY_MISSES_TO_DROP + 1; i += 1) {
        await sweep();
      }
      // The copy is never looked up on the platform's endpoints.
      expect(sweepChain.copyReads).toEqual({ primary: 0, fallback: 0 });
      expect((await rowAt(7))?.status).toBe("pending");
      expect((await publicOf())?.misses).toBeUndefined();
      // Mined: still confirmed from the chain's receipts.
      sweepChain.view = {
        transactionCount: 8,
        countAt: () => 8,
        latestBlock: 600,
        mined: { [H3]: 1 },
      };
      await sweep();
      expect(await rowAt(7)).toMatchObject({ status: "confirmed", txHash: H3 });
    });

    // The run as the finalizer left it: the copy's hash listed, unread.
    const copyEntry = {
      hash: H3,
      nodeId: "write-1",
      nodeName: "Write Contract",
      chainId: CHAIN_ID,
      verified: false,
      receiptStatus: "not_found" as const,
    };

    it("the nonce mined with none of the row's hashes found: replaced on proof, never miss-count dropped; its run ends Not landed", async () => {
      const bundleRun = await run("unconfirmed");
      await setRun(bundleRun, { transactionHashes: [copyEntry] });
      await publicRow(bundleRun, { ageMs: 15 * 60_000 });
      sweepChain.view = {
        transactionCount: 8,
        countAt: () => 8,
        latestBlock: 600,
      };
      await sweep();
      expect((await rowAt(7))?.status).toBe("replaced");
      expect((await publicOf())?.misses).toBeUndefined();
      const settled = await executionOf(bundleRun);
      expect(settled).toMatchObject({
        status: "not_landed",
        error:
          "Not landed: a bundle in this run was not seen in any of the blocks it was sent for. Another transaction from the wallet used its nonce first, so its public copy can no longer be mined; no gas was paid for it.",
        transactionHashes: [],
      });
    });

    it("a session that proves the copy replaced ends its run Not landed too", async () => {
      const bundleRun = await run("unconfirmed");
      await setRun(bundleRun, { transactionHashes: [copyEntry] });
      await publicRow(bundleRun, { ageMs: 15 * 60_000 });
      const { manager, session, validation } = await startSession(
        `${PREFIX}next_repl`,
        { transactionCount: 8, minedCount: 8, latestBlock: 600 }
      );
      await manager.endSession(session);
      expect((await rowAt(7))?.status).toBe("replaced");
      expect(validation.warnings.join(" ")).toContain("was replaced");
      expect(await executionOf(bundleRun)).toMatchObject({
        status: "not_landed",
        error: expect.stringContaining(
          "Another transaction from the wallet used its nonce first"
        ),
      });
    });

    it("a mixed run (another send not verified yet) is left to the reconciler when its copy drops", async () => {
      const bundleRun = await run("unconfirmed");
      await setRun(bundleRun, {
        transactionHashes: [
          copyEntry,
          {
            hash: hash("9"),
            nodeId: "other",
            nodeName: "Other",
            chainId: CHAIN_ID,
            verified: false,
            receiptStatus: "not_found",
          },
        ],
      });
      await publicRow(bundleRun);
      sweepChain.view = { transactionCount: 7, latestBlock: 600 };
      for (let i = 0; i < late.PUBLIC_COPY_MISSES_TO_DROP; i += 1) {
        await sweep();
      }
      expect((await rowAt(7))?.status).toBe("dropped");
      const left = await executionOf(bundleRun);
      expect(left?.status).toBe("unconfirmed");
      expect(left?.transactionHashes).toHaveLength(2);
    });

    it("failed over, the fallback's no is unclear: no miss, and a seen still resets", async () => {
      const bundleRun = await run("unconfirmed");
      await publicRow(bundleRun);
      sweepChain.view = { transactionCount: 7, latestBlock: 600 };
      await sweep();
      expect((await publicOf())?.misses).toBe(1);
      sweepChain.failedOver = true;
      for (let i = 0; i < late.PUBLIC_COPY_MISSES_TO_DROP; i += 1) {
        await sweep();
      }
      expect(await publicOf()).toMatchObject({ misses: 1, unclear: 3 });
      expect((await rowAt(7))?.status).toBe("pending");
      // Asked once per sweep: the fallback is not asked twice, the primary not at all.
      expect(sweepChain.copyReads.primary).toBe(1);
      expect(sweepChain.copyReads.fallback).toBe(
        1 + late.PUBLIC_COPY_MISSES_TO_DROP
      );
      sweepChain.seen = { primary: false, fallback: true, extra: false };
      await sweep();
      expect(await publicOf()).toMatchObject({ misses: 0, unclear: 0 });
    });

    it("with no fallback configured, the primary alone decides", async () => {
      const bundleRun = await run("unconfirmed");
      await publicRow(bundleRun);
      sweepChain.noFallback = true;
      sweepChain.view = { transactionCount: 7, latestBlock: 600 };
      for (let i = 0; i < late.PUBLIC_COPY_MISSES_TO_DROP; i += 1) {
        await sweep();
      }
      expect((await rowAt(7))?.status).toBe("dropped");
      expect(sweepChain.copyReads).toEqual({
        primary: late.PUBLIC_COPY_MISSES_TO_DROP,
        fallback: 0,
      });
    });

    it("the nonce mined with none found, too young for proof: left pending, no miss", async () => {
      const bundleRun = await run("unconfirmed");
      await publicRow(bundleRun);
      sweepChain.view = {
        transactionCount: 8,
        countAt: () => 8,
        latestBlock: 600,
      };
      await sweep();
      await sweep();
      await sweep();
      expect((await rowAt(7))?.status).toBe("pending");
      expect((await publicOf())?.misses).toBeUndefined();
    });

    it("marks a copy never sent only on its own pending row", async () => {
      const bundleRun = await run("running");
      const { manager, session } = await publicRow(bundleRun);
      await manager.markPublicCopyRefused(
        { ...session, executionId: `${bundleRun}_other` },
        7
      );
      expect((await publicOf())?.accepted).toBeUndefined();
      await setRow(7, { status: "dropped" });
      await manager.markPublicCopyRefused(session, 7);
      expect((await publicOf())?.accepted).toBeUndefined();
      await setRow(7, { status: "pending" });
      await manager.markPublicCopyRefused(session, 7);
      expect((await publicOf())?.accepted).toBe(false);
    });

    it("a session leaves a public row older than a day to the plain bundle rules (dropped)", async () => {
      const bundleRun = await run("unconfirmed");
      await publicRow(bundleRun, { ageMs: 25 * HOUR_MS });
      const { manager, session, validation } = await startSession(
        `${PREFIX}next_old`,
        { transactionCount: 8, minedCount: 7, latestBlock: 600 }
      );
      await manager.endSession(session);
      expect(validation.warnings.join(" ")).not.toContain("not mined yet");
      // Past the day the sweep and in-flight stop too: the window rule frees the nonce.
      expect((await rowAt(7))?.status).toBe("dropped");
    });

    it("livePublicCopy and livePublicCopySql agree on every shape of row", async () => {
      const history = await import("@/lib/web3/bundles/bundle-history");
      const mine = await run("unconfirmed");
      const other = await run("unconfirmed");
      const entry = (executionId: string, extra: object = {}) => ({
        executionId,
        hashes: [H1, H3],
        signedAt: Date.now(),
        ...extra,
      });
      const copy = (extra: object = {}) => ({
        public: { hash: H3, kind: "with-bundle", at: Date.now(), ...extra },
      });
      const shapes: [string, number | null, object[], boolean][] = [
        ["accepted absent", 102, [entry(mine, copy())], true],
        ["accepted true", 102, [entry(mine, copy({ accepted: true }))], true],
        ["accepted null", 102, [entry(mine, copy({ accepted: null }))], true],
        ["refused", 102, [entry(mine, copy({ accepted: false }))], false],
        [
          "another run's last entry",
          102,
          [entry(mine, copy()), entry(other)],
          false,
        ],
        ["another run's entry with a copy", 102, [entry(other, copy())], false],
        ["no last target block", null, [entry(mine, copy())], false],
        ["no public field", 102, [entry(mine)], false],
        ["no entries", 102, [], false],
      ];
      for (const [index, [, lastTargetBlock, bundleRuns]] of shapes.entries()) {
        await db.insert(ext.pendingTransactions).values({
          walletAddress: WALLET,
          chainId: CHAIN_ID,
          nonce: 20 + index,
          txHash: H3,
          executionId: mine,
          workflowId: WORKFLOW_ID,
          lastTargetBlock,
          bundleRuns: bundleRuns as never,
        });
      }
      const rows = await db
        .select({
          nonce: ext.pendingTransactions.nonce,
          txHash: ext.pendingTransactions.txHash,
          executionId: ext.pendingTransactions.executionId,
          lastTargetBlock: ext.pendingTransactions.lastTargetBlock,
          bundleRuns: ext.pendingTransactions.bundleRuns,
          live: history.livePublicCopySql(),
        })
        .from(ext.pendingTransactions)
        .where(eq(ext.pendingTransactions.walletAddress, WALLET));
      for (const [index, [name, , , expected]] of shapes.entries()) {
        const row = rows.find((candidate) => candidate.nonce === 20 + index);
        expect([name, row?.live]).toEqual([name, expected]);
        expect([
          name,
          history.livePublicCopy(row as never) !== undefined,
        ]).toEqual([name, expected]);
      }
    });

    it("a refused copy past its window is a plain bundle row: dropped by the window rule, never miss-counted, never named", async () => {
      const bundleRun = await run("unconfirmed");
      const { manager, session } = await publicRow(bundleRun);
      await manager.markPublicCopyRefused(session, 7);
      expect(
        await new nonces.NonceManager().pendingPublicCopyHash(
          WALLET,
          CHAIN_ID,
          7
        )
      ).toBeUndefined();
      sweepChain.view = { transactionCount: 7, latestBlock: 600 };
      await sweep();
      expect((await rowAt(7))?.status).toBe("dropped");
      expect((await publicOf())?.misses).toBeUndefined();
    });

    it("the sweep confirms a mined copy instead of counting a miss", async () => {
      const bundleRun = await run("unconfirmed");
      await publicRow(bundleRun);
      sweepChain.view = {
        transactionCount: 8,
        countAt: () => 8,
        latestBlock: 600,
        mined: { [H3]: 1 },
      };
      const result = await sweep();
      expect(result.landed).toBe(1);
      expect(await rowAt(7)).toMatchObject({ status: "confirmed", txHash: H3 });
    });

    it("the sweep never touches a copy inside its window", async () => {
      const bundleRun = await run("running");
      await publicRow(bundleRun, { ageMs: 10_000 });
      sweepChain.view = { transactionCount: 7, latestBlock: 600 };
      await sweep();
      await sweep();
      await sweep();
      expect((await rowAt(7))?.status).toBe("pending");
      expect(
        (await rowAt(7))?.bundleRuns.at(-1)?.public?.misses
      ).toBeUndefined();
    });
  });
});
