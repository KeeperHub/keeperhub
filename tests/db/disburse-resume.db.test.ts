/**
 * web3/disburse against a real Postgres: the resume guarantee end to end.
 *
 * The transfer cores are replaced with scripted fakes that call the
 * pre-broadcast hook exactly where the real send paths do, so what is under
 * test is the ledger's SQL and the core's reading of each outcome. The first
 * case is the reported bug: a two-leg payout whose second leg failed, re-run
 * with the same list.
 */

import "dotenv/config";
import { and, eq, like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  disbursementLegs,
  organization,
  users,
  workflowExecutions,
  workflows,
} from "../../lib/db/schema";
import type { BroadcastEvent } from "../../lib/web3/broadcast-hook";

vi.mock("server-only", () => ({}));
vi.unmock("@/lib/db");

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "database", VALIDATION: "validation" },
  logSystemError: vi.fn(),
  logUserError: vi.fn(),
  logSystemWarn: vi.fn(),
}));

const capCalls = vi.hoisted(() => [] as unknown[]);
vi.mock("@/lib/execute/value-ledger", () => ({
  withStepValueCap: (args: unknown, run: () => unknown) => {
    capCalls.push(args);
    return run();
  },
}));

const signer = vi.hoisted(() => ({ kind: "eoa" as string }));
vi.mock("@/lib/safe/signer-resolver", () => ({
  SIGNER_MODE: { EOA: "eoa", SAFE: "safe", SAFE_ROLE: "safe-role" },
  resolveSignerForNode: () =>
    Promise.resolve({ kind: signer.kind, ownerAddress: "0xw" }),
}));

const ORG = "test_disburse_org";
vi.mock("@/lib/web3/resolve-org-context", () => ({
  resolveOrganizationContext: () =>
    Promise.resolve({ success: true, organizationId: ORG, userId: undefined }),
}));

type Hook = (event: BroadcastEvent) => Promise<void>;
type Behaviour = (hook: Hook) => Promise<{
  success: boolean;
  transactionHash?: string;
  error?: string;
  sendTransactionStatusId?: string;
}>;

const script = vi.hoisted(() => ({
  queue: new Map<string, Behaviour[]>(),
  calls: new Map<string, number>(),
}));

const scripted = vi.hoisted(
  () => (input: { recipientAddress: string; _broadcastHook: Hook }) => {
    const key = input.recipientAddress.toLowerCase();
    script.calls.set(key, (script.calls.get(key) ?? 0) + 1);
    const next = script.queue.get(key)?.shift();
    if (!next) {
      throw new Error(`no scripted send for ${key}`);
    }
    return next(input._broadcastHook);
  }
);
vi.mock("@/plugins/web3/steps/transfer-token-core", () => ({
  transferTokenCore: scripted,
}));
vi.mock("@/plugins/web3/steps/transfer-funds-core", () => ({
  transferFundsCore: scripted,
}));
vi.mock("@/plugins/web3/steps/transfer-spl-token-core", () => ({
  transferSplTokenCore: () => Promise.reject(new Error("not used")),
}));

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const queryClient = postgres(DATABASE_URL, { max: 2 });
const testDb = drizzle(queryClient);

const PREFIX = "test_disburse_";
const USER = `${PREFIX}user`;
const WORKFLOW = `${PREFIX}wf`;
const EARLIER_RUN = `${PREFIX}exec_earlier`;
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
// The two recipients from the on-chain reproduction in the issue.
const R1 = "0x106175F175B940CcA1816d75eB19937a88BE7720";
const R2 = "0x9cBa0Ef1D7CC6B78e46F060F551D175DA45Aa98a";

const pay =
  (hash: string): Behaviour =>
  async (hook) => {
    await hook({ kind: "evm-signed", transactionHash: hash });
    return { success: true, transactionHash: hash };
  };
const insufficient: Behaviour = () =>
  Promise.resolve({
    success: false,
    error: "Insufficient USDC balance. Have: 0.0, Need: 1",
  });
