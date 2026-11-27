import { describe, expect, it } from "vitest";
import {
  BUNDLE_WINDOW_MARGIN_BLOCKS,
  MAX_BUNDLE_TARGET_BLOCKS,
  MAX_BUNDLE_WINDOW_MS,
  type ReceiptView,
} from "@/lib/web3/bundles/bundle-history";
import {
  type InclusionReads,
  watchInclusion,
} from "@/lib/web3/bundles/inclusion";
import { readBundleSettings } from "@/lib/web3/bundles/settings";

// Blocks the receipt index may lag the nonce before "used elsewhere".
const RECEIPT_LAG_BLOCKS = 2;
const NONCE = 7;
const HASHES = ["0xa1", "0xa2", "0xa3"];
const LAST_TARGET = 103;
const RECEIPT: NonNullable<ReceiptView> = {
  blockNumber: 102,
  status: 1,
  gasUsed: BigInt(21_000),
  gasPrice: BigInt(3),
};

// A chain that moves one block per poll, mining `minedHash` at `minedAt`.
function chain(options: {
  start?: number;
  minedAt?: number;
  minedHash?: string;
  // Receipt reads that come back empty once the nonce passed.
  receiptLag?: number;
  failFrom?: number;
}) {
  let block = options.start ?? 100;
  let polls = 0;
  let lag = options.receiptLag ?? 0;
  const calls: string[] = [];
  const reads: InclusionReads = {
    latestBlock: async () => {
      polls += 1;
      calls.push("block");
      if (options.failFrom !== undefined && polls >= options.failFrom) {
        throw new Error("rpc down");
      }
      block += 1;
      return block;
    },
    minedCountAt: async (at) => {
      calls.push(`nonce@${at}`);
      return options.minedAt !== undefined && at >= options.minedAt
        ? NONCE + 1
        : NONCE;
    },
    receipt: async (hash) => {
      calls.push(`receipt:${hash}`);
      if (lag > 0) {
        lag -= 1;
        return null;
      }
      return hash === options.minedHash ? RECEIPT : null;
    },
  };
  return { reads, calls };
}

const noSleep = async (): Promise<void> => undefined;
const watch = (reads: InclusionReads, windowEnd = Date.now() + 60_000) =>
  watchInclusion(
    {
      nonce: NONCE,
      hashes: HASHES,
      lastTarget: LAST_TARGET,
      pollMs: 1,
      windowEnd,
    },
    reads,
    noSleep
  );

describe("watchInclusion", () => {
  it.each([
    [101, "0xa1"],
    [102, "0xa2"],
    [103, "0xa3"],
  ])(
    "finds a hash mined at block %i, reading the nonce at the block it read",
    async (minedAt, minedHash) => {
      const { reads, calls } = chain({ minedAt, minedHash });
      const result = await watch(reads);
      expect(result).toMatchObject({
        kind: "included",
        mined: { hash: minedHash },
      });
      expect(calls.slice(0, 2)).toEqual(["block", "nonce@101"]);
      // Receipts are read only once the nonce has passed.
      const firstReceipt = calls.findIndex((c) => c.startsWith("receipt"));
      expect(calls[firstReceipt - 1]).toBe(`nonce@${minedAt}`);
    }
  );

  it("is not included only once a block past the margin shows the nonce unused", async () => {
    const { reads, calls } = chain({});
    expect(await watch(reads)).toEqual({ kind: "not-included" });
    const last = LAST_TARGET + BUNDLE_WINDOW_MARGIN_BLOCKS + 1;
    expect(calls.filter((c) => c.startsWith("nonce@")).at(-1)).toBe(
      `nonce@${last}`
    );
    expect(calls.some((c) => c.startsWith("receipt"))).toBe(false);
  });

  it("still finds a bundle mined in the last target that a node one block behind missed", async () => {
    // The nonce shows as used only at the margin's last block.
    const { reads } = chain({ minedAt: LAST_TARGET + 2, minedHash: "0xa3" });
    expect(await watch(reads)).toMatchObject({ kind: "included" });
  });

  it("waits out a lagging receipt index, counted in blocks, before calling the nonce used elsewhere", async () => {
    const lagging = chain({
      minedAt: 101,
      minedHash: "0xa2",
      // Two empty scans of three hashes: two blocks of lag.
      receiptLag: HASHES.length * RECEIPT_LAG_BLOCKS - 1,
    });
    expect(await watch(lagging.reads)).toMatchObject({ kind: "included" });

    const other = chain({ minedAt: 101, minedHash: "0xother" });
    const calls = other.calls;
    expect(await watch(other.reads)).toEqual({ kind: "used-elsewhere" });
    expect(calls.filter((c) => c.startsWith("nonce@")).at(-1)).toBe(
      `nonce@${101 + RECEIPT_LAG_BLOCKS}`
    );
  });

  it("never decides from wall time: an unreadable chain is undecided at the window's end", async () => {
    const { reads } = chain({ failFrom: 1 });
    const result = await watch(reads, Date.now() + 5);
    expect(result).toMatchObject({ kind: "undecided" });
    expect((result as { error?: Error }).error?.message).toBe("rpc down");
  });

  it("keeps polling a stalled chain until the window ends, then is undecided", async () => {
    let polls = 0;
    const reads: InclusionReads = {
      latestBlock: async () => {
        polls += 1;
        return LAST_TARGET;
      },
      minedCountAt: async () => NONCE,
      receipt: async () => null,
    };
    const started = Date.now();
    const result = await watchInclusion(
      {
        nonce: NONCE,
        hashes: HASHES,
        lastTarget: LAST_TARGET,
        pollMs: 5,
        windowEnd: started + 40,
      },
      reads
    );
    expect(result).toEqual({ kind: "undecided", error: undefined });
    expect(polls).toBeGreaterThan(1);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("bundle window", () => {
  // Mainnet slots, the only network bundles go to.
  const SLOT_MS = 12_000;

  it("fits the most targets a step may pick plus the decision margin inside the row's window", () => {
    const most = readBundleSettings({ bundleBlocks: 5 });
    expect(readBundleSettings({ bundleBlocks: 6 }).ok).toBe(false);
    const blocks = most.ok ? most.settings.blocks : 0;
    expect(blocks).toBe(5);
    expect(blocks).toBeLessThanOrEqual(MAX_BUNDLE_TARGET_BLOCKS);
    expect((blocks + BUNDLE_WINDOW_MARGIN_BLOCKS + 1) * SLOT_MS).toBeLessThan(
      MAX_BUNDLE_WINDOW_MS
    );
  });
});
