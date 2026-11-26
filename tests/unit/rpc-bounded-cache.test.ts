import { describe, expect, it } from "vitest";
import { BoundedCache } from "@/lib/rpc/providers/bounded-cache";

describe("BoundedCache", () => {
  it("drops the least recently used entry past its limit", () => {
    const cache = new BoundedCache<number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a");
    cache.set("c", 3);

    expect(cache.size).toBe(2);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
  });

  it("refreshes a key that is written again instead of growing", () => {
    const cache = new BoundedCache<number>(2);
    cache.set("a", 1);
    cache.set("a", 2);

    expect(cache.size).toBe(1);
    expect(cache.get("a")).toBe(2);
  });
});
