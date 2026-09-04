import { describe, expect, it, vi } from "vitest";
import {
  type ConcurrencyMode,
  type ErrorHandler,
  type IterationExecutor,
  runIterations,
} from "@/lib/workflow/nodes/for-each/concurrency";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Simple executor that returns the item doubled (for numbers). */
const doubleExecutor: IterationExecutor<number> = (
  item: number
): Promise<number> => Promise.resolve(item * 2);

/** Executor that records call order via a shared array. */
function orderTrackingExecutor(
  callOrder: number[],
  delayMs = 0
): IterationExecutor<number> {
  return async (item: number, index: number): Promise<number> => {
    callOrder.push(index);
    if (delayMs > 0) {
      await new Promise((resolve) => {
        setTimeout(resolve, delayMs);
      });
    }
    return item;
  };
}

/** Executor that fails for specific indices. */
function failingExecutor(failIndices: Set<number>): IterationExecutor<number> {
  return (item: number, index: number): Promise<number> => {
    if (failIndices.has(index)) {
      return Promise.reject(new Error(`Iteration ${index} failed`));
    }
    return Promise.resolve(item * 10);
  };
}

/** Executor that tracks concurrency via an active counter. */
function concurrencyTrackingExecutor(
  peakTracker: { peak: number; active: number },
  delayMs: number
): IterationExecutor<number> {
  return async (item: number): Promise<number> => {
    peakTracker.active++;
    if (peakTracker.active > peakTracker.peak) {
      peakTracker.peak = peakTracker.active;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, delayMs);
    });
    peakTracker.active--;
    return item;
  };
}

const simpleErrorHandler: ErrorHandler = (error: unknown): Promise<string> => {
  if (error instanceof Error) {
    return Promise.resolve(error.message);
  }
  return Promise.resolve(String(error));
};

// ---------------------------------------------------------------------------
// Sequential mode
// ---------------------------------------------------------------------------

