import { beforeEach, describe, expect, it, vi } from "vitest";
import { TokenBucketPacer } from "../../src/listener/pacer";

describe("TokenBucketPacer", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("lets a lone event through immediately when the bucket is full", async () => {
    const pacer = new TokenBucketPacer(50);
    const started = Date.now();
    await pacer.take();
    // A full bucket holds `capacity` (= drain rate) tokens, so the first take
    // consumes one without waiting.
    expect(Date.now() - started).toBeLessThan(50);
  });

  it("paces a large burst at the drain rate", async () => {
    const drainRate = 100; // tokens/sec -> 10ms per token
    const pacer = new TokenBucketPacer(drainRate);

    // Drain the initial burst (capacity == drainRate) instantly.
    for (let i = 0; i < drainRate; i++) {
      await pacer.take();
    }

    // After the burst, each further take must wait ~1/rate.
    const started = Date.now();
    for (let i = 0; i < 5; i++) {
      await pacer.take();
    }
    const elapsed = Date.now() - started;
    // 5 tokens at 100/s = ~50ms, allow generous timer slack both ways.
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(500);
  });

  it("refills over wall-clock time (idle bucket recovers)", async () => {
    const pacer = new TokenBucketPacer(100); // 1 token per 10ms
    for (let i = 0; i < 100; i++) {
      await pacer.take();
    }

    // Bucket is now empty. Wait ~50ms -> ~5 tokens refilled.
    await new Promise((r) => setTimeout(r, 60));
    const started = Date.now();
    // 5 tokens should be available without waiting.
    for (let i = 0; i < 5; i++) {
      await pacer.take();
    }
    expect(Date.now() - started).toBeLessThan(100);
  });

  it("shares one bucket across consumers on the same chain (contention is global)", async () => {
    const drainRate = 100;
    const pacer = new TokenBucketPacer(drainRate);
    for (let i = 0; i < drainRate; i++) {
      await pacer.take();
    }

    // Two consumers taking concurrently still drain at the shared rate.
    const started = Date.now();
    await Promise.all([
      pacer.take(),
      pacer.take(),
      pacer.take(),
      pacer.take(),
      pacer.take(),
    ]);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(40); // ~5 tokens / 100 per sec
  });

  it("rejects a non-positive drain rate", () => {
    expect(() => new TokenBucketPacer(0)).toThrow(/drainRate/);
    expect(() => new TokenBucketPacer(-5)).toThrow(/drainRate/);
  });

  it("stops pacing once the shutdown signal aborts, releasing a parked take", async () => {
    const controller = new AbortController();
    // 1 token/sec, capacity 1. A slow rate keeps the assertions honest: the
    // single warm-up take cannot refill a meaningful fraction of a token, so
    // the bucket is genuinely empty below and the test cannot pass by
    // accident on a loaded runner.
    const pacer = new TokenBucketPacer(1, 1, controller.signal);
    await pacer.take();

    const parked = pacer.take();
    let settled = false;
    parked.then(() => {
      settled = true;
    });

    // Prove it is actually parked before aborting; otherwise this test would
    // pass whether or not abort does anything.
    await new Promise((r) => setTimeout(r, 100));
    expect(settled).toBe(false);

    const started = Date.now();
    controller.abort();
    await parked;
    expect(settled).toBe(true);
    // Would have been ~1s of remaining pace.
    expect(Date.now() - started).toBeLessThan(200);
  });

  it("keeps letting takes through after abort, so a whole backlog bursts", async () => {
    const controller = new AbortController();
    const pacer = new TokenBucketPacer(1, 1, controller.signal);
    await pacer.take();
    controller.abort();

    // At 1 token/sec these 100 takes would be ~100s of pacing. After abort
    // they cost nothing: the drain that follows pays for the sends, not for
    // the remaining pace. The bound is deliberately loose - two orders of
    // magnitude below the paced cost is proof enough, and a tight floor
    // would only buy flakes on a loaded runner.
    const started = Date.now();
    for (let i = 0; i < 100; i++) {
      await pacer.take();
    }
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
