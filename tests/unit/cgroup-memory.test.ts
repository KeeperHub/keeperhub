import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { readFileSync } = vi.hoisted(() => ({ readFileSync: vi.fn() }));
vi.mock("node:fs", () => ({ readFileSync }));

import {
  readCgroupMemory,
  readCgroupOomKills,
} from "@/lib/metrics/cgroup-memory";

/**
 * Values copied from a live prod pod on 2026-08-12, so the parser is exercised
 * against the exact bytes the kernel writes rather than an invented shape.
 */
const PROD = {
  "memory.current": "980123648\n",
  "memory.peak": "3347591168\n",
  "memory.max": "4294967296\n",
  "memory.events":
    "low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\noom_group_kill 0\n",
};

function serve(files: Record<string, string | Error>): void {
  readFileSync.mockImplementation((path: string) => {
    const key = path.replace("/sys/fs/cgroup/", "");
    const value = files[key];
    if (value === undefined) {
      throw new Error(`ENOENT: ${path}`);
    }
    if (value instanceof Error) {
      throw value;
    }
    return value;
  });
}

describe("cgroup v2 memory reader", () => {
  beforeEach(() => {
    readFileSync.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses the values a live prod container reports", () => {
    serve(PROD);

    expect(readCgroupMemory()).toEqual({
      current: 980_123_648,
      peak: 3_347_591_168,
      limit: 4_294_967_296,
    });
  });

  it("reads the oom_kill counter out of memory.events", () => {
    serve({ ...PROD, "memory.events": "low 0\nmax 3\noom 2\noom_kill 1\n" });

    expect(readCgroupOomKills()).toBe(1);
  });

  it("does not confuse oom_group_kill for oom_kill", () => {
    serve({
      ...PROD,
      "memory.events": "oom 5\noom_kill 2\noom_group_kill 9\n",
    });

    expect(readCgroupOomKills()).toBe(2);
  });

  it("treats an unlimited cgroup as no limit rather than a number", () => {
    serve({ ...PROD, "memory.max": "max\n" });

    expect(readCgroupMemory()?.limit).toBeNull();
  });

  it("returns null off-cluster, where the files do not exist", () => {
    serve({});

    expect(readCgroupMemory()).toBeNull();
    expect(readCgroupOomKills()).toBeNull();
  });

  it("survives a cgroup v1 host, which has no memory.current", () => {
    serve({ "memory.limit_in_bytes": "4294967296\n" });

    expect(readCgroupMemory()).toBeNull();
  });

  it("degrades to null on an unreadable or garbage file rather than throwing", () => {
    serve({ "memory.current": "not-a-number\n" });
    expect(readCgroupMemory()).toBeNull();

    serve({ "memory.current": new Error("EACCES") });
    expect(() => readCgroupMemory()).not.toThrow();
    expect(readCgroupMemory()).toBeNull();
  });

  it("reports a present peak of zero rather than dropping it", () => {
    serve({ ...PROD, "memory.current": "0\n", "memory.peak": "0\n" });

    expect(readCgroupMemory()).toEqual({
      current: 0,
      peak: 0,
      limit: 4_294_967_296,
    });
  });
});