// Signed and broadcast, then reconciliation missed it: the real core returns
// no hash in exactly this case.
const lostAfterBroadcast =
  (hash: string): Behaviour =>
  async (hook) => {
    await hook({ kind: "evm-signed", transactionHash: hash });
    return { success: false, error: "socket hang up" };
  };

function script_(recipient: string, ...behaviours: Behaviour[]): void {
  script.queue.set(recipient.toLowerCase(), behaviours);
}
function calls(recipient: string): number {
  return script.calls.get(recipient.toLowerCase()) ?? 0;
}

async function run(
  runKey: string,
  legs: Array<{ recipient: string; amount: string }>,
  executionId = `${PREFIX}exec_${Math.random().toString(36).slice(2)}`
) {
  const { disburseCore } = await import(
    "../../plugins/web3/steps/disburse-core"
  );
  return await disburseCore({
    network: "base-sepolia",
    assetType: "erc20",
    tokenAddress: USDC,
    runKey,
    legs: JSON.stringify(legs),
    _context: {
      executionId,
      organizationId: ORG,
      nodeId: "disburse-1",
      nodeName: "Disburse",
      nodeType: "web3/disburse",
    },
  });
}

async function legRow(runKey: string, legIndex: number) {
  const rows = await testDb
    .select()
    .from(disbursementLegs)
    .where(
      and(
        eq(disbursementLegs.organizationId, ORG),
        eq(disbursementLegs.runKey, runKey),
        eq(disbursementLegs.legIndex, legIndex)
      )
    );
  return rows[0];
}

const TWO_LEGS = [
  { recipient: R1, amount: "1" },
  { recipient: R2, amount: "1" },
];

