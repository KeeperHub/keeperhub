import { SolanaJSONRPCError } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";

type SignatureInfo = { signature: string; slot: number };
type SignatureQuery = { until?: string; before?: string; limit?: number };

// Controllable stand-in for the per-chain Solana connection so the source's
// poll cadence and paging can be driven deterministically without any network.
const hooks = vi.hoisted(() => ({
  onSlot: null as null | ((slot: number) => void),
  signatureCalls: [] as {
    address: string;
    until?: string;
    before?: string;
    limit?: number;
  }[],
  // When set, decides whether a given query rejects. Rejecting (rather than
  // throwing synchronously) is what the real connection does, and it is the
  // path the source's error handling actually takes in production.
  failWith: null as null | ((options: SignatureQuery) => Error | null),
  signatures: (
    _address: string,
    _options: { until?: string; before?: string; limit?: number },
  ): { signature: string; slot: number }[] => [],
  // Simulates a poll slower than the interval. Resolved by fake timers.
  delayMs: 0,
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
    getSignaturesForAddress(
      address: string,
      options: SignatureQuery,
    ): Promise<unknown[]> {
      hooks.signatureCalls.push({
        address,
        until: options.until,
        before: options.before,
        limit: options.limit,
      });
      const failure = hooks.failWith?.(options) ?? null;
      if (failure) {
        return Promise.reject(failure);
      }
      const result = hooks.signatures(address, options);
      if (hooks.delayMs === 0) {
        return Promise.resolve(result);
      }
      return new Promise((resolve) => {
        setTimeout(() => resolve(result), hooks.delayMs);
      });
    }
    getTransaction(): Promise<unknown> {
      return Promise.resolve({ meta: { logMessages: [] }, blockTime: 0 });
    }
    getHealth(): unknown {
      return {};
    }
  },
}));

const { SignaturesSource } = await import("@/src/ingest/signatures-source");

const PROGRAM = "So11111111111111111111111111111111111111112";
const OTHER_PROGRAM = "Vote111111111111111111111111111111111111111";
const POLL_INTERVAL_MS = 1000;
const STALL_RESET_MS = 5000;
const PAGE_SIZE = 1000;

/**
 * The error the RPC returns for an `until`/`before` signature it cannot
 * resolve. Code -32020 with "Transaction <sig> not found", verified identical
 * on both gateway routes and on api.testnet.solana.com.
 */
function unknownCursorError(signature: string): Error {
  return new SolanaJSONRPCError(
    { code: -32020, message: `Transaction ${signature} not found` },
    "failed to get signatures for address",
  );
}

/** A malformed signature, which must NOT be read as a rejected cursor. */
function invalidParamError(): Error {
  return new SolanaJSONRPCError(
    { code: -32602, message: "Invalid param: WrongSize" },
    "failed to get signatures for address",
  );
}

function sourceWith(
  programs: string[],
  onBlock: () => Promise<void> = () => Promise.resolve(),
): InstanceType<typeof SignaturesSource> {
  return new SignaturesSource(
    {
      chainId: 101,
      endpoints: [{ rpcUrl: "r", wssUrl: "w" }],
      commitment: "confirmed",
      watchedProgramIds: programs,
      onBlock,
    },
    POLL_INTERVAL_MS,
    STALL_RESET_MS,
  );
}

/** Queries that carry no cursor are seeds; the source sends them with limit 1. */
function seedCalls(): typeof hooks.signatureCalls {
  return hooks.signatureCalls.filter(
    (c) => c.until === undefined && c.before === undefined,
  );
}

function source(
  onBlock: () => Promise<void> = () => Promise.resolve(),
): InstanceType<typeof SignaturesSource> {
  return new SignaturesSource(
    {
      chainId: 101,
      endpoints: [{ rpcUrl: "r", wssUrl: "w" }],
      commitment: "confirmed",
      watchedProgramIds: [PROGRAM],
      onBlock,
    },
    POLL_INTERVAL_MS,
  );
}

function page(prefix: string, count: number): SignatureInfo[] {
  return Array.from({ length: count }, (_, i) => ({
    signature: `${prefix}-${i}`,
    slot: i,
  }));
}

afterEach(() => {
  vi.useRealTimers();
  hooks.signatureCalls = [];
  hooks.signatures = () => [];
  hooks.failWith = null;
  hooks.delayMs = 0;
});

