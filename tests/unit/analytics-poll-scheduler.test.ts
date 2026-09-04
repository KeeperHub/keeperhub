import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPollScheduler } from "@/lib/analytics/poll-scheduler";

describe("createPollScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits one interval before the first run", async () => {
    const task = vi.fn().mockResolvedValue(undefined);
    const scheduler = createPollScheduler(task, 1000);
    scheduler.start();

    expect(task).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(task).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it("rearms after each run settles", async () => {
    const task = vi.fn().mockResolvedValue(undefined);
    const scheduler = createPollScheduler(task, 1000);
    scheduler.start();

    await vi.advanceTimersByTimeAsync(3000);
    expect(task).toHaveBeenCalledTimes(3);
    scheduler.stop();
  });

  it("keeps one run in flight when the task outlasts the interval", async () => {
    let inFlight = 0;
    let peak = 0;
    const task = vi.fn(async (): Promise<void> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 5000);
      });
      inFlight -= 1;
    });
    const scheduler = createPollScheduler(task, 1000);
    scheduler.start();

    await vi.advanceTimersByTimeAsync(30_000);

    // setInterval would have started 30 passes and stacked 5 of them at once.
    expect(peak).toBe(1);
    expect(task.mock.calls.length).toBeLessThanOrEqual(5);
    scheduler.stop();
  });

  it("stops rearming after stop", async () => {
    const task = vi.fn().mockResolvedValue(undefined);
    const scheduler = createPollScheduler(task, 1000);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(task).toHaveBeenCalledTimes(1);

    scheduler.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("keeps polling after a rejected run", async () => {
    const task = vi.fn().mockRejectedValue(new Error("boom"));
    const scheduler = createPollScheduler(task, 1000);
    scheduler.start();

    await vi.advanceTimersByTimeAsync(3000);
    expect(task.mock.calls.length).toBeGreaterThan(1);
    scheduler.stop();
  });

  it("does not stack passes when start is called twice", async () => {
    const task = vi.fn().mockResolvedValue(undefined);
    const scheduler = createPollScheduler(task, 1000);
    scheduler.start();
    scheduler.start();

    await vi.advanceTimersByTimeAsync(1000);
    expect(task).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });
});