async function seed(): Promise<void> {
  await testDb
    .insert(users)
    .values({
      id: USER,
      name: "t",
      email: `${USER}@test.local`,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing();
  await testDb
    .insert(organization)
    .values({ id: ORG, name: "t", slug: ORG, createdAt: new Date() })
    .onConflictDoNothing();
  await testDb
    .insert(workflows)
    .values({
      id: WORKFLOW,
      name: "t",
      userId: USER,
      organizationId: ORG,
      nodes: [],
      edges: [],
    })
    .onConflictDoNothing();
}

async function clear(): Promise<void> {
  await testDb
    .delete(disbursementLegs)
    .where(eq(disbursementLegs.organizationId, ORG));
  await testDb
    .delete(workflowExecutions)
    .where(like(workflowExecutions.id, `${PREFIX}%`));
}

beforeEach(async () => {
  await clear();
  await seed();
  script.queue.clear();
  script.calls.clear();
  capCalls.length = 0;
  signer.kind = "eoa";
});

afterAll(async () => {
  await clear();
  await testDb.delete(workflows).where(eq(workflows.id, WORKFLOW));
  await testDb.delete(organization).where(eq(organization.id, ORG));
  await testDb.delete(users).where(eq(users.id, USER));
  await queryClient.end();
});

describe("web3/disburse resume (real database)", () => {
  // The reported bug: run 2 paid R1 again and R2 still got nothing.
  it("pays only the unpaid leg when a partly failed run is re-run", async () => {
    script_(R1, pay("0xr1"));
    script_(R2, insufficient, pay("0xr2"));

    const first = await run("payroll-1", TWO_LEGS);
    expect(first.success).toBe(false);
    expect(first.results?.map((r) => r.status)).toEqual(["paid", "failed"]);
    expect((await legRow("payroll-1", 0))?.status).toBe("settled");
    expect((await legRow("payroll-1", 1))?.status).toBe("failed");

    const second = await run("payroll-1", TWO_LEGS);
    expect(second.success).toBe(true);
    expect(second.results).toEqual([
      expect.objectContaining({
        index: 0,
        status: "already_paid",
        transactionHash: "0xr1",
      }),
      expect.objectContaining({
        index: 1,
        status: "paid",
        transactionHash: "0xr2",
      }),
    ]);
    // R1 was sent exactly once across both runs.
    expect(calls(R1)).toBe(1);
    expect(calls(R2)).toBe(2);
    // Only the leg this run sent is on this run's record.
    expect(second.legTransactions).toEqual([
      { hash: "0xr2", chainId: 84_532, legIndex: 1 },
    ]);
  });

  it("treats reformatted amounts and address case as the same list", async () => {
    script_(R1, pay("0xr1"));
    script_(R2, insufficient, pay("0xr2"));
    await run("payroll-fmt", TWO_LEGS);

    const second = await run("payroll-fmt", [
      { recipient: R1.toLowerCase(), amount: "1.00" },
      { recipient: R2.toUpperCase().replace("0X", "0x"), amount: "1.0" },
    ]);

    expect(second.results?.map((r) => r.status)).toEqual([
      "already_paid",
      "paid",
    ]);
  });

  it("stops at a leg that may have paid and sends nothing after it", async () => {
    script_(R1, lostAfterBroadcast("0xmaybe"));
    script_(R2, pay("0xr2"));

    const first = await run("payroll-2", TWO_LEGS);

    expect(first.results?.map((r) => r.status)).toEqual([
      "unknown",
      "not_attempted",
    ]);
    expect(first.results?.[0]).toMatchObject({ transactionHash: "0xmaybe" });
    expect(first.legTransactions).toEqual([
      { hash: "0xmaybe", chainId: 84_532, legIndex: 0 },
    ]);
    expect(calls(R2)).toBe(0);
    const stored = await legRow("payroll-2", 0);
    expect(stored).toMatchObject({
      status: "unknown",
      transactionHash: "0xmaybe",
    });
    // R2 was never claimed, so it is simply absent.
    expect(await legRow("payroll-2", 1)).toBeUndefined();
  });

  it("refuses a whole re-run while any leg may have paid", async () => {
    script_(R1, lostAfterBroadcast("0xmaybe"));
    await run("payroll-3", TWO_LEGS);

    const second = await run("payroll-3", TWO_LEGS);

    expect(second.success).toBe(false);
    expect(second.results?.map((r) => r.status)).toEqual([
      "unknown",
      "not_attempted",
    ]);
    expect(calls(R1)).toBe(1);
    expect(calls(R2)).toBe(0);
    expect(second.success ? "" : second.error).toMatch(/1 may have paid/);
  });

  it("resumes once an operator resolves the leg as paid", async () => {
    const { resolveLeg } = await import("../../lib/web3/disbursement-ledger");
    script_(R1, lostAfterBroadcast("0xmaybe"));
    script_(R2, pay("0xr2"));
    await run("payroll-4", TWO_LEGS);

    const resolved = await resolveLeg({
      organizationId: ORG,
      runKey: "payroll-4",
      legIndex: 0,
      outcome: "paid",
      // resolveLeg now validates the hash's format for the leg's chain;
      // "0xmaybe" (the placeholder used elsewhere in this file for a
      // pre-broadcast-hook value) is not a well-formed EVM hash.
      transactionHash: `0x${"beef".repeat(16)}`,
      note: "Transfer found on Basescan in block 1",
      userId: USER,
    });
    expect(resolved.ok).toBe(true);

    const second = await run("payroll-4", TWO_LEGS);
    expect(second.results?.map((r) => r.status)).toEqual([
      "already_paid",
      "paid",
    ]);
    expect(calls(R1)).toBe(1);
  });

  it("settles a leg from the earlier run's verified receipt without sending it", async () => {
    await testDb.insert(workflowExecutions).values({
      id: EARLIER_RUN,
      workflowId: WORKFLOW,
      userId: USER,
      organizationId: ORG,
      status: "error",
      transactionHashes: [
        {
          hash: "0xearlier",
          nodeId: "disburse-1",
          nodeName: "Disburse",
          chainId: 84_532,
          legIndex: 0,
          verified: true,
          receiptStatus: "success",
        },
      ],
    });
    await testDb.insert(disbursementLegs).values({
      organizationId: ORG,
      runKey: "payroll-5",
      legIndex: 0,
      chainId: 84_532,
      asset: `erc20:${USDC.toLowerCase()}`,
      recipient: R1.toLowerCase(),
      amount: "1",
      status: "sending",
      claimToken: "dead-run",
      executionId: EARLIER_RUN,
      transactionHash: "0xearlier",
    });
    script_(R2, pay("0xr2"));

    const result = await run("payroll-5", TWO_LEGS);

    expect(result.results?.map((r) => r.status)).toEqual([
      "already_paid",
      "paid",
    ]);
    expect(calls(R1)).toBe(0);
    expect((await legRow("payroll-5", 0))?.status).toBe("settled");
  });

  it("sends a leg again when the earlier run's receipt shows it reverted", async () => {
    await testDb.insert(workflowExecutions).values({
      id: EARLIER_RUN,
      workflowId: WORKFLOW,
      userId: USER,
      organizationId: ORG,
      status: "error",
      transactionHashes: [
        {
          hash: "0xreverted",
          nodeId: "disburse-1",
          nodeName: "Disburse",
          chainId: 84_532,
          legIndex: 0,
          verified: false,
          receiptStatus: "reverted",
        },
      ],
    });
    await testDb.insert(disbursementLegs).values({
      organizationId: ORG,
      runKey: "payroll-6",
      legIndex: 0,
      chainId: 84_532,
      asset: `erc20:${USDC.toLowerCase()}`,
      recipient: R1.toLowerCase(),
      amount: "1",
      status: "unknown",
      claimToken: "dead-run",
      executionId: EARLIER_RUN,
      transactionHash: "0xreverted",
    });
    script_(R1, pay("0xr1"));
    script_(R2, pay("0xr2"));

    const result = await run("payroll-6", TWO_LEGS);

    expect(result.success).toBe(true);
    expect(calls(R1)).toBe(1);
  });

  it("refuses a list that changed under the same key, before sending anything", async () => {
    script_(R1, pay("0xr1"));
    script_(R2, insufficient);
    await run("payroll-7", TWO_LEGS);

    const changed = await run("payroll-7", [
      { recipient: R1, amount: "2" },
      { recipient: R2, amount: "1" },
    ]);

    expect(changed.success).toBe(false);
    expect(changed.results?.[0]).toMatchObject({ status: "conflict" });
    expect(changed.results?.[0].error).toMatch(/different amount/);
    expect(changed.results?.[1]).toMatchObject({ status: "not_attempted" });
    expect(calls(R2)).toBe(1);
  });

  it("records a sponsored send that ended pending with its Turnkey id", async () => {
    script_(R1, async (hook) => {
      await hook({ kind: "sponsored-submitting" });
      await hook({
        kind: "sponsored-accepted",
        sendTransactionStatusId: "sid-9",
      });
      return {
        success: false,
        error: "not confirmed in time",
        sendTransactionStatusId: "sid-9",
      };
    });

    const result = await run("payroll-8", TWO_LEGS);

    expect(result.results?.[0]).toMatchObject({
      status: "unknown",
      sendTransactionStatusId: "sid-9",
    });
    expect(await legRow("payroll-8", 0)).toMatchObject({
      status: "unknown",
      sendTransactionStatusId: "sid-9",
      transactionHash: null,
    });
  });

  it("reads a sponsored send Turnkey ended before broadcast as not paid", async () => {
    script_(R1, async (hook) => {
      await hook({ kind: "sponsored-submitting" });
      await hook({ kind: "sponsored-not-broadcast" });
      return { success: false, error: "Insufficient USDC balance" };
    });
    script_(R2, insufficient);

    const result = await run("payroll-9", TWO_LEGS);

    expect(result.results?.map((r) => r.status)).toEqual(["failed", "failed"]);
    expect((await legRow("payroll-9", 0))?.status).toBe("failed");
  });

  it("does not send a leg whose claim another run took over", async () => {
    script_(R1, async (hook) => {
      // Simulate a takeover between claiming and signing.
      await testDb
        .update(disbursementLegs)
        .set({ claimToken: "someone-else" })
        .where(
          and(
            eq(disbursementLegs.runKey, "payroll-10"),
            eq(disbursementLegs.legIndex, 0)
          )
        );
      await hook({ kind: "evm-signed", transactionHash: "0xnever" });
      return { success: true, transactionHash: "0xnever" };
    });
    script_(R2, insufficient);

    const result = await run("payroll-10", TWO_LEGS);

    // The hook threw before anything would have been broadcast; the fake core
    // above propagates that throw as the real cores do.
    expect(result.results?.[0]).toMatchObject({ status: "failed" });
    expect(await legRow("payroll-10", 0)).toMatchObject({
      status: "claimed",
      claimToken: "someone-else",
      transactionHash: null,
    });
  });

  it("refuses a run while another run holds a fresh claim, and takes over a stale one", async () => {
    await testDb.insert(disbursementLegs).values({
      organizationId: ORG,
      runKey: "payroll-11",
      legIndex: 0,
      chainId: 84_532,
      asset: `erc20:${USDC.toLowerCase()}`,
      recipient: R1.toLowerCase(),
      amount: "1",
      status: "claimed",
      claimToken: "live-run",
    });

    const blocked = await run("payroll-11", TWO_LEGS);
    expect(blocked.results?.map((r) => r.status)).toEqual([
      "in_progress",
      "not_attempted",
    ]);
    expect(calls(R1)).toBe(0);

    await testDb
      .update(disbursementLegs)
      .set({ claimedAt: new Date(Date.now() - 16 * 60 * 1000) })
      .where(eq(disbursementLegs.runKey, "payroll-11"));
    script_(R1, pay("0xr1"));
    script_(R2, pay("0xr2"));

    const resumed = await run("payroll-11", TWO_LEGS);
    expect(resumed.success).toBe(true);
    expect(calls(R1)).toBe(1);
  });

  it("lets only one of two concurrent runs send a leg", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    script_(R1, async (hook) => {
      await gate;
      await hook({ kind: "evm-signed", transactionHash: "0xr1" });
      return { success: true, transactionHash: "0xr1" };
    });
    script_(R2, pay("0xr2"));

    const first = run("payroll-12", TWO_LEGS);
    // Let the first run claim leg 0 before the second one reads the ledger.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const second = await run("payroll-12", TWO_LEGS);
    release();
    const firstResult = await first;

    expect(second.results?.[0]).toMatchObject({ status: "in_progress" });
    expect(firstResult.success).toBe(true);
    expect(calls(R1)).toBe(1);
    expect(calls(R2)).toBe(1);
  });

  it("refuses a Safe or Role signer before recording anything", async () => {
    signer.kind = "safe";

    const result = await run("payroll-13", TWO_LEGS);

    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error).toMatch(/Safe or Role signer/);
    expect(await legRow("payroll-13", 0)).toBeUndefined();
    expect(calls(R1)).toBe(0);
  });
});