describe("runIterations - sequential", () => {
  it("returns empty array for empty input", async () => {
    const results = await runIterations(
      [],
      doubleExecutor,
      simpleErrorHandler,
      "sequential"
    );
    expect(results).toEqual([]);
  });

  it("processes a single item", async () => {
    const results = await runIterations(
      [5],
      doubleExecutor,
      simpleErrorHandler,
      "sequential"
    );
    expect(results).toEqual([10]);
  });

  it("processes multiple items in order", async () => {
    const results = await runIterations(
      [1, 2, 3, 4, 5],
      doubleExecutor,
      simpleErrorHandler,
      "sequential"
    );
    expect(results).toEqual([2, 4, 6, 8, 10]);
  });

  it("executes iterations one at a time in order", async () => {
    const callOrder: number[] = [];
    await runIterations(
      [10, 20, 30],
      orderTrackingExecutor(callOrder, 10),
      simpleErrorHandler,
      "sequential"
    );
    expect(callOrder).toEqual([0, 1, 2]);
  });

  it("captures errors without aborting subsequent iterations", async () => {
    const results = await runIterations(
      [1, 2, 3, 4],
      failingExecutor(new Set([1, 3])),
      simpleErrorHandler,
      "sequential"
    );
    expect(results).toEqual([
      10,
      {
        __forEachBodyFailure: true,
        success: false,
        error: "Iteration 1 failed",
      },
      30,
      {
        __forEachBodyFailure: true,
        success: false,
        error: "Iteration 3 failed",
      },
    ]);
  });

  it("captures error for single failing item", async () => {
    const results = await runIterations(
      [1],
      failingExecutor(new Set([0])),
      simpleErrorHandler,
      "sequential"
    );
    expect(results).toEqual([
      {
        __forEachBodyFailure: true,
        success: false,
        error: "Iteration 0 failed",
      },
    ]);
  });

  it("handles all iterations failing", async () => {
    const results = await runIterations(
      [1, 2, 3],
      failingExecutor(new Set([0, 1, 2])),
      simpleErrorHandler,
      "sequential"
    );
    for (const result of results) {
      expect(result).toHaveProperty("__forEachBodyFailure", true);
      expect(result).toHaveProperty("success", false);
      expect(result).toHaveProperty("error");
    }
    expect(results).toHaveLength(3);
  });

  it("is the default when mode is omitted", async () => {
    const callOrder: number[] = [];
    await runIterations(
      [1, 2, 3],
      orderTrackingExecutor(callOrder, 10),
      simpleErrorHandler
    );
    expect(callOrder).toEqual([0, 1, 2]);
  });

  it("passes correct item and index to executor", async () => {
    const calls: Array<{ item: string; index: number }> = [];
    const executor: IterationExecutor<string> = (
      item: string,
      index: number
    ): Promise<string> => {
      calls.push({ item, index });
      return Promise.resolve(item);
    };
    await runIterations(
      ["a", "b", "c"],
      executor,
      simpleErrorHandler,
      "sequential"
    );
    expect(calls).toEqual([
      { item: "a", index: 0 },
      { item: "b", index: 1 },
      { item: "c", index: 2 },
    ]);
  });

  it("works with object items", async () => {
    const executor: IterationExecutor<{ id: number }> = (item: {
      id: number;
    }): Promise<number> => Promise.resolve(item.id * 2);
    const results = await runIterations(
      [{ id: 1 }, { id: 2 }, { id: 3 }],
      executor,
      simpleErrorHandler,
      "sequential"
    );
    expect(results).toEqual([2, 4, 6]);
  });

  it("has peak concurrency of 1", async () => {
    const tracker = { peak: 0, active: 0 };
    await runIterations(
      [1, 2, 3, 4, 5],
      concurrencyTrackingExecutor(tracker, 5),
      simpleErrorHandler,
      "sequential"
    );
    expect(tracker.peak).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Parallel mode
// ---------------------------------------------------------------------------

describe("runIterations - parallel", () => {
  it("returns empty array for empty input", async () => {
    const results = await runIterations(
      [],
      doubleExecutor,
      simpleErrorHandler,
      "parallel"
    );
    expect(results).toEqual([]);
  });

  it("processes a single item", async () => {
    const results = await runIterations(
      [7],
      doubleExecutor,
      simpleErrorHandler,
      "parallel"
    );
    expect(results).toEqual([14]);
  });

  it("processes all items and preserves order", async () => {
    const results = await runIterations(
      [1, 2, 3, 4, 5],
      doubleExecutor,
      simpleErrorHandler,
      "parallel"
    );
    expect(results).toEqual([2, 4, 6, 8, 10]);
  });

  it("runs all iterations concurrently", async () => {
    const tracker = { peak: 0, active: 0 };
    await runIterations(
      [1, 2, 3, 4, 5],
      concurrencyTrackingExecutor(tracker, 20),
      simpleErrorHandler,
      "parallel"
    );
    expect(tracker.peak).toBe(5);
  });

  it("captures errors without aborting other iterations", async () => {
    const results = await runIterations(
      [1, 2, 3, 4],
      failingExecutor(new Set([0, 2])),
      simpleErrorHandler,
      "parallel"
    );
    expect(results).toEqual([
      {
        __forEachBodyFailure: true,
        success: false,
        error: "Iteration 0 failed",
      },
      20,
      {
        __forEachBodyFailure: true,
        success: false,
        error: "Iteration 2 failed",
      },
      40,
    ]);
  });

  it("handles all iterations failing", async () => {
    const results = await runIterations(
      [1, 2, 3],
      failingExecutor(new Set([0, 1, 2])),
      simpleErrorHandler,
      "parallel"
    );
    for (const result of results) {
      expect(result).toHaveProperty("success", false);
    }
    expect(results).toHaveLength(3);
  });

  it("preserves result order even with varying execution times", async () => {
    const delays = [50, 10, 30, 5, 40];
    const executor: IterationExecutor<number> = async (
      item: number,
      index: number
    ): Promise<string> => {
      await new Promise((resolve) => {
        setTimeout(resolve, delays[index]);
      });
      return `item-${item}`;
    };
    const results = await runIterations(
      [1, 2, 3, 4, 5],
      executor,
      simpleErrorHandler,
      "parallel"
    );
    expect(results).toEqual(["item-1", "item-2", "item-3", "item-4", "item-5"]);
  });

  it("calls error handler for rejected promises", async () => {
    const errorHandler = vi.fn(simpleErrorHandler);
    await runIterations(
      [1, 2],
      failingExecutor(new Set([1])),
      errorHandler,
      "parallel"
    );
    expect(errorHandler).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Custom concurrency (worker pool)
// ---------------------------------------------------------------------------

describe("runIterations - custom", () => {
  it("returns empty array for empty input", async () => {
    const results = await runIterations(
      [],
      doubleExecutor,
      simpleErrorHandler,
      "custom",
      3
    );
    expect(results).toEqual([]);
  });

  it("processes a single item with limit > 1", async () => {
    const results = await runIterations(
      [5],
      doubleExecutor,
      simpleErrorHandler,
      "custom",
      3
    );
    expect(results).toEqual([10]);
  });

  it("processes all items and preserves order", async () => {
    const results = await runIterations(
      [1, 2, 3, 4, 5, 6],
      doubleExecutor,
      simpleErrorHandler,
      "custom",
      3
    );
    expect(results).toEqual([2, 4, 6, 8, 10, 12]);
  });

  it("respects concurrency limit of 2", async () => {
    const tracker = { peak: 0, active: 0 };
    await runIterations(
      [1, 2, 3, 4, 5, 6, 7, 8],
      concurrencyTrackingExecutor(tracker, 20),
      simpleErrorHandler,
      "custom",
      2
    );
    expect(tracker.peak).toBe(2);
  });

  it("respects concurrency limit of 3", async () => {
    const tracker = { peak: 0, active: 0 };
    await runIterations(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      concurrencyTrackingExecutor(tracker, 20),
      simpleErrorHandler,
      "custom",
      3
    );
    expect(tracker.peak).toBe(3);
  });

  it("does not exceed item count when limit > items", async () => {
    const tracker = { peak: 0, active: 0 };
    await runIterations(
      [1, 2],
      concurrencyTrackingExecutor(tracker, 20),
      simpleErrorHandler,
      "custom",
      10
    );
    expect(tracker.peak).toBe(2);
  });

  it("captures errors without aborting other workers", async () => {
    const results = await runIterations(
      [1, 2, 3, 4, 5, 6],
      failingExecutor(new Set([1, 4])),
      simpleErrorHandler,
      "custom",
      2
    );
    expect(results).toEqual([
      10,
      {
        __forEachBodyFailure: true,
        success: false,
        error: "Iteration 1 failed",
      },
      30,
      40,
      {
        __forEachBodyFailure: true,
        success: false,
        error: "Iteration 4 failed",
      },
      60,
    ]);
  });

  it("handles all iterations failing", async () => {
    const results = await runIterations(
      [1, 2, 3, 4],
      failingExecutor(new Set([0, 1, 2, 3])),
      simpleErrorHandler,
      "custom",
      2
    );
    for (const result of results) {
      expect(result).toHaveProperty("success", false);
    }
    expect(results).toHaveLength(4);
  });

  it("preserves result order with varying execution times", async () => {
    const delays = [40, 5, 30, 10, 20, 15];
    const executor: IterationExecutor<number> = async (
      item: number,
      index: number
    ): Promise<string> => {
      await new Promise((resolve) => {
        setTimeout(resolve, delays[index]);
      });
      return `r-${item}`;
    };
    const results = await runIterations(
      [1, 2, 3, 4, 5, 6],
      executor,
      simpleErrorHandler,
      "custom",
      3
    );
    expect(results).toEqual(["r-1", "r-2", "r-3", "r-4", "r-5", "r-6"]);
  });

  it("falls back to sequential when limit is 1", async () => {
    const tracker = { peak: 0, active: 0 };
    await runIterations(
      [1, 2, 3, 4],
      concurrencyTrackingExecutor(tracker, 10),
      simpleErrorHandler,
      "custom",
      1
    );
    expect(tracker.peak).toBe(1);
  });

  it("falls back to sequential when limit is 0", async () => {
    const tracker = { peak: 0, active: 0 };
    await runIterations(
      [1, 2, 3],
      concurrencyTrackingExecutor(tracker, 10),
      simpleErrorHandler,
      "custom",
      0
    );
    expect(tracker.peak).toBe(1);
  });

  it("processes exactly N items at a time with limit N", async () => {
    const tracker = { peak: 0, active: 0 };
    const limit = 4;
    await runIterations(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      concurrencyTrackingExecutor(tracker, 15),
      simpleErrorHandler,
      "custom",
      limit
    );
    expect(tracker.peak).toBe(limit);
  });
});

// ---------------------------------------------------------------------------
// Edge cases across all modes
// ---------------------------------------------------------------------------

describe("runIterations - edge cases", () => {
  const modes: ConcurrencyMode[] = ["sequential", "parallel", "custom"];

  for (const mode of modes) {
    it(`handles undefined/null items in array (${mode})`, async () => {
      const executor: IterationExecutor<unknown> = (
        item: unknown
      ): Promise<unknown> => Promise.resolve(item);
      const results = await runIterations(
        [null, undefined, 0, "", false],
        executor,
        simpleErrorHandler,
        mode,
        3
      );
      expect(results).toEqual([null, undefined, 0, "", false]);
    });

    it(`handles large arrays (${mode})`, async () => {
      const items = Array.from({ length: 100 }, (_, i) => i);
      const results = await runIterations(
        items,
        doubleExecutor,
        simpleErrorHandler,
        mode,
        5
      );
      expect(results).toHaveLength(100);
      expect(results[0]).toBe(0);
      expect(results[99]).toBe(198);
    });

    it(`calls error handler with thrown Error objects (${mode})`, async () => {
      const handler = vi.fn(simpleErrorHandler);
      const executor: IterationExecutor<number> = (): Promise<never> =>
        Promise.reject(new Error("boom"));
      await runIterations([1], executor, handler, mode, 3);
      expect(handler).toHaveBeenCalledOnce();
      const arg = handler.mock.calls[0][0];
      expect(arg).toBeInstanceOf(Error);
      expect((arg as Error).message).toBe("boom");
    });

    it(`calls error handler with non-Error thrown values (${mode})`, async () => {
      const handler = vi.fn(
        (err: unknown): Promise<string> =>
          Promise.resolve(`caught: ${String(err)}`)
      );
      const executor: IterationExecutor<number> = (): Promise<never> =>
        Promise.reject("string-error");
      const results = await runIterations([1], executor, handler, mode, 3);
      expect(handler).toHaveBeenCalledOnce();
      expect(results[0]).toEqual({
        __forEachBodyFailure: true,
        success: false,
        error: "caught: string-error",
      });
    });
  }

  it("returns results with correct length for mixed success/failure", async () => {
    const items = [1, 2, 3, 4, 5];
    for (const mode of modes) {
      const results = await runIterations(
        items,
        failingExecutor(new Set([2])),
        simpleErrorHandler,
        mode,
        3
      );
      expect(results).toHaveLength(5);
    }
  });
});

// ---------------------------------------------------------------------------
// Error handler integration
// ---------------------------------------------------------------------------

describe("runIterations - error handler", () => {
  it("uses error handler return value as the error field", async () => {
    const customHandler: ErrorHandler = (): Promise<string> =>
      Promise.resolve("custom-error-message");
    const results = await runIterations(
      [1],
      failingExecutor(new Set([0])),
      customHandler,
      "sequential"
    );
    expect(results[0]).toEqual({
      __forEachBodyFailure: true,
      success: false,
      error: "custom-error-message",
    });
  });

  it("error handler is called once per failure across modes", async () => {
    for (const mode of ["sequential", "parallel", "custom"] as const) {
      const handler = vi.fn(simpleErrorHandler);
      await runIterations(
        [1, 2, 3],
        failingExecutor(new Set([0, 2])),
        handler,
        mode,
        2
      );
      expect(handler).toHaveBeenCalledTimes(2);
    }
  });

  it("async error handler is awaited properly", async () => {
    const slowHandler: ErrorHandler = async (): Promise<string> => {
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
      return "slow-error";
    };
    const results = await runIterations(
      [1],
      failingExecutor(new Set([0])),
      slowHandler,
      "parallel"
    );
    expect(results[0]).toEqual({
      __forEachBodyFailure: true,
      success: false,
      error: "slow-error",
    });
  });
});
