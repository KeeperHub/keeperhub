import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SHUTDOWN_TIMEOUT_MS } from "../lib/workflow/executor/runner-constants";

// The runner opens its database client, registers the signal handlers, and
// starts main() when it is imported. Everything main() reaches for is stubbed
// so the module loads under vitest and parks on a workflow that never finishes,
// which is the state a SIGTERM finds a live pod in.
const mocks = vi.hoisted(() => ({
  updateExecutionStatus: vi.fn(),
  updateScheduleStatus: vi.fn(),
  initializeExecutionProgress: vi.fn(),
  applyExecutionResult: vi.fn(),
  executeWorkflow: vi.fn(),
  shipMetricsToExecutor: vi.fn(),
  queryClientEnd: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("postgres", () => ({
  default: () => ({ end: mocks.queryClientEnd }),
}));
vi.mock("drizzle-orm/postgres-js", () => ({ drizzle: () => ({}) }));
vi.mock("../lib/db/integrations", () => ({
  validateWorkflowIntegrations: () => Promise.resolve({ valid: true }),
}));
vi.mock("../lib/workflow/load-for-execution", () => ({
  loadWorkflowForExecution: () =>
    Promise.resolve({
      status: "ok",
      workflow: {
        id: "wf-1",
        name: "Parked workflow",
        nodes: [],
        edges: [],
        organizationId: "org-1",
      },
      organizationName: "Org",
    }),
}));
vi.mock("../lib/workflow/executor/build-executor-input", () => ({
  buildExecutorInput: () => ({}),
}));
vi.mock("../lib/workflow/executor/executor.workflow", () => ({
  executeWorkflow: mocks.executeWorkflow,
}));
vi.mock("./lib/db-helpers", () => ({
  updateExecutionStatus: mocks.updateExecutionStatus,
  updateScheduleStatus: mocks.updateScheduleStatus,
  initializeExecutionProgress: mocks.initializeExecutionProgress,
  applyExecutionResult: mocks.applyExecutionResult,
}));
vi.mock("./lib/ship-metrics", () => ({
  shipMetricsToExecutor: mocks.shipMetricsToExecutor,
}));

type SignalListener = (...args: unknown[]) => unknown;

let onSigint: SignalListener | null = null;

/**
 * Import a fresh runner instance and return the SIGTERM listener it
 * registered; the SIGINT listener from the same instance is stashed in
 * `onSigint`. Listeners are invoked directly rather than by emitting a
 * signal, which would also reach the listeners the test runner installs on
 * this process.
 */
async function loadRunner(): Promise<SignalListener> {
  const beforeTerm = new Set(process.listeners("SIGTERM"));
  const beforeInt = new Set(process.listeners("SIGINT"));
  vi.resetModules();
  await import("./workflow-runner");
  const addedTerm = process
    .listeners("SIGTERM")
    .filter((listener) => !beforeTerm.has(listener));
  const addedInt = process
    .listeners("SIGINT")
    .filter((listener) => !beforeInt.has(listener));
  expect(addedTerm).toHaveLength(1);
  expect(addedInt).toHaveLength(1);
  onSigint = addedInt[0] as SignalListener;
  // main() has parked on executeWorkflow once progress initialization ran.
  await vi.waitFor(() =>
    expect(mocks.initializeExecutionProgress).toHaveBeenCalled()
  );
  return addedTerm[0] as SignalListener;
}

/** Let already-queued continuations run without advancing any timer. */
function drainMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function firstCallOrder(fn: { mock: { invocationCallOrder: number[] } }): number {
  return fn.mock.invocationCallOrder[0];
}

describe("handleGracefulShutdown", () => {
  beforeEach(() => {
    for (const fn of Object.values(mocks)) {
      fn.mockReset();
    }
    mocks.updateExecutionStatus.mockResolvedValue(undefined);
    mocks.updateScheduleStatus.mockResolvedValue(undefined);
    mocks.initializeExecutionProgress.mockResolvedValue(undefined);
    mocks.applyExecutionResult.mockResolvedValue({ errorMessage: undefined });
    // Park on the workflow: the state a SIGTERM finds a live pod in. Tests
    // that need the run to settle mid-shutdown override this.
    mocks.executeWorkflow.mockReturnValue(new Promise(() => undefined));
    mocks.queryClientEnd.mockResolvedValue(undefined);
    onSigint = null;
    process.env.DATABASE_URL =
      "postgresql://runner:runner@localhost:5432/runner";
    process.env.WORKFLOW_ID = "wf-1";
    process.env.EXECUTION_ID = "exec-1";
    process.env.SCHEDULE_ID = "sched-1";
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("ships the terminal counters after the status write and before exiting", async () => {
    mocks.shipMetricsToExecutor.mockResolvedValue(undefined);
    const onSigterm = await loadRunner();
    mocks.updateExecutionStatus.mockClear();

    await onSigterm("SIGTERM");

    expect(mocks.updateExecutionStatus).toHaveBeenCalledWith(
      expect.anything(),
      "exec-1",
      "error",
      { error: "Workflow terminated by SIGTERM signal" }
    );
    expect(mocks.shipMetricsToExecutor).toHaveBeenCalledTimes(1);
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(firstCallOrder(mocks.updateExecutionStatus)).toBeLessThan(
      firstCallOrder(mocks.shipMetricsToExecutor)
    );
    expect(firstCallOrder(mocks.shipMetricsToExecutor)).toBeLessThan(
      firstCallOrder(vi.mocked(process.exit))
    );
  });

  it("ships the shutdown write's counters when the run settles mid-shutdown", async () => {
    // The interleaving that made a memoized snapshot lose data: the workflow
    // finishes while the shutdown handler is still inside its status write, so
    // main() reaches its finally first. Shipping there would send the
    // pre-terminal snapshot and then exit the process out from under the write.
    let settleWorkflow: (() => void) | undefined;
    mocks.executeWorkflow.mockReturnValue(
      new Promise((resolve) => {
        settleWorkflow = (): void => resolve({ success: true });
      })
    );
    mocks.shipMetricsToExecutor.mockResolvedValue(undefined);
    const onSigterm = await loadRunner();

    let completeStatusWrite: (() => void) | undefined;
    mocks.updateExecutionStatus.mockClear();
    mocks.updateExecutionStatus.mockReturnValue(
      new Promise((resolve) => {
        completeStatusWrite = (): void => resolve(undefined);
      })
    );

    onSigterm("SIGTERM");
    await vi.waitFor(() =>
      expect(mocks.updateExecutionStatus).toHaveBeenCalledTimes(1)
    );

    settleWorkflow?.();
    await vi.waitFor(() =>
      expect(mocks.applyExecutionResult).toHaveBeenCalled()
    );
    await drainMicrotasks();

    // main() is in its finally with the shutdown still in flight.
    expect(mocks.shipMetricsToExecutor).not.toHaveBeenCalled();
    expect(process.exit).not.toHaveBeenCalled();

    completeStatusWrite?.();
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalled());

    expect(mocks.shipMetricsToExecutor).toHaveBeenCalledTimes(1);
    expect(firstCallOrder(mocks.updateExecutionStatus)).toBeLessThan(
      firstCallOrder(mocks.shipMetricsToExecutor)
    );
    // The handler, not main(), decides how the pod exits.
    expect(vi.mocked(process.exit).mock.calls[0][0]).toBe(1);
  });

  it("ignores a repeat signal without releasing the shutdown in flight", async () => {
    let completeStatusWrite: (() => void) | undefined;
    mocks.shipMetricsToExecutor.mockResolvedValue(undefined);
    const onSigterm = await loadRunner();

    mocks.updateExecutionStatus.mockClear();
    mocks.updateExecutionStatus.mockReturnValue(
      new Promise((resolve) => {
        completeStatusWrite = (): void => resolve(undefined);
      })
    );

    onSigterm("SIGTERM");
    await vi.waitFor(() =>
      expect(mocks.updateExecutionStatus).toHaveBeenCalledTimes(1)
    );

    onSigterm("SIGTERM");
    onSigint?.("SIGINT");
    await drainMicrotasks();

    // The repeats returned early: no second status write, no early exit.
    expect(mocks.updateExecutionStatus).toHaveBeenCalledTimes(1);
    expect(mocks.shipMetricsToExecutor).not.toHaveBeenCalled();
    expect(process.exit).not.toHaveBeenCalled();

    completeStatusWrite?.();
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalled());
    expect(mocks.shipMetricsToExecutor).toHaveBeenCalledTimes(1);
  });

  it("still force-exits on the shutdown timer when shipping hangs", async () => {
    mocks.shipMetricsToExecutor.mockReturnValue(
      new Promise<void>(() => undefined)
    );
    const onSigterm = await loadRunner();
    vi.useFakeTimers();

    onSigterm("SIGTERM");
    await vi.waitFor(() =>
      expect(mocks.shipMetricsToExecutor).toHaveBeenCalledTimes(1)
    );
    expect(process.exit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS);

    expect(process.exit).toHaveBeenCalledWith(1);
  });
});
