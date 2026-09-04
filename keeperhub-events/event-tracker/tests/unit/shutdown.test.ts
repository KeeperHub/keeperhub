import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { abortableSleep } from "../../src/listener/shutdown";

describe("abortableSleep", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sleeps the full interval when nothing aborts", async () => {
    let settled = false;
    const sleep = abortableSleep(5_000).then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await sleep;
    expect(settled).toBe(true);
  });

  it("returns immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await abortableSleep(10_000, controller.signal);
    // Nothing was scheduled, so the sleep cannot be holding a timer open.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns early when the signal aborts mid-sleep, and clears its timer", async () => {
    const controller = new AbortController();
    let settled = false;
    const sleep = abortableSleep(10_000, controller.signal).then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(false);

    controller.abort();
    await sleep;
    expect(settled).toBe(true);
    // The pending timer is cleared rather than left to fire into a resolved
    // promise and hold the event loop open past the drain.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves rather than rejecting on abort, so callers need no abort branch", async () => {
    const controller = new AbortController();
    const sleep = abortableSleep(10_000, controller.signal);
    controller.abort();
    await expect(sleep).resolves.toBeUndefined();
  });
});
