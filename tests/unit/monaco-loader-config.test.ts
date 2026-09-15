import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ configure: vi.fn(), importMonaco: vi.fn() }));

vi.mock("@monaco-editor/react", () => ({
  loader: { config: calls.configure },
}));
vi.mock("monaco-editor", () => {
  calls.importMonaco();
  return { editor: {} };
});

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

describe("on-demand Monaco setup", () => {
  it("does not load the editor during a server render", async () => {
    const { configureMonaco } = await import("@/lib/monaco-loader-config");
    await configureMonaco();
    expect(calls.importMonaco).not.toHaveBeenCalled();
    expect(calls.configure).not.toHaveBeenCalled();
  });

  it("waits for an explicit request and shares setup between concurrent editors", async () => {
    vi.stubGlobal("window", {});
    const { configureMonaco } = await import("@/lib/monaco-loader-config");
    expect(calls.importMonaco).not.toHaveBeenCalled();
    expect(calls.configure).not.toHaveBeenCalled();
    const first = configureMonaco();
    const second = configureMonaco();
    expect(first).toBe(second);
    expect(calls.configure).not.toHaveBeenCalled();
    await Promise.all([first, second]);
    expect(calls.importMonaco).toHaveBeenCalledTimes(1);
    expect(calls.configure).toHaveBeenCalledWith({
      monaco: expect.objectContaining({ editor: {} }),
    });
    await configureMonaco();
    expect(calls.configure).toHaveBeenCalledTimes(1);
  });

  it("reports setup failure and allows a later attempt", async () => {
    vi.stubGlobal("window", {});
    calls.configure.mockImplementationOnce(() => {
      throw new Error("setup failed");
    });
    const { configureMonaco } = await import("@/lib/monaco-loader-config");
    await expect(configureMonaco()).rejects.toThrow("setup failed");
    await expect(configureMonaco()).resolves.toBeUndefined();
    expect(calls.configure).toHaveBeenCalledTimes(2);
  });
});
