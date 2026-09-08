import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { pollForCompletedOutput } from "@/lib/workflow/executor/poll-for-output";

// A controllable clock + sleep so the poll loop is fully deterministic.
function fakeClock(startMs = 0) {
  let t = startMs;
  return {
    now: () => t,
    // each sleep advances virtual time by exactly ms
    sleep: (ms: number) => {
      t += ms;
      return Promise.resolve();
    },
  };
}

describe("pollForCompletedOutput", () => {
  it("returns the value on the first hit without sleeping", async () => {
    const clock = fakeClock();
    const sleep = vi.fn(clock.sleep);
    const fetchFn = vi.fn().mockResolvedValue({ outputRaw: "v" });
    const result = await pollForCompletedOutput(fetchFn, {
      timeoutMs: 3000,
      intervalMs: 250,
      now: clock.now,
      sleep,
    });
    expect(result).toEqual({ outputRaw: "v" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  // The KEEP-576 race: the recorded success lands a few hundred ms AFTER the
  // spurious throw. A one-shot read misses; the poll must keep checking until
  // the late write appears. Without polling this returns null and the catch
  // nullifies the node -> "produced no data".
  it("recovers a value that appears after several misses (late-landing success)", async () => {
    const clock = fakeClock();
    const sleep = vi.fn(clock.sleep);
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ outputRaw: 998_899 });
    const result = await pollForCompletedOutput(fetchFn, {
      timeoutMs: 3000,
      intervalMs: 250,
      now: clock.now,
      sleep,
    });
    expect(result).toEqual({ outputRaw: 998_899 });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it("returns null once the timeout elapses with no hit (genuine never-records)", async () => {
    const clock = fakeClock();
    const sleep = vi.fn(clock.sleep);
    const fetchFn = vi.fn().mockResolvedValue(null);
    const result = await pollForCompletedOutput(fetchFn, {
      timeoutMs: 1000,
      intervalMs: 250,
      now: clock.now,
      sleep,
    });
    expect(result).toBeNull();
    // 1000ms / 250ms = 4 sleeps before the deadline is reached.
    expect(sleep).toHaveBeenCalledTimes(4);
  });

  it("does exactly one fetch and no sleep when timeoutMs is 0 (one-shot)", async () => {
    const clock = fakeClock();
    const sleep = vi.fn(clock.sleep);
    const fetchFn = vi.fn().mockResolvedValue(null);
    const result = await pollForCompletedOutput(fetchFn, {
      timeoutMs: 0,
      intervalMs: 250,
      now: clock.now,
      sleep,
    });
    expect(result).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
