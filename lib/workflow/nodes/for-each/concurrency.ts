/**
 * Concurrency orchestration for For Each iterations.
 *
 * Extracted from the workflow executor to enable isolated unit testing.
 */

export type ConcurrencyMode = "sequential" | "parallel" | "custom";

export type IterationExecutor<T> = (item: T, index: number) => Promise<unknown>;

export type ErrorHandler = (error: unknown) => Promise<string>;

interface IterationFailure {
  success: false;
  error: string;
}

/**
 * Run iterations over `items` with the specified concurrency strategy.
 *
 * - **sequential** (default): one at a time, in order.
 * - **parallel**: all at once via `Promise.allSettled`.
 * - **custom**: worker-pool with at most `concurrencyLimit` concurrent.
 *
 * Results are always returned in iteration order regardless of mode.
 * Individual iteration failures are captured as `{ success: false, error }`,
 * they never abort sibling iterations.
 */
export async function runIterations<T>(
  items: T[],
  execute: IterationExecutor<T>,
  handleError: ErrorHandler,
  mode: ConcurrencyMode = "sequential",
  concurrencyLimit = 0
): Promise<unknown[]> {
  if (items.length === 0) {
    return [];
  }

  if (mode === "parallel") {
    return await runParallel(items, execute, handleError);
  }

  if (mode === "custom" && concurrencyLimit > 1) {
    return await runWorkerPool(items, execute, handleError, concurrencyLimit);
  }

  // Sequential (default, or custom with limit <= 1 falls back here)
  return await runSequential(items, execute, handleError);
}

async function runSequential<T>(
  items: T[],
  execute: IterationExecutor<T>,
  handleError: ErrorHandler
): Promise<unknown[]> {
  const results: unknown[] = [];
  for (const [i, item] of items.entries()) {
    try {
      results.push(await execute(item, i));
    } catch (error) {
      const errorMessage = await handleError(error);
      results.push({
        success: false,
        error: errorMessage,
      } satisfies IterationFailure);
    }
  }
  return results;
}

async function runParallel<T>(
  items: T[],
  execute: IterationExecutor<T>,
  handleError: ErrorHandler
): Promise<unknown[]> {
  const settled = await Promise.allSettled(
    items.map((item, i) => execute(item, i))
  );
  const results: unknown[] = [];
  for (const entry of settled) {
    if (entry.status === "fulfilled") {
      results.push(entry.value);
    } else {
      const errorMessage = await handleError(entry.reason);
      results.push({
        success: false,
        error: errorMessage,
      } satisfies IterationFailure);
    }
  }
  return results;
}

async function runWorkerPool<T>(
  items: T[],
  execute: IterationExecutor<T>,
  handleError: ErrorHandler,
  concurrencyLimit: number
): Promise<unknown[]> {
  const results: unknown[] = new Array(items.length);
  let nextIndex = 0;

  const runWorker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      try {
        results[i] = await execute(items[i], i);
      } catch (error) {
        const errorMessage = await handleError(error);
        results[i] = {
          success: false,
          error: errorMessage,
        } satisfies IterationFailure;
      }
    }
  };

  const workerCount = Math.min(concurrencyLimit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

  return results;
}
