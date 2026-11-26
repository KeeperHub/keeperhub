import { describe, expect, it, vi } from "vitest";

describe("processSingleton", () => {
  it("returns one value per process across separately loaded module copies", async () => {
    const first = await import("@/lib/rpc/engine/process-singleton");
    vi.resetModules();
    const second = await import("@/lib/rpc/engine/process-singleton");
    expect(second).not.toBe(first);

    const create = vi.fn(() => ({ id: Symbol("shared") }));
    const a = first.processSingleton("test-shared", create);
    const b = second.processSingleton("test-shared", create);

    expect(b).toBe(a);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("keeps different names apart", async () => {
    const { processSingleton } = await import(
      "@/lib/rpc/engine/process-singleton"
    );
    expect(processSingleton("test-a", () => ({}))).not.toBe(
      processSingleton("test-b", () => ({}))
    );
  });
});
