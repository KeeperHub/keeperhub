import { describe, expect, it, vi } from "vitest";
import type { ClaimOutcome } from "./warm-pool-client";
import {
  armRunDeadline,
  isRunnableRow,
  prepareWarmRun,
  type WarmRunnerDeps,
} from "./warm-runner";

const TOKEN = "a".repeat(64);

const assignment = {
  workflowId: "wf-1",
  executionId: "exec-1",
  input: { blockNumber: 3 },
  triggerType: "block",
  correlationId: "abc123",
};

function warmEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    KH_WARM_POOL_CLAIM_URL: "http://10.0.0.5:3080",
    KH_WARM_POOL_TOKEN: TOKEN,
    KH_WARM_POOL_MAX_IDLE_MS: "815000",
    KH_WARM_POOL_RUN_DEADLINE_MS: "300000",
  };
}

function deps(overrides: Partial<WarmRunnerDeps> = {}): WarmRunnerDeps & {
  logs: string[];
} {
  const logs: string[] = [];
  return {
    env: warmEnv(),
    pingDb: vi.fn(() => Promise.resolve()),
    preload: vi.fn(() => Promise.resolve({ loaded: 12, failed: 0 })),
    waitForAssignment: vi.fn(() =>
      Promise.resolve<ClaimOutcome>({ kind: "assigned", assignment })
    ),
    isRunnable: vi.fn(() => Promise.resolve(true)),
    acknowledge: vi.fn(() => Promise.resolve(true)),
    sleep: () => Promise.resolve(),
    log: (message: string) => logs.push(message),
    logs,
    ...overrides,
  };
}

describe("prepareWarmRun", () => {
  it("claims one execution and returns the env a per-run Job carries", async () => {
    const d = deps();
    const prepared = await prepareWarmRun(d);

    expect(prepared?.assignment).toEqual(assignment);
    expect(prepared?.env).toMatchObject({
      WORKFLOW_ID: "wf-1",
      EXECUTION_ID: "exec-1",
      TRIGGER_TYPE: "block",
      KH_CORRELATION_ID: "abc123",
      KH_DISPATCH_TARGET: "warm-pool",
    });
    expect(prepared?.runDeadlineMs).toBe(300_000);
    expect(d.isRunnable).toHaveBeenCalledWith(assignment);
  });

  it("removes the claim token from the env before anything runs", async () => {
    const d = deps();
    await prepareWarmRun(d);
    expect(d.env.KH_WARM_POOL_TOKEN).toBeUndefined();
    const waitOptions = vi.mocked(d.waitForAssignment).mock.calls[0][0];
    expect(waitOptions.token).toBe(TOKEN);
    expect(d.logs.join("\n")).not.toContain(TOKEN);
  });

  it("gets ready (DB, step modules) before waiting, and keeps the DB warm while idle", async () => {
    const d = deps();
    await prepareWarmRun(d);
    expect(d.pingDb).toHaveBeenCalledTimes(1);
    expect(d.preload).toHaveBeenCalledTimes(1);
    const waitOptions = vi.mocked(d.waitForAssignment).mock.calls[0][0];
    expect(waitOptions.onIdle).toBe(d.pingDb);
    expect(waitOptions.maxIdleMs).toBe(815_000);
  });

  it("exits without polling when the warm env is incomplete", async () => {
    const env = warmEnv();
    delete env.KH_WARM_POOL_MAX_IDLE_MS;
    const d = deps({ env });
    await expect(prepareWarmRun(d)).resolves.toBeUndefined();
    expect(d.waitForAssignment).not.toHaveBeenCalled();
  });

  it("exits without polling when the database is unreachable", async () => {
    const d = deps({ pingDb: vi.fn(() => Promise.reject(new Error("down"))) });
    await expect(prepareWarmRun(d)).resolves.toBeUndefined();
    expect(d.waitForAssignment).not.toHaveBeenCalled();
  });

  it("exits without a run when released by the executor", async () => {
    const d = deps({
      waitForAssignment: vi.fn(() =>
        Promise.resolve<ClaimOutcome>({
          kind: "exit",
          reason: "released by executor",
        })
      ),
    });
    await expect(prepareWarmRun(d)).resolves.toBeUndefined();
    expect(d.isRunnable).not.toHaveBeenCalled();
  });

  it("accepts the run and runs it only after the executor confirms", async () => {
    const d = deps();
    await expect(prepareWarmRun(d)).resolves.toBeDefined();
    expect(d.acknowledge).toHaveBeenCalledWith(assignment, "accept");
  });

  it("does not run when the executor does not confirm the ack", async () => {
    const d = deps({ acknowledge: vi.fn(() => Promise.resolve(false)) });
    await expect(prepareWarmRun(d)).resolves.toBeUndefined();
  });

  it.each([
    ["is not a waiting run of that workflow", () => Promise.resolve(false)],
    ["cannot be checked", () => Promise.reject(new Error("db down"))],
  ])("gives back an assignment that %s", async (_label, isRunnable) => {
    const d = deps({ isRunnable: vi.fn(isRunnable) });
    await expect(prepareWarmRun(d)).resolves.toBeUndefined();
    expect(d.acknowledge).toHaveBeenCalledWith(assignment, "refuse");
    expect(d.acknowledge).not.toHaveBeenCalledWith(assignment, "accept");
  });

  it("retries a transient database error before giving the run back", async () => {
    const isRunnable = vi
      .fn<WarmRunnerDeps["isRunnable"]>()
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce(true);
    const d = deps({ isRunnable });
    await expect(prepareWarmRun(d)).resolves.toBeDefined();
    expect(isRunnable).toHaveBeenCalledTimes(2);
    expect(d.acknowledge).toHaveBeenCalledWith(assignment, "accept");
  });

  it("leaves the run deadline to the Job when none is set", async () => {
    const env = warmEnv();
    delete env.KH_WARM_POOL_RUN_DEADLINE_MS;
    const prepared = await prepareWarmRun(deps({ env }));
    expect(prepared?.runDeadlineMs).toBeUndefined();
  });
});

describe("isRunnableRow", () => {
  it.each([
    ["pending", true],
    ["running", true],
    ["phantom", false],
    ["success", false],
    ["error", false],
    ["system_error", false],
    ["cancelled", false],
  ])("status %s -> %s", (status, expected) => {
    expect(isRunnableRow({ workflowId: "wf-1", status }, "wf-1")).toBe(
      expected
    );
  });

  it("refuses a missing row or one from another workflow", () => {
    expect(isRunnableRow(undefined, "wf-1")).toBe(false);
    expect(
      isRunnableRow({ workflowId: "wf-2", status: "pending" }, "wf-1")
    ).toBe(false);
  });
});

describe("armRunDeadline", () => {
  it("ends the run once the per-run deadline has passed since the claim", () => {
    vi.useFakeTimers();
    try {
      const onExpire = vi.fn();
      armRunDeadline(300_000, onExpire);
      vi.advanceTimersByTime(299_999);
      expect(onExpire).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onExpire).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not keep the process alive on its own", () => {
    const unref = vi.fn();
    armRunDeadline(1000, vi.fn(), () => ({ unref }));
    expect(unref).toHaveBeenCalled();
  });
});
