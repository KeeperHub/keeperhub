import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { waitForBrowserReady } from "@/scripts/lib/dev-login-browser-process";

type FakeChild = ChildProcess & {
  stderr: PassThrough;
  unref: ReturnType<typeof vi.fn>;
};

function createChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  Object.assign(child, {
    stderr: new PassThrough(),
    unref: vi.fn(),
  });
  return child;
}

describe("waitForBrowserReady", () => {
  it("does not report success until the browser child sends ready", async () => {
    const child = createChild();
    let resolved = false;
    const ready = waitForBrowserReady(child, 1000).then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    child.emit("message", { type: "browser-ready" });
    await ready;
    expect(resolved).toBe(true);
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("surfaces Playwright launch errors with the recovery commands", async () => {
    const child = createChild();
    const ready = waitForBrowserReady(child, 1000);

    child.emit("message", {
      message: "Executable doesn't exist",
      type: "browser-error",
    });

    await expect(ready).rejects.toThrowError(
      /Executable doesn't exist[\s\S]*pnpm exec playwright install chromium[\s\S]*pnpm dev:login/
    );
  });

  it("includes loader stderr when the browser child exits before ready", async () => {
    const child = createChild();
    const ready = waitForBrowserReady(child, 1000);
    child.stderr?.write("tsx loader failed");

    child.emit("exit", 1, null);

    await expect(ready).rejects.toThrowError("tsx loader failed");
  });

  it("reports a startup timeout instead of claiming the browser opened", async () => {
    const child = createChild();

    await expect(waitForBrowserReady(child, 5)).rejects.toThrowError(
      /startup timed out[\s\S]*playwright install chromium/
    );
  });
});