describe("web3/disburse spend cap (real database)", () => {
  // The direct-execution route reserves nothing for disburse and flags the
  // step as reserved, so a leg that honoured the flag would move native value
  // uncharged.
  it("charges every native leg, even when the context says value was reserved", async () => {
    const { disburseCore } = await import(
      "../../plugins/web3/steps/disburse-core"
    );
    script_(R1, pay("0xn1"));
    script_(R2, pay("0xn2"));

    const result = await disburseCore({
      network: "base-sepolia",
      assetType: "native",
      runKey: "native-cap",
      legs: [
        { recipient: R1, amount: "0.25" },
        { recipient: R2, amount: "0.5" },
      ],
      _context: {
        executionId: `${PREFIX}exec_direct`,
        organizationId: ORG,
        nodeId: "disburse-1",
        nodeName: "Disburse",
        nodeType: "action",
        valueCapReserved: true,
      },
    });

    expect(result.success).toBe(true);
    expect(capCalls).toEqual([
      expect.objectContaining({
        stepFunction: "transferFundsStep",
        config: { network: "base-sepolia", amount: "0.25" },
        valueCapReserved: false,
      }),
      expect.objectContaining({
        config: { network: "base-sepolia", amount: "0.5" },
        valueCapReserved: false,
      }),
    ]);

    // A re-run skips both legs and reserves nothing for them.
    capCalls.length = 0;
    await disburseCore({
      network: "base-sepolia",
      assetType: "native",
      runKey: "native-cap",
      legs: [
        { recipient: R1, amount: "0.25" },
        { recipient: R2, amount: "0.5" },
      ],
      _context: {
        executionId: `${PREFIX}exec_direct_2`,
        organizationId: ORG,
        nodeId: "disburse-1",
        nodeName: "Disburse",
        nodeType: "action",
      },
    });
    expect(capCalls).toEqual([]);
  });
});

