import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockGetRedis } = vi.hoisted(() => ({ mockGetRedis: vi.fn() }));

vi.mock("@/lib/redis", () => ({ getRedis: mockGetRedis }));

import { cachedRead } from "@/lib/redis-cache";

function args(read: () => Promise<bigint>) {
  return {
    key: "prod:gas-balance:1:0xabc",
    ttlSeconds: 10,
    decode: BigInt,
    encode: String,
    read,
  };
}

describe("cachedRead", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls the source of truth when no Redis is configured", async () => {
    mockGetRedis.mockReturnValue(null);
    const read = vi.fn(() => Promise.resolve(BigInt(7)));

    expect(await cachedRead(args(read))).toBe(BigInt(7));
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("returns the decoded hit without calling the source of truth", async () => {
    mockGetRedis.mockReturnValue({
      get: () => Promise.resolve("42"),
      set: vi.fn(),
    });
    const read = vi.fn(() => Promise.resolve(BigInt(7)));

    expect(await cachedRead(args(read))).toBe(BigInt(42));
    expect(read).not.toHaveBeenCalled();
  });

  it("populates the cache on a miss", async () => {
    const set = vi.fn(() => Promise.resolve("OK"));
    mockGetRedis.mockReturnValue({ get: () => Promise.resolve(null), set });
    const read = vi.fn(() => Promise.resolve(BigInt(7)));

    expect(await cachedRead(args(read))).toBe(BigInt(7));
    expect(set).toHaveBeenCalledWith("prod:gas-balance:1:0xabc", "7", "EX", 10);
  });

  it("treats an unparseable cached value as a miss", async () => {
    mockGetRedis.mockReturnValue({
      get: () => Promise.resolve("not-a-number"),
      set: vi.fn(),
    });
    const read = vi.fn(() => Promise.resolve(BigInt(7)));

    expect(await cachedRead(args(read))).toBe(BigInt(7));
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("falls through when the read throws", async () => {
    mockGetRedis.mockReturnValue({
      get: () => Promise.reject(new Error("redis down")),
      set: vi.fn(),
    });
    const read = vi.fn(() => Promise.resolve(BigInt(7)));

    expect(await cachedRead(args(read))).toBe(BigInt(7));
  });

  it("still returns the value when the cache write fails", async () => {
    mockGetRedis.mockReturnValue({
      get: () => Promise.resolve(null),
      set: () => Promise.reject(new Error("redis down")),
    });
    const read = vi.fn(() => Promise.resolve(BigInt(7)));

    expect(await cachedRead(args(read))).toBe(BigInt(7));
  });
});
