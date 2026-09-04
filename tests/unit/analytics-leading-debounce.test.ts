import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLeadingDebounce } from "@/lib/analytics/leading-debounce";

describe("createLeadingDebounce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs the first call at once", () => {
    const task = vi.fn().mockResolvedValue(undefined);
    const debounced = createLeadingDebounce(task, 2000);

    debounced.call();

    // An idle dashboard reacts to one run with no added latency.
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("groups a burst into a single trailing run", async () => {
    const task = vi.fn().mockResolvedValue(undefined);
    const debounced = createLeadingDebounce(task, 2000);

    debounced.call();
    debounced.call();
    debounced.call();
    debounced.call();
    debounced.call();
    expect(task).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2000);
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("runs at once again once the window has passed", async () => {
    const task = vi.fn().mockResolvedValue(undefined);
    const debounced = createLeadingDebounce(task, 2000);

    debounced.call();
    await vi.advanceTimersByTimeAsync(2000);

    debounced.call();
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("cancel drops a booked trailing run", async () => {
    const task = vi.fn().mockResolvedValue(undefined);
    const debounced = createLeadingDebounce(task, 2000);

    debounced.call();
    debounced.call();
    debounced.cancel();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("keeps grouping after a rejected run", async () => {
    const task = vi.fn().mockRejectedValue(new Error("boom"));
    const debounced = createLeadingDebounce(task, 2000);

    debounced.call();
    debounced.call();
    await vi.advanceTimersByTimeAsync(2000);

    expect(task).toHaveBeenCalledTimes(2);
  });
});
