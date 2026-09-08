import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// cache.ts is a server-only module; stub the marker so it can be imported
// under vitest (the package throws when resolved outside a Server Component).
vi.mock("server-only", () => ({}));

import {
  __resetAnalyticsCacheForTest,
  analyticsCacheKey,
  cachedAnalytics,
} from "@/lib/analytics/cache";

describe("cachedAnalytics", () => {
  let current = 0;
  let nowSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    current = 0;
    nowSpy = vi.spyOn(performance, "now").mockImplementation(() => current);
    delete process.env.ANALYTICS_CACHE_TTL_MS;
    __resetAnalyticsCacheForTest();
  });

  afterEach(() => {
    nowSpy.mockRestore();
    delete process.env.ANALYTICS_CACHE_TTL_MS;
  });

  it("runs the loader once and serves the cached value within the TTL", async () => {
    const loader = vi.fn(() => Promise.resolve("v1"));

    const first = await cachedAnalytics("k", loader);
    current = 29_999; // < 30s default, measured from completion (t=0)
    const second = await cachedAnalytics("k", loader);

    expect(first).toBe("v1");
    expect(second).toBe("v1");
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("recomputes once the TTL has elapsed since completion", async () => {
    let n = 0;
    const loader = vi.fn(() => {
      n += 1;
      return Promise.resolve(`v${n}`);
    });

    const first = await cachedAnalytics("k", loader);
    current = 30_001; // past the 30s default
    const second = await cachedAnalytics("k", loader);

    expect(first).toBe("v1");
    expect(second).toBe("v2");
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("shares a single in-flight refresh between concurrent callers", async () => {
    let resolve: ((v: string) => void) | undefined;
    const loader = vi.fn(
      () =>
        new Promise<string>((r) => {
          resolve = r;
        })
    );

    const p1 = cachedAnalytics("k", loader);
    const p2 = cachedAnalytics("k", loader);

    expect(loader).toHaveBeenCalledTimes(1);

    resolve?.("done");

    expect(await p1).toBe("done");
    expect(await p2).toBe("done");
  });

  it("does not cache failures - the next caller retries", async () => {
    const loader = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce("ok");

    await expect(cachedAnalytics("k", loader)).rejects.toThrow("boom");
    const retried = await cachedAnalytics("k", loader);

    expect(retried).toBe("ok");
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("recomputes on every call when the TTL is disabled (0)", async () => {
    process.env.ANALYTICS_CACHE_TTL_MS = "0";
    const loader = vi.fn(() => Promise.resolve("v"));

    await cachedAnalytics("k", loader);
    await cachedAnalytics("k", loader);

    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("isolates entries by key", async () => {
    const loader = vi.fn(() => Promise.resolve("v"));

    await cachedAnalytics("a", loader);
    await cachedAnalytics("b", loader);

    expect(loader).toHaveBeenCalledTimes(2);
  });
});

describe("analyticsCacheKey", () => {
  it("collapses undefined parts to a stable string", () => {
    expect(
      analyticsCacheKey("summary", [
        "org1",
        "7d",
        undefined,
        undefined,
        undefined,
      ])
    ).toBe("summary|org1|7d|||");
  });

  it("distinguishes present optional filters", () => {
    expect(
      analyticsCacheKey("summary", ["org1", "custom", "proj1", "s", "e"])
    ).toBe("summary|org1|custom|proj1|s|e");
  });
});