describe("resolveLeg (real database)", () => {
  async function unknownLeg(runKey: string): Promise<void> {
    await testDb.insert(disbursementLegs).values({
      organizationId: ORG,
      runKey,
      legIndex: 0,
      chainId: 84_532,
      asset: "native",
      recipient: R1.toLowerCase(),
      amount: "1",
      status: "unknown",
      claimToken: "t",
    });
  }

  it("requires a note, and a hash to resolve as paid", async () => {
    const { resolveLeg } = await import("../../lib/web3/disbursement-ledger");
    await unknownLeg("resolve-1");
    const key = { organizationId: ORG, runKey: "resolve-1", legIndex: 0 };

    expect(
      await resolveLeg({ ...key, outcome: "paid", note: " ", userId: USER })
    ).toMatchObject({ ok: false, code: "invalid" });
    expect(
      await resolveLeg({
        ...key,
        outcome: "paid",
        note: "checked",
        userId: USER,
      })
    ).toMatchObject({ ok: false, code: "invalid" });

    const notPaid = await resolveLeg({
      ...key,
      outcome: "not_paid",
      note: "No transfer to this address after the run",
      userId: USER,
    });
    expect(notPaid).toMatchObject({
      ok: true,
      leg: {
        status: "failed",
        resolutionNote: "No transfer to this address after the run",
        resolvedBy: USER,
      },
    });
  });

  it("refuses a leg that is settled, missing, or still being sent", async () => {
    const { resolveLeg } = await import("../../lib/web3/disbursement-ledger");
    const base = { outcome: "not_paid" as const, note: "n", userId: USER };

    expect(
      await resolveLeg({
        ...base,
        organizationId: ORG,
        runKey: "nope",
        legIndex: 0,
      })
    ).toMatchObject({ ok: false, code: "not_found" });

    await testDb.insert(disbursementLegs).values({
      organizationId: ORG,
      runKey: "resolve-2",
      legIndex: 0,
      chainId: 84_532,
      asset: "native",
      recipient: R1.toLowerCase(),
      amount: "1",
      status: "sending",
      claimToken: "t",
    });
    const live = await resolveLeg({
      ...base,
      organizationId: ORG,
      runKey: "resolve-2",
      legIndex: 0,
    });
    expect(live).toMatchObject({ ok: false, code: "not_resolvable" });

    await testDb
      .update(disbursementLegs)
      .set({ status: "settled" })
      .where(eq(disbursementLegs.runKey, "resolve-2"));
    expect(
      await resolveLeg({
        ...base,
        organizationId: ORG,
        runKey: "resolve-2",
        legIndex: 0,
      })
    ).toMatchObject({ ok: false, code: "not_resolvable" });
  });
});
