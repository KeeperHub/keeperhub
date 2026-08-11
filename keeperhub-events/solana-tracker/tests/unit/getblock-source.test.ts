import { describe, expect, it, vi } from "vitest";

// Controllable stand-in for the per-chain Solana connection so the source's
// cursor/backfill logic can be driven deterministically without any network.
const hooks = vi.hoisted(() => ({
  onSlot: null as null | ((slot: number) => void),
  slotQueue: [] as number[],
  produced: (_from: number, _to: number): number[] => [],
  getBlock: (_slot: number): unknown => ({}),
}));

vi.mock("@/src/ingest/solana-connection", () => ({
  SolanaConnection: class {
    constructor(opts: { onSlot: (slot: number) => void }) {
      hooks.onSlot = opts.onSlot;
    }
    start(): void {
      /* no-op mock */
    }
    stop(): Promise<void> {
      return Promise.resolve();
    }
    getCurrentSlot(): Promise<number> {
      return Promise.resolve(hooks.slotQueue.shift() ?? 0);
    }
    getProducedSlots(from: number, to: number): Promise<number[]> {
      return Promise.resolve(hooks.produced(from, to));
    }
    getBlock(slot: number): Promise<unknown> {
      return Promise.resolve(hooks.getBlock(slot));
    }
    getHealth(): unknown {
      return {};
    }
  },
}));

const { GetBlockSource } = await import("@/src/ingest/getblock-source");

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

describe("GetBlockSource cursor advance", () => {
  it("resumes at the failed slot without re-processing slots that already succeeded", async () => {
    const processed: number[] = [];
    // start() seeds the cursor from slot 0; tick 1 tip = 5; tick 2 tip = 6.
    hooks.slotQueue = [0, 5, 6];
    hooks.produced = (from, to) => range(from, to);

    let failSlot3 = true;
    hooks.getBlock = (slot: number) => {
      if (slot === 3 && failSlot3) {
        failSlot3 = false;
        throw new Error("getBlock boom");
      }
      return {
        blockhash: `h${slot}`,
        parentSlot: slot - 1,
        blockTime: 0,
        transactions: [],
        blockHeight: slot,
      };
    };

    const source = new GetBlockSource({
      chainId: 101,
      endpoints: [{ rpcUrl: "r", wssUrl: "w" }],
      commitment: "confirmed",
      watchedProgramIds: ["prog"],
      onBlock: (block) => {
        processed.push(block.slot);
        return Promise.resolve();
      },
    });

    await source.start();

    // Tick 1: process slots 1 and 2, then getBlock(3) throws.
    hooks.onSlot?.(5);
    await vi.waitFor(() => expect(processed).toEqual([1, 2]));

    // Tick 2: getBlock now succeeds; must resume at slot 3, not re-run 1 and 2.
    hooks.onSlot?.(6);
    await vi.waitFor(() => expect(processed).toEqual([1, 2, 3, 4, 5, 6]));

    // Every slot processed exactly once - no block-trigger double-fire on retry.
    expect(new Set(processed).size).toBe(processed.length);

    await source.stop();
  });

  it("processes only up to the confirmed tip, ignoring a processed-slot tick that runs ahead", async () => {
    const processed: number[] = [];
    // The slot tick delivers a *processed* slot that leads the *confirmed* tip
    // (getCurrentSlot). start() seeds from 0; the confirmed tip is 5.
    hooks.slotQueue = [0, 5];
    hooks.produced = (from, to) => range(from, to);
    hooks.getBlock = (slot: number) => ({
      blockhash: `h${slot}`,
      parentSlot: slot - 1,
      blockTime: 0,
      transactions: [],
      blockHeight: slot,
    });

    const source = new GetBlockSource({
      chainId: 101,
      endpoints: [{ rpcUrl: "r", wssUrl: "w" }],
      commitment: "confirmed",
      watchedProgramIds: ["prog"],
      onBlock: (block) => {
        processed.push(block.slot);
        return Promise.resolve();
      },
    });

    await source.start();

    // Tick reports slot 999 (processed), but the confirmed tip is only 5.
    hooks.onSlot?.(999);
    await vi.waitFor(() => expect(processed).toEqual([1, 2, 3, 4, 5]));

    // Never reaches beyond the confirmed tip - the tick slot is only a wake-up,
    // not the read target (regression guard for the processed-vs-confirmed bug).
    expect(Math.max(...processed)).toBe(5);

    await source.stop();
  });
});
