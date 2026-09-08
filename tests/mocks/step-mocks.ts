/**
 * Shared vi.mock factories for step-file tests (the standard preamble from
 * plugins/CLAUDE.md). Use the async-import form so vitest's mock hoisting
 * stays correct - the factory resolves this module lazily, after hoisting:
 *
 *   vi.mock("@/lib/workflow/executor/step-handler", async () =>
 *     (await import("../mocks/step-mocks")).stepHandlerPassthrough()
 *   );
 *
 * Only the invariant passthrough shapes live here. Mocks whose bodies differ
 * per test (db row shapes, logging spies with per-test categories) stay local
 * to their test files.
 */

export function stepHandlerPassthrough() {
  return {
    runPluginStep: (
      _options: unknown,
      input: unknown,
      fn: (input: unknown) => unknown
    ) => fn(input),
    withStepLogging: (_input: unknown, fn: () => unknown) => fn(),
  };
}

export function pluginMetricsPassthrough() {
  return {
    withPluginMetrics: (_opts: unknown, fn: () => unknown) => fn(),
  };
}

export function utilsGetErrorMessage() {
  return {
    getErrorMessage: (e: unknown) =>
      e instanceof Error ? e.message : String(e),
  };
}