describe("SignaturesSource poll throttle", () => {
  it("coalesces a burst of slot ticks into one deferred poll", async () => {
    vi.useFakeTimers();
    hooks.signatures = () => [{ signature: "seed-sig", slot: 1 }];

    const src = source();
    await src.start();
    // start() seeds one cursor per watched program.
    expect(hooks.signatureCalls).toHaveLength(1);

    hooks.signatures = () => [];

    // Solana mainnet delivers ~2.5 slot ticks/s. Honouring each one would issue
    // a query per program per tick; they must collapse to one poll instead.
    for (let slot = 1; slot <= 5; slot++) {
      hooks.onSlot?.(slot);
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(hooks.signatureCalls).toHaveLength(2);

    // The ticks that arrived inside the interval are not dropped - they fire as
    // a single poll once the interval elapses.
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(hooks.signatureCalls).toHaveLength(3);

    // With no further ticks the source goes quiet rather than free-running.
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5);
    expect(hooks.signatureCalls).toHaveLength(3);

    await src.stop();
  });

  it("still waits a full interval after a poll that outlasts the interval", async () => {
    // Regression guard: measuring the interval from poll start leaves the guard
    // already satisfied when a slow poll returns, so the source free-runs on
    // exactly the busy chains the floor protects.
    vi.useFakeTimers();
    hooks.signatures = () => [{ signature: "seed-sig", slot: 1 }];

    const src = source();
    await src.start();
    hooks.signatures = () => [];
    hooks.delayMs = POLL_INTERVAL_MS * 3;

    hooks.onSlot?.(1);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    expect(hooks.signatureCalls).toHaveLength(2);

    hooks.onSlot?.(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(hooks.signatureCalls).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(hooks.signatureCalls).toHaveLength(3);

    await src.stop();
  });

  it("polls immediately when a tick arrives after the interval has elapsed", async () => {
    vi.useFakeTimers();
    hooks.signatures = () => [{ signature: "seed-sig", slot: 1 }];

    const src = source();
    await src.start();
    hooks.signatures = () => [];

    hooks.onSlot?.(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(hooks.signatureCalls).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
    hooks.onSlot?.(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(hooks.signatureCalls).toHaveLength(3);

    await src.stop();
  });

  it("cancels a deferred poll on stop", async () => {
    vi.useFakeTimers();
    hooks.signatures = () => [{ signature: "seed-sig", slot: 1 }];

    const src = source();
    await src.start();
    hooks.signatures = () => [];

    hooks.onSlot?.(1);
    await vi.advanceTimersByTimeAsync(0);
    hooks.onSlot?.(2); // deferred to the interval boundary
    const callsBeforeStop = hooks.signatureCalls.length;

    await src.stop();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);

    expect(hooks.signatureCalls).toHaveLength(callsBeforeStop);

    await src.stop();
  });
});

describe("SignaturesSource windowing", () => {
  it("pages backwards instead of skipping past a full response", async () => {
    // A full page means the window is not exhausted. Advancing the cursor to
    // the newest signature at that point drops everything older, permanently.
    hooks.signatures = () => [{ signature: "seed-sig", slot: 1 }];
    let processed = 0;
    const src = source(() => {
      processed++;
      return Promise.resolve();
    });
    await src.start();

    const first = page("new", PAGE_SIZE);
    const second = page("old", 3);
    hooks.signatures = (_address, options) =>
      options.before === undefined ? first : second;

    hooks.onSlot?.(1);
    await vi.waitFor(() => expect(processed).toBe(PAGE_SIZE + second.length));

    const pollCalls = hooks.signatureCalls.slice(1);
    expect(pollCalls).toHaveLength(2);
    expect(pollCalls[0].before).toBeUndefined();
    // Second page continues from the oldest signature of the first.
    expect(pollCalls[1].before).toBe(`new-${PAGE_SIZE - 1}`);
    expect(pollCalls[1].until).toBe("seed-sig");

    await src.stop();
  });

  it("stops paging once a short page shows the window is exhausted", async () => {
    hooks.signatures = () => [{ signature: "seed-sig", slot: 1 }];
    let processed = 0;
    const src = source(() => {
      processed++;
      return Promise.resolve();
    });
    await src.start();

    hooks.signatures = () => page("new", 2);

    hooks.onSlot?.(1);
    await vi.waitFor(() => expect(processed).toBe(2));
    expect(hooks.signatureCalls.slice(1)).toHaveLength(1);

    await src.stop();
  });
});

describe("SignaturesSource cursor recovery", () => {
  it("re-seeds when the endpoint rejects the cursor", async () => {
    // The cursor only advances on success, so a cursor the endpoint will never
    // resolve is retried unchanged on every poll - the source stalls for good
    // and logs the same rejection forever. Observed on staging chain 103, where
    // the cursor was seeded from one cluster and polled against another.
    vi.useFakeTimers();
    hooks.signatures = () => [{ signature: "seed-sig", slot: 1 }];

    const src = sourceWith([PROGRAM]);
    await src.start();
    expect(seedCalls()).toHaveLength(1);

    hooks.failWith = (options) =>
      options.until === "seed-sig" ? unknownCursorError("seed-sig") : null;
    hooks.onSlot?.(1);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    // The rejected cursor is dropped, so the next poll seeds afresh rather than
    // asking for the same unresolvable signature again.
    hooks.failWith = null;
    hooks.signatures = () => [{ signature: "reseed-sig", slot: 9 }];
    hooks.onSlot?.(2);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(seedCalls()).toHaveLength(2);
    expect(seedCalls()[1].limit).toBe(1);
    expect(hooks.signatureCalls.some((c) => c.until === "reseed-sig")).toBe(
      false,
    );

    await src.stop();
  });

  it("re-seeds when the rejection comes from a paging query", async () => {
    // Paging asks with `before`, and the endpoint rejects an unresolvable
    // `before` with the same code. Recovery must not depend on which parameter
    // the endpoint objected to.
    vi.useFakeTimers();
    hooks.signatures = () => [{ signature: "seed-sig", slot: 1 }];

    const src = sourceWith([PROGRAM]);
    await src.start();

    // A full page forces a second, `before`-carrying request; that one fails.
    hooks.signatures = () => page("new", PAGE_SIZE);
    hooks.failWith = (options) =>
      options.before === undefined
        ? null
        : unknownCursorError(String(options.before));

    hooks.onSlot?.(1);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(hooks.signatureCalls.some((c) => c.before !== undefined)).toBe(true);

    hooks.failWith = null;
    hooks.signatures = () => [];
    hooks.onSlot?.(2);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(seedCalls()).toHaveLength(2);

    await src.stop();
  });

  it("keeps the cursor when the failure is not a cursor rejection", async () => {
    // Dropping a usable cursor re-seeds to head and skips the window, so a
    // malformed-parameter error or an ordinary failure must leave it alone.
    vi.useFakeTimers();
    for (const failure of [invalidParamError(), new Error("socket hang up")]) {
      hooks.signatureCalls = [];
      hooks.failWith = null;
      hooks.signatures = () => [{ signature: "seed-sig", slot: 1 }];

      const src = sourceWith([PROGRAM]);
      await src.start();

      hooks.failWith = () => failure;
      hooks.onSlot?.(1);
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

      hooks.failWith = null;
      hooks.signatures = () => [];
      hooks.onSlot?.(2);
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

      // Still asking from the same cursor; no re-seed happened.
      expect(seedCalls()).toHaveLength(1);
      expect(hooks.signatureCalls.at(-1)?.until).toBe("seed-sig");

      await src.stop();
    }
  });

  it("drops a cursor that has completed no poll for the stall window", async () => {
    // The backstop for an endpoint that reports an unresolvable cursor some
    // other way. Without it, only the codes we already know about recover.
    vi.useFakeTimers();
    hooks.signatures = () => [{ signature: "seed-sig", slot: 1 }];

    const src = sourceWith([PROGRAM]);
    await src.start();

    hooks.failWith = () => new Error("upstream unavailable");
    // Poll repeatedly, staying inside the window.
    for (let i = 0; i < 3; i++) {
      hooks.onSlot?.(i);
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    }
    expect(seedCalls()).toHaveLength(1);
    expect(hooks.signatureCalls.at(-1)?.until).toBe("seed-sig");

    // Cross the window; the next failing poll gives the cursor up.
    await vi.advanceTimersByTimeAsync(STALL_RESET_MS);
    hooks.onSlot?.(99);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    hooks.failWith = null;
    hooks.signatures = () => [];
    hooks.onSlot?.(100);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(seedCalls()).toHaveLength(2);

    await src.stop();
  });

  it("never treats a quiet program as stalled", async () => {
    // A program with nothing new returns an empty window, which is the normal
    // case. Reading that as a stall would re-seed - and so skip events - on
    // every quiet chain, which is most of them.
    vi.useFakeTimers();
    hooks.signatures = () => [{ signature: "seed-sig", slot: 1 }];

    const src = sourceWith([PROGRAM]);
    await src.start();

    hooks.signatures = () => [];
    for (let i = 0; i < STALL_RESET_MS / POLL_INTERVAL_MS + 5; i++) {
      hooks.onSlot?.(i);
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    }

    expect(seedCalls()).toHaveLength(1);
    expect(hooks.signatureCalls.at(-1)?.until).toBe("seed-sig");

    await src.stop();
  });

  it("keeps polling later programs when one rejects", async () => {
    // One request per program, so an escaping rejection would skip every
    // program after it - one unreachable program silently stopping the rest of
    // the chain's workflows.
    vi.useFakeTimers();
    hooks.signatures = (address) => [{ signature: `seed-${address}`, slot: 1 }];

    const src = sourceWith([PROGRAM, OTHER_PROGRAM]);
    await src.start();
    hooks.signatureCalls = [];

    hooks.failWith = (options) =>
      options.until === `seed-${PROGRAM}` ? new Error("first is down") : null;
    hooks.signatures = () => [];

    hooks.onSlot?.(1);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(hooks.signatureCalls.some((c) => c.address === OTHER_PROGRAM)).toBe(
      true,
    );

    await src.stop();
  });

  it("does not replay history after a re-seed", async () => {
    // Re-seeding jumps to head. It must not walk the backlog, which on a busy
    // program would be a flood of duplicate workflow fires.
    vi.useFakeTimers();
    hooks.signatures = () => [{ signature: "seed-sig", slot: 1 }];

    let processed = 0;
    const src = sourceWith([PROGRAM], () => {
      processed++;
      return Promise.resolve();
    });
    await src.start();

    hooks.failWith = () => unknownCursorError("seed-sig");
    hooks.onSlot?.(1);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    hooks.failWith = null;
    hooks.signatures = () => page("history", 25);
    hooks.onSlot?.(2);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    const reseed = seedCalls()[1];
    expect(reseed).toBeDefined();
    expect(reseed.limit).toBe(1);
    expect(processed).toBe(0);

    await src.stop();
  });
});
