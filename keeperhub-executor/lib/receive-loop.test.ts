import { describe, expect, it, vi } from "vitest";
import { WARM_POOL_ACK_WINDOW_MS } from "../warm-pool-protocol";
import { InFlightTracker } from "./in-flight";
import { type ReceiveLoopDeps, runReceiveLoop } from "./receive-loop";

type Deferred = { promise: Promise<void>; resolve: () => void };

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// A queue that hands out the scripted batches in order, then blocks the way an
// empty long poll does until the test stops the loop.
function harness(batches: string[][], maxInFlight = 10) {
  let stopping = false;
  const idle = deferred();
  const handlers = new Map<string, Deferred>();
  const started: string[] = [];
  const receivedWith: number[] = [];
  const receive = vi.fn((maxMessages: number): Promise<string[]> => {
    receivedWith.push(maxMessages);
    const batch = batches.shift();
    if (batch) {
      return Promise.resolve(batch);
    }
    return idle.promise.then(() => []);
  });
  const process = vi.fn((message: string): Promise<void> => {
    started.push(message);
    const handler = deferred();
    handlers.set(message, handler);
    return handler.promise;
  });
  const deps: ReceiveLoopDeps<string> = {
    receive,
    process,
    inFlight: new InFlightTracker(),
    maxInFlight,
    isStopping: () => stopping,
    onReceiveError: vi.fn(() => Promise.resolve()),
    onProcessError: vi.fn(),
    onIgnoredWhileStopping: vi.fn(),
  };
  const loop = runReceiveLoop(deps);
  const stop = async (): Promise<void> => {
    stopping = true;
    idle.resolve();
    await loop;
  };
  return { deps, started, receivedWith, handlers, stop };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe("runReceiveLoop", () => {
  it("receives and dispatches the next message before an unacknowledged offer's window ends", async () => {
    vi.useFakeTimers();
    try {
      let stopping = false;
      const idle = deferred();
      const batches = [["offer-waiting-for-ack"], ["next-run"]];
      const dispatched: string[] = [];
      const deps: ReceiveLoopDeps<string> = {
        receive: vi.fn(() => {
          const batch = batches.shift();
          return batch ? Promise.resolve(batch) : idle.promise.then(() => []);
        }),
        process: vi.fn((message: string): Promise<void> => {
          if (message === "offer-waiting-for-ack") {
            // No ack arrives: the offer settles only when the window ends.
            return new Promise((resolve) => {
              setTimeout(() => {
                dispatched.push(message);
                resolve();
              }, WARM_POOL_ACK_WINDOW_MS);
            });
          }
          dispatched.push(message);
          return Promise.resolve();
        }),
        inFlight: new InFlightTracker(),
        maxInFlight: 10,
        isStopping: () => stopping,
        onReceiveError: vi.fn(() => Promise.resolve()),
        onProcessError: vi.fn(),
        onIgnoredWhileStopping: vi.fn(),
      };
      const loop = runReceiveLoop(deps);

      await vi.advanceTimersByTimeAsync(WARM_POOL_ACK_WINDOW_MS - 1);
      expect(dispatched).toEqual(["next-run"]);
      expect(deps.inFlight.size).toBe(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(dispatched).toEqual(["next-run", "offer-waiting-for-ack"]);

      stopping = true;
      idle.resolve();
      await loop;
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks only for as many messages as it has free slots", async () => {
    const h = harness([["a", "b", "c"]], 5);
    await flush();

    expect(h.receivedWith).toEqual([5, 2]);
    await h.stop();
  });

  it("waits for a slot when every slot is busy, then receives again", async () => {
    const h = harness([["a", "b"], ["c"]], 2);
    await flush();

    expect(h.started).toEqual(["a", "b"]);
    expect(h.receivedWith).toEqual([2]);

    h.handlers.get("a")?.resolve();
    await flush();

    expect(h.receivedWith).toEqual([2, 1]);
    expect(h.started).toEqual(["a", "b", "c"]);
    h.handlers.get("b")?.resolve();
    h.handlers.get("c")?.resolve();
    await h.stop();
  });

  it("reports a failed handler and keeps receiving", async () => {
    const failure = new Error("dispatch failed");
    const batches = [["a"], ["b"]];
    let stopping = false;
    const deps: ReceiveLoopDeps<string> = {
      receive: vi.fn(() => {
        const batch = batches.shift();
        if (!batch) {
          stopping = true;
          return Promise.resolve([]);
        }
        return Promise.resolve(batch);
      }),
      process: vi.fn((message: string) =>
        message === "a" ? Promise.reject(failure) : Promise.resolve()
      ),
      inFlight: new InFlightTracker(),
      maxInFlight: 1,
      isStopping: () => stopping,
      onReceiveError: vi.fn(() => Promise.resolve()),
      onProcessError: vi.fn(),
      onIgnoredWhileStopping: vi.fn(),
    };

    await runReceiveLoop(deps);
    await flush();

    expect(deps.onProcessError).toHaveBeenCalledWith(failure);
    expect(deps.process).toHaveBeenCalledWith("b");
  });

  it("does not start a batch that arrives as it stops", async () => {
    let stopping = false;
    const deps: ReceiveLoopDeps<string> = {
      receive: vi.fn(() => {
        stopping = true;
        return Promise.resolve(["late"]);
      }),
      process: vi.fn(() => Promise.resolve()),
      inFlight: new InFlightTracker(),
      maxInFlight: 10,
      isStopping: () => stopping,
      onReceiveError: vi.fn(() => Promise.resolve()),
      onProcessError: vi.fn(),
      onIgnoredWhileStopping: vi.fn(),
    };

    await runReceiveLoop(deps);

    expect(deps.process).not.toHaveBeenCalled();
    expect(deps.onIgnoredWhileStopping).toHaveBeenCalledWith(1);
  });

  it("exits on a receive that fails because it is stopping, and retries one that fails otherwise", async () => {
    let stopping = false;
    let calls = 0;
    const deps: ReceiveLoopDeps<string> = {
      receive: vi.fn(() => {
        calls++;
        if (calls === 2) {
          stopping = true;
        }
        return Promise.reject(new Error("receive failed"));
      }),
      process: vi.fn(() => Promise.resolve()),
      inFlight: new InFlightTracker(),
      maxInFlight: 10,
      isStopping: () => stopping,
      onReceiveError: vi.fn(() => Promise.resolve()),
      onProcessError: vi.fn(),
      onIgnoredWhileStopping: vi.fn(),
    };

    await runReceiveLoop(deps);

    expect(deps.receive).toHaveBeenCalledTimes(2);
    expect(deps.onReceiveError).toHaveBeenCalledTimes(1);
  });
});
