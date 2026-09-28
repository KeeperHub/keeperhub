import { describe, expect, it, vi } from "vitest";

/**
 * discoverProtocols() used to return [] whenever nothing survived its
 * filter, whether the directory held zero entries or twenty-four files that
 * all failed to match. The generator then wrote an empty registry over a
 * real one and exited 0. These tests pin the split: a directory with no
 * entries is a legitimate zero, a directory with entries that all get
 * filtered out is an error.
 *
 * existsSync/readdirSync are mocked rather than pointed at a real directory,
 * so the case is driven by dependency injection instead of disk fixtures.
 */

const { mockExistsSync, mockReaddirSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn<(path: string) => boolean>(),
  mockReaddirSync: vi.fn<(path: string) => string[]>(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (path: string) => mockExistsSync(path),
    readdirSync: (path: string) => mockReaddirSync(path),
  };
});

const { discoverProtocols } = await import("../../scripts/discover-plugins");

describe("discoverProtocols", () => {
  it("returns nothing when the directory does not exist", () => {
    mockExistsSync.mockReturnValue(false);
    mockReaddirSync.mockReturnValue([]);

    expect(discoverProtocols()).toEqual([]);
    expect(mockReaddirSync).not.toHaveBeenCalled();
  });

  it("returns nothing when the directory exists but is genuinely empty", () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([]);

    expect(discoverProtocols()).toEqual([]);
  });

  it("throws when the directory has entries but none is a protocol file", () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([
      "index.ts",
      "_shared.ts",
      ".hidden.ts",
      "types.d.ts",
      "README.md",
    ]);

    expect(() => discoverProtocols()).toThrow(/protocols\//);
  });

  it("returns the matching files when the directory has a real mix", () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(["index.ts", "aave-v3.ts", "lido.ts"]);

    const result = discoverProtocols();

    expect(result).toHaveLength(2);
    expect(result.every((f) => f.endsWith(".ts"))).toBe(true);
  });
});
