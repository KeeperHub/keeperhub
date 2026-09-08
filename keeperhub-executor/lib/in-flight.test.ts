import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InFlightTracker } from "./in-flight";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason: unknown) => void;
} {
  let resolve: () => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("InFlightTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("drains immediately when nothing is in flight", async () => {
    await expect(new InFlightTracker().drain(25_000)).resolves.toBe(true);
  });

  it("returns the tracked promise unchanged and forgets it once it settles", async () => {
    const tracker = new InFlightTracker();
    const work = deferred();

    const tracked = tracker.track(work.promise);

    expect(tracked).toBe(work.promise);
    expect(tracker.size).toBe(1);
    work.resolve();
    await tracked;
    expect(tracker.size).toBe(0);
  });

  it("forgets a rejected promise too, without adding a rejection of its own", async () => {
    const tracker = new InFlightTracker();
    const work = deferred();
    const tracked = tracker.track(work.promise);

    work.reject(new Error("boom"));

    await expect(tracked).rejects.toThrow("boom");
    expect(tracker.size).toBe(0);
  });

  it("waits for every in-flight handler and reports a clean drain", async () => {
    const tracker = new InFlightTracker();
    const first = deferred();
    const second = deferred();
    tracker.track(first.promise);
    tracker.track(second.promise);

    const drained = tracker.drain(25_000);
    let outcome: boolean | undefined;
    drained.then((value) => {
      outcome = value;
    });

    first.resolve();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(outcome).toBeUndefined();
    expect(tracker.size).toBe(1);

    second.resolve();
    await expect(drained).resolves.toBe(true);
  });

  it("gives up once the bound elapses while work is still running", async () => {
    const tracker = new InFlightTracker();
    const stuck = deferred();
    tracker.track(stuck.promise);

    const drained = tracker.drain(25_000);
    await vi.advanceTimersByTimeAsync(24_999);
    expect(tracker.size).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(drained).resolves.toBe(false);
    // The handler is still running; the caller exits knowing it was cut off.
    expect(tracker.size).toBe(1);
    stuck.resolve();
  });

  it("also waits for a handler tracked after the drain began", async () => {
    const tracker = new InFlightTracker();
    const first = deferred();
    const late = deferred();
    tracker.track(first.promise);

    const drained = tracker.drain(25_000);
    let outcome: boolean | undefined;
    drained.then((value) => {
      outcome = value;
    });
    tracker.track(late.promise);

    first.resolve();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(outcome).toBeUndefined();

    late.resolve();
    await expect(drained).resolves.toBe(true);
  });
});
