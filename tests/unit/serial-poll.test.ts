import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startSerialPoll } from "@/lib/utils/serial-poll";

describe("startSerialPoll", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits one interval before the first tick and one between ticks", async () => {
    const tick = vi.fn(() => Promise.resolve());
    const stop = startSerialPoll(tick, 1000);

    expect(tick).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(999);
    expect(tick).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(tick).toHaveBeenCalledTimes(2);

    stop();
  });

  it("never overlaps ticks when one outlasts the interval", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const tick = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      inFlight -= 1;
    });
    const stop = startSerialPoll(tick, 1000);

    // setInterval would have fired at 1000, 2000, 3000 and 4000 by now.
    await vi.advanceTimersByTimeAsync(4500);
    expect(tick).toHaveBeenCalledTimes(1);
    // The first tick ends at 4000; the second starts one interval later.
    await vi.advanceTimersByTimeAsync(500);
    expect(tick).toHaveBeenCalledTimes(2);
    expect(maxInFlight).toBe(1);

    stop();
  });

  it("stops scheduling once stopped, including from inside a running tick", async () => {
    const tick = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    const stop = startSerialPoll(tick, 1000);

    await vi.advanceTimersByTimeAsync(1200);
    expect(tick).toHaveBeenCalledTimes(1);
    stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it("stops cleanly before the first tick", async () => {
    const tick = vi.fn(() => Promise.resolve());
    const stop = startSerialPoll(tick, 1000);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(tick).not.toHaveBeenCalled();
  });
});
