import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type Run = {
  executionId: string;
  hashes: string[];
  node?: { id: string; iterationIndex?: number };
  missed?: string;
};

const h = vi.hoisted(() => ({
  // Pending bundle rows of the workflow inside the window.
  rows: [] as { executionId: string; lastTargetBlock: number | null }[],
  // Rows whose history holds this run.
  replayRows: [] as {
    status: string;
    nonce: number;
    txHash: string;
    executionId: string;
    lastTargetBlock: number | null;
    bundleRuns: Run[];
  }[],
}));

vi.mock("@/lib/db", () => ({
  db: {
    // The run's start, then the replay query (it reads status), then the in-flight one.
    select: (fields: Record<string, unknown>) => ({
      from: () => ({
        where: async () => {
          if ("startedAt" in fields) {
            return [{ startedAt: new Date(0) }];
          }
          return "status" in fields ? h.replayRows : h.rows;
        },
      }),
    }),
  },
}));

import { bundleInFlight, type InFlight } from "@/lib/web3/bundles/in-flight";

const STEP = { executionId: "run-2", nodeId: "write-1" };

function row(executionId: string, lastTargetBlock: number) {
  return { executionId, lastTargetBlock };
}

function ownRow(
  status: "pending" | "confirmed" | "dropped",
  options: {
    node?: { id: string; iterationIndex?: number };
    txHash?: string;
    runs?: Run[];
  } = {}
) {
  const mine: Run = {
    executionId: "run-2",
    hashes: ["0xaa", "0xab"],
    node: options.node ?? { id: "write-1" },
  };
  return {
    status,
    nonce: 7,
    txHash: options.txHash ?? "0xaa",
    executionId: "run-2",
    lastTargetBlock: 105,
    bundleRuns: options.runs ?? [mine],
  };
}

async function inFlight(
  step: { executionId: string; nodeId: string; iterationIndex?: number } = STEP,
  latest: number | Error = 100,
  sessionNonce?: number
): Promise<{ inFlight: InFlight; blockReads: number }> {
  let blockReads = 0;
  const result = await bundleInFlight({
    workflowId: "wf-1",
    chainId: 1,
    walletAddress: "0xWALLET",
    step,
    sessionNonce,
    readLatestBlock: async () => {
      blockReads += 1;
      if (latest instanceof Error) {
        throw latest;
      }
      return latest;
    },
  });
  return { inFlight: result, blockReads };
}

beforeEach(() => {
  h.rows = [];
  h.replayRows = [];
});

const NONE = { kind: "none" };

describe("bundleInFlight", () => {
  it("reads no block when no bundle row is pending", async () => {
    expect(await inFlight()).toEqual({ inFlight: NONE, blockReads: 0 });
  });

  it("is in flight while another run's window is open, with the nonce manager's margin", async () => {
    h.rows = [row("run-1", 102)];
    expect((await inFlight(STEP, 102)).inFlight).toEqual({
      kind: "other",
      untilBlock: 104,
    });
    // One past the last target: the nonce manager still keeps the row pending.
    expect((await inFlight(STEP, 103)).inFlight.kind).toBe("other");
    expect((await inFlight(STEP, 104)).inFlight.kind).toBe("other");
    expect((await inFlight(STEP, 105)).inFlight).toEqual(NONE);
  });

  it("ignores another step of the same run, which waits under the lock instead", async () => {
    h.rows = [row("run-2", 105)];
    h.replayRows = [ownRow("pending", { node: { id: "write-0" } })];
    expect(await inFlight()).toEqual({ inFlight: NONE, blockReads: 0 });
  });

  it("calls a pending row of the same step a replay, at any age, so it never signs twice", async () => {
    h.replayRows = [ownRow("pending")];
    expect(await inFlight()).toEqual({
      inFlight: { kind: "replay", nonce: 7 },
      blockReads: 0,
    });
  });

  it("calls a confirmed row this step's bundle landed in a landed replay, at any age", async () => {
    h.replayRows = [ownRow("confirmed", { txHash: "0xab" })];
    expect((await inFlight()).inFlight).toEqual({
      kind: "replay",
      nonce: 7,
      landedHash: "0xab",
    });
  });

  it("calls a landing a replay when another run signed the same bytes first", async () => {
    // Same call, value and fees: one hash, owned by the older entry.
    h.replayRows = [
      ownRow("confirmed", {
        txHash: "0xaa",
        runs: [
          { executionId: "run-1", hashes: ["0xaa"], node: { id: "write-1" } },
          { executionId: "run-2", hashes: ["0xaa"], node: { id: "write-1" } },
        ],
      }),
    ];
    expect((await inFlight()).inFlight).toEqual({
      kind: "replay",
      nonce: 7,
      landedHash: "0xaa",
    });
  });

  it("signs again when the nonce went to someone else's hash (this bundle can no longer land)", async () => {
    h.replayRows = [ownRow("confirmed", { txHash: "0xother" })];
    expect((await inFlight()).inFlight).toEqual(NONE);
  });

  it("is no replay when a later send at the same nonce is the row's current one", async () => {
    h.replayRows = [
      {
        ...ownRow("pending"),
        executionId: "run-2",
        bundleRuns: [
          { executionId: "run-2", hashes: ["0xaa"], node: { id: "write-1" } },
          { executionId: "run-2", hashes: ["0xbb"], node: { id: "write-9" } },
        ],
        txHash: "0xbb",
      },
    ];
    expect((await inFlight()).inFlight).toEqual(NONE);
  });

  it("leaves a dropped row of this step to the check under the lock", async () => {
    h.replayRows = [ownRow("dropped")];
    expect((await inFlight()).inFlight).toEqual(NONE);
  });

  it("calls a dropped row a replay under the lock once its nonce is used, as it may have landed", async () => {
    h.replayRows = [ownRow("dropped")];
    expect((await inFlight(STEP, 100, 8)).inFlight).toEqual({
      kind: "replay",
      nonce: 7,
    });
  });

  it("signs a dropped row again while its nonce is unused: it reuses that nonce", async () => {
    h.replayRows = [ownRow("dropped")];
    expect((await inFlight(STEP, 100, 7)).inFlight).toEqual(NONE);
  });

  it("returns the miss a step decided for its dropped row, before or under the lock, whatever the nonce", async () => {
    const decided = ownRow("dropped");
    h.replayRows = [
      {
        ...decided,
        bundleRuns: [{ ...decided.bundleRuns[0], missed: "not-picked" }],
      },
    ];
    for (const sessionNonce of [undefined, 7, 8]) {
      expect((await inFlight(STEP, 100, sessionNonce)).inFlight).toEqual({
        kind: "replay",
        nonce: 7,
        missed: "not-picked",
      });
    }
  });

  it("tells loop iterations of one node apart", async () => {
    h.replayRows = [
      ownRow("pending", { node: { id: "write-1", iterationIndex: 0 } }),
    ];
    expect((await inFlight({ ...STEP, iterationIndex: 1 })).inFlight).toEqual(
      NONE
    );
    expect((await inFlight({ ...STEP, iterationIndex: 0 })).inFlight.kind).toBe(
      "replay"
    );
  });

  it("names this step's own bundle before another run's: a landing is never lost to a skip", async () => {
    h.replayRows = [ownRow("pending")];
    h.rows = [row("run-1", 103)];
    expect((await inFlight()).inFlight).toEqual({ kind: "replay", nonce: 7 });
  });

  it("counts an unreadable block as in flight", async () => {
    h.rows = [row("run-1", 102)];
    expect((await inFlight(STEP, new Error("rpc down"))).inFlight.kind).toBe(
      "other"
    );
  });
});
