import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  slept: 0,
  inserted: [] as { lockedAt: Date; expiresAt: Date }[],
  insertWins: false,
  // The live holder per holder read (the last repeats), and from which read on it has a bundle row.
  holders: [] as { lockedBy: string; lockedAt: Date }[],
  holderReads: 0,
  bundleFromRead: Number.POSITIVE_INFINITY,
  // Whether the wallet sent a bundle on the chain lately.
  sendsBundles: true,
}));

// Every attempt finds the lock held, so the waiter sleeps its whole budget.
vi.mock("@/lib/sleep", () => ({
  sleep: async (ms: number) => {
    h.slept += ms;
  },
}));

vi.mock("@/lib/db", () => ({
  db: {
    insert: () => ({
      values: (row: { lockedAt: Date; expiresAt: Date }) => {
        h.inserted.push(row);
        return {
          onConflictDoNothing: () => ({
            returning: async () =>
              h.insertWins ? [{ walletAddress: "0x" }] : [],
          }),
        };
      },
    }),
    // The holder read names lockedAt; the bundle row read names nonce.
    select: (fields: Record<string, unknown>) => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            if ("lockedAt" in fields) {
              h.holderReads += 1;
              const holder =
                h.holders[Math.min(h.holderReads, h.holders.length) - 1];
              return holder ? [holder] : [];
            }
            if ("nonce" in fields) {
              return h.holderReads >= h.bundleFromRead ? [{ nonce: 7 }] : [];
            }
            if ("submittedAt" in fields) {
              return h.sendsBundles ? [{ submittedAt: new Date() }] : [];
            }
            return [];
          },
        }),
      }),
    }),
    update: () => ({
      set: () => ({ where: () => ({ returning: async () => [] }) }),
    }),
  },
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: {
    INFRASTRUCTURE: "infrastructure",
    CONFIGURATION: "configuration",
  },
  logSystemError: vi.fn(),
  logSystemWarn: vi.fn(),
  logUserError: vi.fn(),
  logWarn: vi.fn(),
}));

import {
  BUNDLE_PRE_RECORD_MS,
  LONGEST_BUNDLE_HOLD_MS,
  MAX_BUNDLE_WINDOW_MS,
} from "@/lib/web3/bundles/bundle-history";
import {
  NonceLockWaitEndedError,
  NonceManager,
} from "@/lib/web3/nonce-manager";

const WALLET = "0x1234567890123456789012345678901234567890";

beforeEach(() => {
  h.slept = 0;
  h.inserted = [];
  h.insertWins = false;
  h.holders = [];
  h.holderReads = 0;
  h.bundleFromRead = Number.POSITIVE_INFINITY;
  h.sendsBundles = true;
});

const PLAIN_WAIT_MS = 120_000;
// The waiter's margin past a holder's budget (holder and waiter clocks differ).
const MARGIN_MS = 8000;
// Past its pre-record budget: a holder this old with no bundle row is not preparing one.
const oldLock = (): Date =>
  new Date(Date.now() - BUNDLE_PRE_RECORD_MS - 60_000);

async function waitForLock(): Promise<void> {
  const provider = { getTransactionCount: async () => 0 };
  await expect(
    new NonceManager().startSession(
      WALLET,
      1,
      "exec-waiter",
      provider as unknown as import("ethers").Provider
    )
  ).rejects.toThrow(/Wallet is saturated/);
}

// The plain budget, then up to the young holder's pre-record budget plus the margin.
function expectPreparingWait(): void {
  expect(h.slept).toBeGreaterThan(PLAIN_WAIT_MS + BUNDLE_PRE_RECORD_MS);
  expect(h.slept).toBeLessThanOrEqual(
    PLAIN_WAIT_MS + BUNDLE_PRE_RECORD_MS + MARGIN_MS
  );
}

