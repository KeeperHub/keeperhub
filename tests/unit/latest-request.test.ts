import { describe, expect, it } from "vitest";
import { createLatestRequest } from "@/lib/latest-request";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createLatestRequest", () => {
  it("drops an older reply that lands after a newer one", async () => {
    const run = createLatestRequest();
    const older = deferred<string>();
    const newer = deferred<string>();
    const first = run(() => older.promise);
    const second = run(() => newer.promise);
    newer.resolve("new");
    older.resolve("old");
    expect(await second).toEqual({ latest: true, ok: true, value: "new" });
    expect(await first).toEqual({ latest: false });
  });

  it("reports a failure of the latest request instead of throwing", async () => {
    const run = createLatestRequest();
    expect(await run(() => Promise.reject(new Error("offline")))).toEqual({
      latest: true,
      ok: false,
    });
  });

  it("drops an older failure too", async () => {
    const run = createLatestRequest();
    const older = deferred<string>();
    const first = run(() => older.promise);
    const second = run(() => Promise.resolve("new"));
    older.reject(new Error("offline"));
    expect(await first).toEqual({ latest: false });
    expect(await second).toEqual({ latest: true, ok: true, value: "new" });
  });
});
