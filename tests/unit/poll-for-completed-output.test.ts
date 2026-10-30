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

  // A duplicate delivery while the first attempt is still executing: the
  // success lands only when that attempt finishes, well past the base window.
  it("keeps polling past timeoutMs while extendWhile holds and returns the late value", async () => {
    const clock = fakeClock();
    const sleep = vi.fn(clock.sleep);
    const fetchFn = vi.fn(() =>
      Promise.resolve(clock.now() >= 13_500 ? { outputRaw: "late" } : null)
    );
    const extendWhile = vi.fn().mockResolvedValue(true);
    const result = await pollForCompletedOutput(fetchFn, {
      timeoutMs: 3000,
      intervalMs: 250,
      extendWhile,
      maxTimeoutMs: 60_000,
      now: clock.now,
      sleep,
    });
    expect(result).toEqual({ outputRaw: "late" });
    expect(clock.now()).toBe(13_500);
    expect(extendWhile).toHaveBeenCalled();
  });

  it("stops at timeoutMs once extendWhile turns false (attempt ended without success)", async () => {
    const clock = fakeClock();
    const sleep = vi.fn(clock.sleep);
    const fetchFn = vi.fn().mockResolvedValue(null);
    const extendWhile = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    const result = await pollForCompletedOutput(fetchFn, {
      timeoutMs: 1000,
      intervalMs: 250,
      extendWhile,
      maxTimeoutMs: 60_000,
      now: clock.now,
      sleep,
    });
    expect(result).toBeNull();
    expect(extendWhile).toHaveBeenCalledTimes(3);
    expect(clock.now()).toBe(1500);
  });

  it("returns a success that commits between the fetch and the in-flight check", async () => {
    const clock = fakeClock();
    const sleep = vi.fn(clock.sleep);
    let committed = false;
    const fetchFn = vi.fn(() =>
      Promise.resolve(committed ? { outputRaw: "raced" } : null)
    );
    const extendWhile = vi.fn(() => {
      if (clock.now() >= 2000) {
        committed = true;
        return Promise.resolve(false);
      }
      return Promise.resolve(true);
    });
    const result = await pollForCompletedOutput(fetchFn, {
      timeoutMs: 1000,
      intervalMs: 250,
      extendWhile,
      maxTimeoutMs: 60_000,
      now: clock.now,
      sleep,
    });
    expect(result).toEqual({ outputRaw: "raced" });
  });

  it("gives up at maxTimeoutMs even while extendWhile still holds", async () => {
    const clock = fakeClock();
    const sleep = vi.fn(clock.sleep);
    const fetchFn = vi.fn().mockResolvedValue(null);
    const extendWhile = vi.fn().mockResolvedValue(true);
    const result = await pollForCompletedOutput(fetchFn, {
      timeoutMs: 1000,
      intervalMs: 250,
      extendWhile,
      maxTimeoutMs: 5000,
      now: clock.now,
      sleep,
    });
    expect(result).toBeNull();
    expect(clock.now()).toBe(5000);
  });

  it("does not extend when maxTimeoutMs is omitted", async () => {
    const clock = fakeClock();
    const sleep = vi.fn(clock.sleep);
    const fetchFn = vi.fn().mockResolvedValue(null);
    const extendWhile = vi.fn().mockResolvedValue(true);
    const result = await pollForCompletedOutput(fetchFn, {
      timeoutMs: 1000,
      intervalMs: 250,
      extendWhile,
      now: clock.now,
      sleep,
    });
    expect(result).toBeNull();
    expect(extendWhile).not.toHaveBeenCalled();
    expect(clock.now()).toBe(1000);
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