describe("nonce lock defaults vs bundle holds", () => {
  it("keeps the plain 120 s wait when no bundle holds the wallet", async () => {
    h.holders = [{ lockedBy: "exec-normal", lockedAt: oldLock() }];
    await waitForLock();
    expect(h.slept).toBe(PLAIN_WAIT_MS);
    expect(h.holderReads).toBe(1);
    expect(PLAIN_WAIT_MS).toBeLessThan(LONGEST_BUNDLE_HOLD_MS);
  });

  it("waits out the longest hold of a bundle holding the wallet before it fails", async () => {
    const lockedAt = new Date();
    h.holders = [{ lockedBy: "exec-bundle", lockedAt }];
    h.bundleFromRead = 1;
    await waitForLock();
    // Sleeps are mocked, so the clock stands still: the wait is measured in sleeps.
    expect(h.slept).toBeGreaterThan(PLAIN_WAIT_MS + LONGEST_BUNDLE_HOLD_MS);
    // One longer wait behind a bundle; its end is not checked again.
    expect(h.holderReads).toBe(1);
  });

  it("waits once for a holder still inside its pre-record budget, then fails when it recorded no bundle", async () => {
    h.holders = [{ lockedBy: "exec-young", lockedAt: new Date() }];
    await waitForLock();
    expectPreparingWait();
    expect(h.holderReads).toBe(2);
  });

  it("keeps the plain wait behind a young holder on a wallet that sends no bundles here", async () => {
    h.holders = [{ lockedBy: "exec-young", lockedAt: new Date() }];
    h.sendsBundles = false;
    await waitForLock();
    expect(h.slept).toBe(PLAIN_WAIT_MS);
  });

  it("waits out the hold of a holder that recorded its bundle while the waiter waited for it", async () => {
    h.holders = [{ lockedBy: "exec-young", lockedAt: new Date() }];
    h.bundleFromRead = 2;
    await waitForLock();
    expect(h.slept).toBeGreaterThan(
      PLAIN_WAIT_MS + BUNDLE_PRE_RECORD_MS + LONGEST_BUNDLE_HOLD_MS
    );
    expect(h.holderReads).toBe(2);
  });

  it("checks whoever holds the lock after that wait: a new holder with a bundle extends it", async () => {
    h.holders = [
      { lockedBy: "exec-young", lockedAt: new Date() },
      { lockedBy: "exec-bundle", lockedAt: new Date() },
    ];
    h.bundleFromRead = 2;
    await waitForLock();
    expect(h.slept).toBeGreaterThan(
      PLAIN_WAIT_MS + BUNDLE_PRE_RECORD_MS + LONGEST_BUNDLE_HOLD_MS
    );
  });

  it("waits for a holder's pre-record budget only once, whoever holds the lock next", async () => {
    h.holders = [
      { lockedBy: "exec-young", lockedAt: new Date() },
      { lockedBy: "exec-young-2", lockedAt: new Date() },
    ];
    await waitForLock();
    expectPreparingWait();
    expect(h.holderReads).toBe(2);
  });

  it("keeps a dead holder's lock past any bundle window it left", async () => {
    h.insertWins = true;
    // Stops right after the lock is taken: the chain read fails.
    const provider = {
      getTransactionCount: async () => {
        throw new Error("rpc down");
      },
    };
    await expect(
      new NonceManager().startSession(
        WALLET,
        1,
        "exec-holder",
        provider as unknown as import("ethers").Provider
      )
    ).rejects.toThrow("rpc down");
    const [lock] = h.inserted;
    expect(lock.expiresAt.getTime() - lock.lockedAt.getTime()).toBeGreaterThan(
      MAX_BUNDLE_WINDOW_MS
    );
  });
});

describe("a lock wait bounded by the caller", () => {
  it("stops at the wait limit with its own error, before the plain budget", async () => {
    h.holders = [{ lockedBy: "exec-bundle", lockedAt: new Date() }];
    h.bundleFromRead = 1;
    const provider = { getTransactionCount: async () => 0 };
    await expect(
      new NonceManager().startSession(
        WALLET,
        1,
        "exec-waiter",
        provider as unknown as import("ethers").Provider,
        { waitUntil: Date.now() }
      )
    ).rejects.toBeInstanceOf(NonceLockWaitEndedError);
    // One try and one sleep: the limit had passed by the second try.
    expect(h.inserted).toHaveLength(1);
    expect(h.slept).toBe(200);
  });
});
